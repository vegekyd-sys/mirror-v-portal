#!/usr/bin/env python3
"""
dc_resend_source.py — Resend 官方 API 直连 source（P0-E3C.1c）

只读 Resend API 拉取收件（GET /emails/receiving）与发件状态（GET /emails）。
转成统一 ingest event 后调 dc_email_ingest.ingest_resend_event。

稳定事件 ID：
  inbound: resend-poll:received:<received_email_id>
  status : resend-poll:status:<resend_id>:<last_event>

Cursor: DC_DATA_DIR/resend-poller/received-cursor.md（只 durable 成功后前移）
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import urllib3

DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
POLLER_DIR = DATA_DIR / "resend-poller"
CURSOR_FILE = POLLER_DIR / "received-cursor.md"
CURSOR_HEADER = "# DealClaw Resend Received Cursor"
STATUS_CURSOR_FILE = POLLER_DIR / "status-cursor.md"
STATUS_CURSOR_HEADER = "# DealClaw Resend Status Cursor"

API = "https://api.resend.com"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _key() -> str:
    for f in [Path(__file__).resolve().parent / ".env",
              Path(__file__).resolve().parent.parent / ".env"]:
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("RESEND_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.getenv("RESEND_API_KEY", "")


def _http():
    return urllib3.PoolManager(timeout=urllib3.Timeout(connect=10, read=20))


def _get(path: str):
    r = _http().request("GET", API + path, headers={
        "Authorization": f"Bearer {_key()}", "User-Agent": "DealClaw/1.0", "Accept": "application/json"})
    try:
        return r.status, json.loads(r.data.decode("utf-8"))
    except Exception:
        return r.status, {"raw": r.data[:200].decode("utf-8", "replace")}


def list_received(limit: int = 50, after: str = None):
    q = f"limit={limit}"
    if after:
        q += f"&after={after}"
    st, d = _get(f"/emails/receiving?{q}")
    return (st, d) if st == 200 else (st, {"error": d})


def list_sent(limit: int = 50, after: str = None):
    q = f"limit={limit}"
    if after:
        q += f"&after={after}"
    st, d = _get(f"/emails?{q}")
    return (st, d) if st == 200 else (st, {"error": d})


def get_sent(email_id: str):
    st, d = _get(f"/emails/{email_id}")
    return (st, d) if st == 200 else (st, {"error": d})


def to_ingest_event(received: dict) -> dict:
    """把 received 列表条目转成统一 ingest event（正文由 handle_inbound_event 内调 Receiving API 获取）。"""
    return {
        "svix_id": f"resend-poll:received:{received.get('id')}",
        "event_type": "email.received",
        "received_at": received.get("created_at"),
        "payload": {
            "email_id": received.get("id"),
            "from": received.get("from"),
            "to": received.get("to"),
            "subject": received.get("subject"),
        },
    }


def to_status_event(sent: dict) -> dict:
    """把 sent 条目转成 status ingest event。"""
    return {
        "svix_id": f"resend-poll:status:{sent.get('id')}:{sent.get('last_event')}",
        "event_type": f"email.{sent.get('last_event')}" if sent.get("last_event") else "email.sent",
        "received_at": sent.get("created_at"),
        "payload": {"email_id": sent.get("id"), "message_id": sent.get("message_id", "")},
    }


def load_cursor() -> dict:
    if not CURSOR_FILE.exists():
        return {"high_water_received_id": None, "high_water_created_at": None, "recent_processed_ids": []}
    for line in CURSOR_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            d = json.loads(line)
            return {"high_water_received_id": d.get("high_water_received_id"),
                    "high_water_created_at": d.get("high_water_created_at"),
                    "recent_processed_ids": d.get("recent_processed_ids", [])}
        except json.JSONDecodeError:
            continue
    return {"high_water_received_id": None, "high_water_created_at": None, "recent_processed_ids": []}


def save_cursor(high_water_received_id, high_water_created_at, recent_processed_ids) -> None:
    POLLER_DIR.mkdir(parents=True, exist_ok=True)
    content = CURSOR_HEADER + "\n\n" + json.dumps({
        "high_water_received_id": high_water_received_id,
        "high_water_created_at": high_water_created_at,
        "recent_processed_ids": recent_processed_ids,
        "updated_at": _now()}, ensure_ascii=False) + "\n"
    tmp = CURSOR_FILE.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(CURSOR_FILE)


def poll_received_once(limit: int = 50, enabled_after: str = None, max_pages: int = 20) -> dict:
    """倒序增量（新在前）：从第一页开始，记录 new_high_water，遇 previous_high_water 停止。

    只 durable 成功后才推进 high_water；retryable 失败不前移。
    """
    from .dc_email_ingest import ingest_resend_event
    cur = load_cursor()
    prev_hw = cur.get("high_water_received_id")
    processed = set(cur.get("recent_processed_ids", []))
    results = []
    new_hw_id = None
    new_hw_created = None
    page = 0
    after = None
    hit_hw = False

    while page < max_pages:
        st, d = list_received(limit=limit, after=after)
        if st != 200:
            return {"ok": False, "error": "list failed", "status": st, "cursor_gap": True}
        data = d.get("data", [])
        if not data:
            break
        if page == 0 and new_hw_id is None:
            new_hw_id = data[0].get("id")
            new_hw_created = data[0].get("created_at")
        for item in data:
            rid = item.get("id")
            if rid == prev_hw:
                hit_hw = True
                break  # 遇到 previous high-water，停止
            if rid in processed:
                continue
            if enabled_after and (item.get("created_at") or "") < enabled_after:
                continue
            r = ingest_resend_event(to_ingest_event(item))
            if r.get("ok") or r.get("duplicate_fact") or r.get("in_progress"):
                results.append({"received_id": rid, "status": "ingested" if r.get("ok") else "duplicate"})
                processed.add(rid)
            else:
                # retryable 失败 → 不前移
                results.append({"received_id": rid, "status": "retryable"})
                return {"ok": True, "results": results, "high_water_received_id": prev_hw,
                        "advanced": False, "has_more": d.get("has_more", False)}
        if hit_hw or not d.get("has_more", False):
            break
        after = data[-1].get("id")
        page += 1

    if page >= max_pages and not hit_hw and d.get("has_more"):
        # 达到最大页数仍未找到 high-water → cursor_gap
        return {"ok": False, "cursor_gap": True, "error": "high_water not found within max_pages",
                "results": results, "advanced": False}

    if new_hw_id:
        recent = list(processed)[-200:]
        save_cursor(new_hw_id, new_hw_created, recent)
    return {"ok": True, "results": results, "high_water_received_id": new_hw_id or prev_hw,
            "advanced": new_hw_id is not None, "has_more": d.get("has_more", False) if data else False}


def load_status_cursor() -> dict:
    if not STATUS_CURSOR_FILE.exists():
        return {"high_water_sent_id": None, "recent_processed_ids": []}
    for line in STATUS_CURSOR_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            d = json.loads(line)
            return {"high_water_sent_id": d.get("high_water_sent_id"),
                    "recent_processed_ids": d.get("recent_processed_ids", [])}
        except json.JSONDecodeError:
            continue
    return {"high_water_sent_id": None, "recent_processed_ids": []}


def save_status_cursor(high_water_sent_id, recent_processed_ids) -> None:
    POLLER_DIR.mkdir(parents=True, exist_ok=True)
    content = STATUS_CURSOR_HEADER + "\n\n" + json.dumps({
        "high_water_sent_id": high_water_sent_id,
        "recent_processed_ids": recent_processed_ids,
        "updated_at": _now()}, ensure_ascii=False) + "\n"
    tmp = STATUS_CURSOR_FILE.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(STATUS_CURSOR_FILE)


def poll_status_once(limit: int = 100, max_pages: int = 3) -> dict:
    """拉最近发件状态，生成 delivery 信号（delivered/bounced/complained/failed）。

    不严格 high_water 前移：每次拉最近 limit 封（最多 max_pages 页），用
    `<resend_id>:<last_event>` 去重，以捕获 sent→delivered/bounced 的状态演进
    （退信检测需要终态）。sent/opened/clicked 不生成信号，跳过 ingest。
    """
    from .dc_email_ingest import ingest_resend_event
    SIGNAL_EVENTS = {"delivered", "bounced", "complained", "failed"}
    cur = load_status_cursor()
    processed = set(cur.get("recent_processed_ids", []))
    results = []
    data = []
    after = None

    for _ in range(max_pages):
        st, d = list_sent(limit=limit, after=after)
        if st != 200:
            return {"ok": False, "error": "list failed", "status": st}
        page_data = d.get("data", [])
        if not page_data:
            break
        data.extend(page_data)
        if not d.get("has_more", False):
            break
        after = page_data[-1].get("id")

    new_hw_id = data[0].get("id") if data else None

    for item in data:
        sid = item.get("id")
        last_event = item.get("last_event") or "sent"
        dedupe_key = f"{sid}:{last_event}"
        if dedupe_key in processed:
            continue
        processed.add(dedupe_key)
        if last_event not in SIGNAL_EVENTS:
            continue
        ev = to_status_event(item)
        r = ingest_resend_event(ev)
        if r.get("ok") or r.get("duplicate_fact") or r.get("in_progress"):
            results.append({"sent_id": sid, "event": ev["event_type"],
                            "status": "ingested" if r.get("ok") else "duplicate"})
        else:
            results.append({"sent_id": sid, "event": ev["event_type"], "status": "retryable"})

    recent = list(processed)[-500:]
    save_status_cursor(new_hw_id or cur.get("high_water_sent_id"), recent)
    return {"ok": True, "results": results, "advanced": new_hw_id is not None,
            "has_more": bool(data)}


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "list":
        st, d = list_received(limit=10)
        print(json.dumps({"status": st, "count": len(d.get("data", [])) if isinstance(d, dict) else 0,
                          "has_more": d.get("has_more") if isinstance(d, dict) else None}, ensure_ascii=False))
    elif len(sys.argv) > 1 and sys.argv[1] == "status":
        print(json.dumps(poll_status_once(), ensure_ascii=False, indent=2))
    else:
        print(json.dumps({"received": poll_received_once(), "status": poll_status_once()},
                         ensure_ascii=False, indent=2))
