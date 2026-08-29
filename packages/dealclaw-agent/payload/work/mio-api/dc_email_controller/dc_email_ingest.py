#!/usr/bin/env python3
"""
dc_email_ingest.py — 本地纯业务入口（P0-E3C.1b Inbound Event Bridge）

远端 webhook ingress 只负责：收 raw body → Svix 验签 → svix-id 幂等 → 暂存事件
→ 提供认证增量读取 API。远端**不得**生成业务 signal/candidate、不得飞书通知、
不得自动回复。

本地此函数是唯一业务入口：远端事件 → 绑定/IQ/facts/signals/Shadow candidate。

跨来源统一幂等键（P0-E3C.1d）：
  inbound : received:<resend_received_id>
  delivery: delivery:<resend_id>:<provider_status>
来源事件 claim（svix-id / resend-poll id）之后再做 canonical fact claim；
只有 canonical 获得者执行 IQ/signals/candidate，另一来源返回 duplicate_fact。
"""

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical_root() -> Path:
    d = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
    return d / "email-facts" / "canonical-facts"


def canonical_key(event_type: str, data: dict) -> str:
    email_id = (data or {}).get("email_id") or (data or {}).get("id") or ""
    if event_type in ("email.delivered", "email.bounced", "email.complained", "email.failed"):
        return f"delivery:{email_id}:{event_type.split('.', 1)[1]}"
    if event_type in ("email.received", "inbound", "email.inbound"):
        return f"received:{email_id}"
    return ""


def _claim_canonical(key: str) -> bool:
    """已废弃：请用 claim_canonical（状态机）。保留兼容。"""
    return claim_canonical(key) == "claimed"


LEASE_SECONDS = int(os.environ.get("DC_CANONICAL_LEASE_SECONDS", "300"))


def _ts() -> float:
    return datetime.now(timezone.utc).timestamp()


def _canonical_path(key: str) -> Path:
    return _canonical_root() / "by-id" / f"{hashlib.sha256(key.encode()).hexdigest()}.md"


def _read_canonical(path: Path) -> dict:
    if not path.exists():
        return {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return {}


def _write_canonical(path: Path, rec: dict) -> None:
    content = "# DealClaw Canonical Fact\n\n" + json.dumps(rec, ensure_ascii=False) + "\n"
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def claim_canonical(key: str, lease_seconds: int = None) -> str:
    """状态机 claim。返回 claimed/already_processed/in_progress/reclaimed_failed/reclaimed_stale。"""
    if not key:
        return "claimed"
    lease = lease_seconds if lease_seconds is not None else LEASE_SECONDS
    path = _canonical_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    now = _ts()
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        rec = _read_canonical(path)
        status = rec.get("status", "processing")
        if status == "processed":
            return "already_processed"
        if status == "failed":
            return "reclaimed_failed"
        # processing：检查租约
        try:
            if float(rec.get("lease_expires_at", 0)) < now:
                return "reclaimed_stale"
        except (ValueError, TypeError):
            pass
        return "in_progress"
    rec = {
        "canonical_key": key, "status": "processing", "attempts": 1,
        "claimed_at": _now(), "lease_expires_at": now + lease,
        "processed_at": "", "failure_reason": "", "source_event_ids": [],
    }
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("# DealClaw Canonical Fact\n\n" + json.dumps(rec, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return "claimed"


def mark_canonical_processed(key: str) -> None:
    path = _canonical_path(key)
    rec = _read_canonical(path)
    if rec:
        rec["status"] = "processed"
        rec["processed_at"] = _now()
        rec["failure_reason"] = ""
        _write_canonical(path, rec)


def mark_canonical_failed(key: str, reason: str) -> None:
    path = _canonical_path(key)
    rec = _read_canonical(path)
    if rec:
        rec["status"] = "failed"
        rec["failure_reason"] = (reason or "")[:200]
        rec["attempts"] = int(rec.get("attempts", 0)) + 1
        _write_canonical(path, rec)


def append_source_event(key: str, event_id: str) -> None:
    if not event_id:
        return
    path = _canonical_path(key)
    rec = _read_canonical(path)
    if rec and event_id not in rec.get("source_event_ids", []):
        rec.setdefault("source_event_ids", []).append(event_id)
        _write_canonical(path, rec)


def ingest_resend_event(event: dict) -> dict:
    """接收一条远端事件，走完整业务链。

    event 结构（远端 API 契约）：
      {
        "sequence": 123,
        "svix_id": "msg_xxx",
        "event_type": "email.received" | "email.delivered" | ...,
        "received_at": "...",
        "payload": { ... Resend webhook data ... }
      }
    返回结构化结果；不抛异常（失败记录在结果里）。
    """
    event_type = (event.get("event_type") or event.get("type") or "").strip()
    data = event.get("payload") if isinstance(event.get("payload"), dict) else (event.get("data") or event)

    # 跨来源统一幂等：canonical fact claim（状态机）
    ckey = canonical_key(event_type, data)
    if ckey:
        st = claim_canonical(ckey)
        if st == "already_processed":
            return {"ok": True, "duplicate_fact": True, "event_type": event_type}
        if st == "in_progress":
            return {"ok": True, "in_progress": True, "event_type": event_type}
        append_source_event(ckey, event.get("svix_id") or event.get("source_event_id") or "")

    try:
        from .dc_webhook_handler import (
            handle_status_event, handle_inbound_event,
            STATUS_EVENT_TYPES, INBOUND_EVENT_TYPES,
        )
        if event_type in STATUS_EVENT_TYPES:
            r = handle_status_event(event_type, data)
            result = {"ok": r.get("handled", False), "event_type": event_type, **r}
        elif event_type in INBOUND_EVENT_TYPES:
            r = handle_inbound_event(data)
            result = {"ok": r.get("status") != "retryable", "event_type": event_type, **r}
        else:
            result = {"ok": True, "event_type": event_type, "status": "skipped"}
    except Exception as e:
        result = {"ok": False, "event_type": event_type, "error": f"{type(e).__name__}: {str(e)[:200]}"}

    # 完成态：只有完整成功才 processed；retryable/fail → failed
    if ckey:
        if result.get("ok"):
            mark_canonical_processed(ckey)
        else:
            mark_canonical_failed(ckey, result.get("failure_reason") or result.get("error") or "failed")
    return result


if __name__ == "__main__":
    import json, sys
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: python3 dc_email_ingest.py '<event json>'"}))
        raise SystemExit(1)
    print(json.dumps(ingest_resend_event(json.loads(sys.argv[1])), ensure_ascii=False))
