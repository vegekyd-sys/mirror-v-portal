"""webhook 事件管子：服务端回调 → 本地业务链（回调链路的本地端）。

背景（2026-09-15）
------------------
Resend → ``https://dealclaw.datathink.com/webhook/inbound``（服务端 ``email-webhook``
服务）→ Svix 验签 → ``email_events``（PostgreSQL，``message_id`` 唯一约束幂等）→ 线索状态
→ 飞书通知。服务端只负责「收 + 验签 + 落库 + 认证增量读取」，事件出口是
``GET /v1/events``（``Authorization: Bearer <ADMIN_TOKEN>``）。

本地此前**没有任何消费者**调用 ``/v1/events``：事件到了服务端数据库就停住，本地事实层
``source_event_ids`` 只有 ``resend-poll:*``，没有一条来自 webhook。本模块补上这一段，
使回调真正驱动「落库 → 信号 → 按发信会话推送」。

与既有链路的关系
----------------
``email_gateway/inbound_poller.py``（Resend Receiving/Sending API 轮询）与本模块是同一条
业务的**两种来源**，共用 ``dc_email_ingest`` 的 canonical claim：

* inbound   → ``received:<resend_received_id>``
* delivery  → ``delivery:<resend_id>:<provider_status>``

谁先到谁处理，后到的拿到 ``duplicate_fact`` —— 不会重复落库、不会重复推送。因此本模块
可以与轮询并存，也可以替代轮询（回调延迟更低、不用拉列表分页）。

安全设计（与 inbound_poller 一致：宁可漏跑一轮，也不丢信 / 不扰民）
-----------------------------------------------------------------
1. **默认不灌历史**：``baseline=True`` 只记当前高水位，不 ingest 任何历史事件；首次上生产
   必须先用它建立基线，否则会把服务端积压的全部历史事件一次性灌进事实层。
2. **只处理业务事件**：delivery（delivered/bounced/complained/failed）与 inbound
   （email.received）。其余（opened/clicked/contact.*/domain.*/suppression.* …）只计数，
   不落本地事实、不推送。
3. **游标只在整轮无错误时前移**：任何一条 ingest 失败都保持游标不动，下一轮重试。
4. **幂等三层**：本地 webhook receipt（svix-id）→ canonical fact claim（跨来源）→ store 落库。

配置（全部读环境变量，不写死）
------------------------------
``DC_WEBHOOK_BASE_URL``  服务端前缀，默认 ``https://dealclaw.datathink.com/webhook``
``WEBHOOK_ADMIN_TOKEN``  ``/v1/events`` 的 Bearer 凭据；未配置 → 直接报错（不静默空跑）

用法
----
    python3 -m email_gateway.webhook_poller --baseline              # 只记基线，不灌历史
    python3 -m email_gateway.webhook_poller --dry-run --limit 50    # 只看会处理什么
    python3 -m email_gateway.webhook_poller --notify                # 正式跑并推送
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_MIO = HERE.parent
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

DATA_DIR = Path(os.environ.get("DC_DATA_DIR") or (_MIO / "data"))
POLLER_DIR = DATA_DIR / "webhook-poller"
CURSOR_FILE = POLLER_DIR / "events-cursor.md"
CURSOR_HEADER = "# DealClaw Email Webhook Events Cursor"

DEFAULT_BASE_URL = "https://dealclaw.datathink.com/webhook"
ENDPOINT = "/v1/events"
USER_AGENT = "DealClawEmailBot/1.0 (+https://dealclaw.datathink.com)"

# 服务端存了全部 Resend 事件；本地业务层只认这两类。
BUSINESS_EVENT_TYPES = (
    "email.received", "inbound", "email.inbound",
    "email.delivered", "email.bounced", "email.complained", "email.failed",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── 游标 ──────────────────────────────────────────────────
def load_cursor() -> dict:
    """读游标。缺文件 / 损坏 → 返回空游标（调用方需自行决定是否先建基线）。"""
    if not CURSOR_FILE.exists():
        return {"cursor": "", "updated_at": ""}
    for line in CURSOR_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            d = json.loads(line)
            return {"cursor": str(d.get("cursor") or ""), "updated_at": d.get("updated_at", "")}
        except json.JSONDecodeError:
            continue
    return {"cursor": "", "updated_at": ""}


def save_cursor(cursor: str, *, last_event_at: str = "", scanned: int = 0) -> None:
    POLLER_DIR.mkdir(parents=True, exist_ok=True)
    body = json.dumps({"cursor": cursor, "last_event_at": last_event_at,
                       "scanned": scanned, "updated_at": _now()}, ensure_ascii=False)
    tmp = CURSOR_FILE.with_suffix(".md.tmp")
    tmp.write_text(CURSOR_HEADER + "\n\n" + body + "\n", encoding="utf-8")
    tmp.replace(CURSOR_FILE)


# ── 取事件 ────────────────────────────────────────────────
def fetch_events(*, after: str = "", limit: int = 200, base_url: str = "",
                 token: str = "", opener=None, timeout: int = 30) -> dict:
    """拉一页事件。返回 ``{ok, status, events, next_cursor, has_more, error}``，不抛异常。

    契约见服务端 ``packages/email-webhook/src/routes/events.ts``：
    返回体含 ``events[]``（每项 ``sequence`` 即下次游标）与 ``next_cursor`` / ``has_more``。
    """
    token = token or os.environ.get("WEBHOOK_ADMIN_TOKEN", "").strip()
    if not token:
        return {"ok": False, "status": 0, "events": [], "next_cursor": after, "has_more": False,
                "error": "WEBHOOK_ADMIN_TOKEN 未配置"}
    base = (base_url or os.environ.get("DC_WEBHOOK_BASE_URL", "") or DEFAULT_BASE_URL).rstrip("/")
    url = f"{base}{ENDPOINT}?limit={max(1, min(int(limit), 200))}"
    if after:
        url += "&after=" + urllib.parse.quote(str(after))
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}", "User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as resp:
            payload = json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "ignore")[:200]
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "status": exc.code, "events": [], "next_cursor": after,
                "has_more": False, "error": f"HTTP {exc.code} {detail}"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "status": -1, "events": [], "next_cursor": after,
                "has_more": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"ok": True, "status": 200, "events": payload.get("events") or [],
            "next_cursor": str(payload.get("next_cursor") or after),
            "has_more": bool(payload.get("has_more"))}


def _default_deps() -> dict:
    """默认依赖（懒加载，避免导入环与测试污染）。"""
    from dc_email_controller.dc_email_ingest import ingest_resend_event  # noqa: PLC0415
    from email_gateway.inbound_poller import (  # noqa: PLC0415
        _notify_text, _recipient, _reply_brief, resolve_notify_binding)
    from email_gateway.notify_delivery import deliver  # noqa: PLC0415
    from email_gateway.store import EmailStore  # noqa: PLC0415

    return {"fetch_events": fetch_events, "ingest": ingest_resend_event,
            "resolve_notify_binding": resolve_notify_binding, "notify_text": _notify_text,
            "reply_brief": _reply_brief, "recipient": _recipient, "deliver": deliver,
            "store": EmailStore(), "load_cursor": load_cursor, "save_cursor": save_cursor}


def _as_item(event: dict) -> dict:
    """把 webhook 事件包成 ``_reply_brief`` / ``_notify_text`` 认的 item 形状。"""
    data = event.get("payload") or {}
    return {"id": data.get("email_id") or data.get("id") or event.get("svix_id") or "",
            "from": data.get("from") or "",
            "subject": data.get("subject") or "",
            "created_at": event.get("received_at") or data.get("created_at") or ""}


def poll_once(
    *,
    baseline: bool = False,
    dry_run: bool = False,
    limit: int = 200,
    max_pages: int = 20,
    notify: bool = False,
    collect: bool = True,
    base_url: str = "",
    token: str = "",
    deps: dict | None = None,
    store=None,
) -> dict:
    """跑一轮 webhook 事件消费。**本函数不抛异常**，问题都记录在返回结构里。

    返回
    ----
    ``{"ok", "mode", "scanned", "considered", "ingested", "matched", "notified",
       "unmatched", "skipped", "ignored", "errors": [], "cursor_advanced", "advanced_to",
       "replies": [], "unmatched_items": [], "notify_targets": []}``
    """
    d = {**_default_deps(), **(deps or {})}
    out: dict = {
        "ok": True, "mode": "baseline" if baseline else ("dry_run" if dry_run else "poll"),
        "scanned": 0, "considered": 0, "ingested": 0, "matched": 0, "notified": 0,
        "unmatched": 0, "skipped": 0, "ignored": 0, "errors": [],
        "cursor_advanced": False, "advanced_to": "", "replies": [],
        "unmatched_items": [], "notify_targets": [],
    }
    st = store if store is not None else d["store"]

    try:
        cursor = str((d["load_cursor"]() or {}).get("cursor") or "")
    except Exception as exc:  # noqa: BLE001
        out["ok"] = False
        out["errors"].append(f"load_cursor: {type(exc).__name__}: {exc}")
        return out

    last_seq, last_at, saw_error, pages = cursor, "", False, 0
    while pages < max(1, int(max_pages)):
        req_after = last_seq
        page = d["fetch_events"](after=req_after, limit=limit, base_url=base_url, token=token)
        pages += 1
        if not page.get("ok"):
            out["ok"] = False
            out["errors"].append(f"fetch_events: {page.get('error')}")
            saw_error = True
            break
        events = page.get("events") or []
        if not events:
            break

        for event in events:
            out["scanned"] += 1
            etype = str(event.get("event_type") or "")
            seq = str(event.get("sequence") or "")
            if seq:
                last_seq, last_at = seq, str(event.get("received_at") or "")
            if etype not in BUSINESS_EVENT_TYPES:
                out["ignored"] += 1
                continue
            out["considered"] += 1
            if dry_run:
                continue
            if baseline:
                continue

            svix_id = str(event.get("svix_id") or "")
            data = event.get("payload") or {}
            email_id = str(data.get("email_id") or data.get("id") or "")
            # 本地回调收据：让「回调到底到没到本地」可观测（幂等，重复投递返回非 claimed）。
            try:
                state = st.claim_webhook_event(svix_id, etype, email_id) if hasattr(
                    st, "claim_webhook_event") else "claimed"
            except Exception as exc:  # noqa: BLE001
                state = "claimed"
                out["errors"].append(f"{svix_id}: receipt {type(exc).__name__}: {exc}")
            if state == "already_processed":
                out["skipped"] += 1
                continue

            try:
                r = d["ingest"](event) or {}
            except Exception as exc:  # noqa: BLE001
                out["errors"].append(f"{svix_id}: ingest {type(exc).__name__}: {exc}")
                saw_error = True
                break

            if r.get("duplicate_fact") or r.get("in_progress"):
                out["skipped"] += 1
                try:
                    st.mark_webhook_event_processed(svix_id, "duplicate")
                except Exception:  # noqa: BLE001
                    pass
                continue
            if not r.get("ok"):
                out["errors"].append(f"{svix_id}: ingest not ok status={r.get('status') or r.get('error')}")
                saw_error = True
                break
            out["ingested"] += 1
            try:
                st.mark_webhook_event_processed(svix_id, "processed")
            except Exception:  # noqa: BLE001
                pass

            item = _as_item(event)
            if etype in ("email.received", "inbound", "email.inbound"):
                matched = bool(r.get("matched"))
            else:
                matched = bool(r.get("matched"))
            if not matched:
                out["unmatched"] += 1
                out["unmatched_items"].append({
                    "received_id": email_id,
                    "from": str(data.get("from") or ""),
                    "subject": str(data.get("subject") or ""),
                    "reason": str(r.get("failure_reason") or r.get("status") or "unmatched"),
                })
                continue

            out["matched"] += 1
            if collect:
                out["replies"].append(d["reply_brief"](item, event, r, None))
            if notify:
                # 投递目标：发信会话（outbound.origin_notify_target）优先，account 绑定回退。
                binding = d["resolve_notify_binding"](
                    origin_notify_target=str(r.get("origin_notify_target") or ""),
                    account_id=str(r.get("account_id") or ""),
                    address=d["recipient"](event), store=st)
                if binding:
                    res = d["deliver"](binding, text=d["notify_text"](item, event, r))
                    if res.get("ok"):
                        out["notified"] += 1
                        out["notify_targets"].append({
                            "received_id": email_id, "target": str(binding.get("chat_id") or ""),
                            "source": str(binding.get("source") or ""),
                            "channel": str(res.get("channel") or "")})
                    else:
                        out["errors"].append(f"{email_id}: notify {res.get('error')}")
                else:
                    out["errors"].append(f"{email_id}: notify skipped（既无发信会话，也无通知绑定）")

        if saw_error or not page.get("has_more"):
            break
        nxt = str(page.get("next_cursor") or "")
        if not nxt or nxt == req_after:
            break  # 游标不再前进：避免无限循环
        last_seq = nxt

    if dry_run:
        return out

    if baseline:
        # 只记基线：本轮不 ingest，游标前移到最新一条。
        if last_seq and last_seq != cursor:
            try:
                d["save_cursor"](last_seq, last_event_at=last_at, scanned=out["scanned"])
                out["cursor_advanced"] = True
                out["advanced_to"] = last_seq
            except Exception as exc:  # noqa: BLE001
                out["ok"] = False
                out["errors"].append(f"save_cursor: {type(exc).__name__}: {exc}")
        return out

    if not saw_error and last_seq and last_seq != cursor:
        try:
            d["save_cursor"](last_seq, last_event_at=last_at, scanned=out["scanned"])
            out["cursor_advanced"] = True
            out["advanced_to"] = last_seq
        except Exception as exc:  # noqa: BLE001
            out["ok"] = False
            out["errors"].append(f"save_cursor: {type(exc).__name__}: {exc}")
    return out


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="消费服务端 webhook 事件（GET /v1/events）进本地业务链")
    ap.add_argument("--baseline", action="store_true", help="只记高水位，不 ingest 历史事件")
    ap.add_argument("--dry-run", action="store_true", help="只统计会处理什么，不落库不推送")
    ap.add_argument("--notify", action="store_true", help="归属成功的回信推送到发信会话")
    ap.add_argument("--limit", type=int, default=200, help="单页条数（服务端上限 200）")
    ap.add_argument("--max-pages", type=int, default=20)
    ap.add_argument("--base-url", default="")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    r = poll_once(baseline=args.baseline, dry_run=args.dry_run, notify=args.notify,
                  limit=args.limit, max_pages=args.max_pages, base_url=args.base_url)
    print(json.dumps(r, ensure_ascii=False, indent=2) if args.json else json.dumps(
        {k: r[k] for k in ("ok", "mode", "scanned", "considered", "ingested", "matched",
                           "notified", "unmatched", "skipped", "ignored", "cursor_advanced",
                           "advanced_to", "errors")}, ensure_ascii=False, indent=2))
    return 0 if r["ok"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
