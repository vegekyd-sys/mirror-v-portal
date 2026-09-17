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
import time
from datetime import datetime, timezone
from pathlib import Path

import urllib3

DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
POLLER_DIR = DATA_DIR / "resend-poller"
CURSOR_FILE = POLLER_DIR / "received-cursor.md"
CURSOR_HEADER = "# DealClaw Resend Received Cursor"
STATUS_CURSOR_FILE = POLLER_DIR / "status-cursor.md"
STATUS_CURSOR_HEADER = "# DealClaw Resend Status Cursor"
# 翻页断点（2026-09-17）：一屏装不下的新信下轮从断点接着往回翻，而不是报 cursor_gap 卡死
SCAN_FILE = POLLER_DIR / "received-scan.json"

# 本轮墙钟预算默认 120s：cron job 超时是 240s，取一半余量，到点收手保住"已做的活"。
# ``DC_RESEND_POLL_TIMEOUT_SECONDS`` 可调（0 = 不限）。
DEFAULT_TIMEOUT_SECONDS = 120.0
# 一次积压扫描最多累计翻多少页；超过就认输报 cursor_gap（游标可能真丢了），不无限往回挖
DEFAULT_SCAN_MAX_PAGES = 40

_clock = time.monotonic


class _Budget:
    """一轮取信的墙钟预算（时钟可注入，便于测试把"超时"跑出来）。"""

    def __init__(self, seconds: float | None = None, *, clock=None):
        self.clock = clock or _clock
        if seconds is None:
            seconds = _timeout_from_env()
        try:
            seconds = float(seconds)
        except (TypeError, ValueError):
            seconds = DEFAULT_TIMEOUT_SECONDS
        self.deadline = None if seconds <= 0 else self.clock() + seconds

    def expired(self) -> bool:
        return self.deadline is not None and self.clock() >= self.deadline


def _timeout_from_env() -> float:
    raw = str(os.getenv("DC_RESEND_POLL_TIMEOUT_SECONDS", "") or "").strip()
    try:
        return float(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS


def load_scan() -> dict:
    try:
        if SCAN_FILE.exists():
            data = json.loads(SCAN_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}
    return {}


def save_scan(state: dict) -> None:
    POLLER_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SCAN_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state or {}, ensure_ascii=False), encoding="utf-8")
    tmp.replace(SCAN_FILE)


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
    payload = {"email_id": sent.get("id"), "message_id": sent.get("message_id", "")}
    # 列表接口不含 bounce 详情，但若调用方已补进 sent（见 poll_status_once）则透传
    if isinstance(sent.get("bounce"), dict):
        payload["bounce"] = sent["bounce"]
    return {
        "svix_id": f"resend-poll:status:{sent.get('id')}:{sent.get('last_event')}",
        "event_type": f"email.{sent.get('last_event')}" if sent.get("last_event") else "email.sent",
        "received_at": sent.get("created_at"),
        "payload": payload,
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


def poll_received_once(limit: int = 50, enabled_after: str = None, max_pages: int = 20,
                       timeout_seconds: float | None = None) -> dict:
    """倒序增量（新在前）：从第一页开始，记录 new_high_water，遇 previous_high_water 停止。

    只 durable 成功后才推进 high_water；retryable 失败不前移。

    **墙钟预算 + 断点（2026-09-17）**：

    * 预算（默认 120s / ``DC_RESEND_POLL_TIMEOUT_SECONDS``，0 = 不限）到点就收手，返回
      ``stopped_reason="deadline"``；**每处理完一封就落一次处理进度**（高水位不动），
      下一轮从顶部重走但会跳过已处理的，不重做也不丢。
    * 新信多到 ``max_pages`` 一屏装不下时，**不再直接报 cursor_gap 卡死**：把翻页断点写进
      ``received-scan.json``，下一轮从断点继续往回翻；累计翻超 ``DC_RESEND_SCAN_MAX_PAGES``（默认 40）
      仍未找到游标才认输报 cursor_gap（那种情况游标大概是真丢了）。
    """
    from .dc_email_ingest import ingest_resend_event
    cur = load_cursor()
    prev_hw = cur.get("high_water_received_id")
    prev_hw_created = cur.get("high_water_created_at")
    processed = set(cur.get("recent_processed_ids", []))
    scan = load_scan()
    resume_after = str(scan.get("resume_after") or "")
    scan_newest = str(scan.get("resume_newest") or "")
    pages_done = int(scan.get("pages_done") or 0)
    budget = _Budget(timeout_seconds)
    max_scan_pages = int(os.getenv("DC_RESEND_SCAN_MAX_PAGES", "") or DEFAULT_SCAN_MAX_PAGES)

    results = []
    new_hw_id = None
    new_hw_created = None
    page = 0
    after = resume_after or None
    hit_hw = False
    exhausted = False
    stopped = "complete"

    while page < max_pages:
        if budget.expired():
            stopped = "deadline"
            break
        st, d = list_received(limit=limit, after=after)
        if st != 200:
            return {"ok": False, "error": "list failed", "status": st, "results": results,
                    "high_water_received_id": prev_hw, "advanced": False}
        data = d.get("data", [])
        if not data:
            exhausted = True
            break
        pages_done += 1
        if not scan_newest:
            scan_newest = str(data[0].get("id") or "")   # 本轮窗口最顶端 = 扫完后的高水位
        if page == 0 and not resume_after:
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
            if budget.expired():
                stopped = "deadline"
                break
            r = ingest_resend_event(to_ingest_event(item))
            if r.get("ok") or r.get("duplicate_fact") or r.get("in_progress"):
                results.append({"received_id": rid, "status": "ingested" if r.get("ok") else "duplicate"})
                processed.add(rid)
                # 断点：每处理一封就落一次进度；高水位不动（没扫到锚点前绝不假装已看完）
                save_cursor(prev_hw, prev_hw_created, sorted(processed)[-200:])
            else:
                # retryable 失败 → 不前移
                results.append({"received_id": rid, "status": "retryable"})
                stopped = "retryable"
                break
        if stopped in ("deadline", "retryable"):
            break
        if hit_hw or not d.get("has_more", False):
            exhausted = True
            break
        after = data[-1].get("id")
        page += 1

    has_more_raw = bool(d.get("has_more", False)) if data else False

    if stopped in ("deadline", "retryable"):
        # 半途收手：处理进度已在上面逐封落盘；翻页断点保持原样，下一轮重取同一窗口续做
        return {"ok": True, "results": results, "high_water_received_id": prev_hw,
                "advanced": False, "has_more": has_more_raw, "partial": True,
                "stopped_reason": stopped}

    if not exhausted:
        # 页数用尽但还没翻到游标
        if pages_done >= max_scan_pages:
            save_scan({})
            return {"ok": False, "cursor_gap": True,
                    "error": "high_water not found within max_scan_pages",
                    "results": results, "advanced": False}
        save_scan({"resume_after": after or "", "resume_newest": scan_newest,
                   "pages_done": pages_done})
        return {"ok": True, "results": results, "high_water_received_id": prev_hw,
                "advanced": False, "has_more": True, "scan_in_progress": True,
                "cursor_gap": True, "partial": True, "stopped_reason": "pages"}

    # 扫到游标 / 历史尽头 → 前面全部处理完了，高水位推到窗口最顶端
    save_scan({})
    advanced_to = scan_newest or new_hw_id or prev_hw
    advanced = bool(advanced_to and advanced_to != prev_hw)
    if advanced:
        save_cursor(advanced_to, new_hw_created or prev_hw_created, sorted(processed)[-200:])
    return {"ok": True, "results": results, "high_water_received_id": advanced_to,
            "advanced": advanced, "has_more": has_more_raw, "partial": False,
            "stopped_reason": "complete"}


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
        # 退信/失败：列表接口无 bounce 详情，拉单封详情补齐具体原因（type/subType/diagnosticCode）
        if last_event in ("bounced", "failed") and not isinstance(item.get("bounce"), dict):
            try:
                st2, detail = get_sent(sid)
                if st2 == 200 and isinstance(detail, dict) and isinstance(detail.get("bounce"), dict):
                    item = {**item, "bounce": detail["bounce"]}
            except Exception:
                pass
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
    _budget = None
    _argv = list(sys.argv[1:])
    if "--timeout-seconds" in _argv:
        try:
            _budget = float(_argv[_argv.index("--timeout-seconds") + 1])
        except (IndexError, ValueError):
            _budget = None
    if _argv and _argv[0] == "list":
        st, d = list_received(limit=10)
        print(json.dumps({"status": st, "count": len(d.get("data", [])) if isinstance(d, dict) else 0,
                          "has_more": d.get("has_more") if isinstance(d, dict) else None}, ensure_ascii=False))
    elif _argv and _argv[0] == "status":
        print(json.dumps(poll_status_once(), ensure_ascii=False, indent=2))
    else:
        print(json.dumps({"received": poll_received_once(timeout_seconds=_budget),
                          "status": poll_status_once()},
                         ensure_ascii=False, indent=2))
