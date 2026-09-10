#!/usr/bin/env python3
"""backfill_stelang_outbound.py — 短期回填：把雪特朗历史 GS 直发邮件补进 email-facts。

背景：雪特朗(151897148668) 墨西哥展邀约邮件走 send_stelang_mx.py 直发 Resend，
写 scripts/founder-direct/sent-log.jsonl，但没落 email-facts/outbound/151897148668/，
导致 dc_followup 扫不到「已送达未回复」买家。本脚本按 founder-direct/sent-log.jsonl
重建 outbound 记录，复用 EmailStore.insert_message（幂等，resend_id 已存在则跳过）。

用法：
  python3 backfill_stelang_outbound.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _tenant_env import load_tenant_env

load_tenant_env()

from email_gateway.store import EmailStore  # noqa: E402

WORKSPACE = Path(__file__).resolve().parents[2]
SENT_LOG = WORKSPACE / "scripts" / "founder-direct" / "sent-log.jsonl"
CURSOR = WORKSPACE / "work" / "mio-api" / "data" / "resend-poller" / "status-cursor.md"

COMPANY_ID = "xuetelang"  # 雪特朗的 email-facts company_id（不是 151897148668，那个是 LPSK 罗普斯金）
ACCOUNT_ID = "ema_d2c6018d83d54333"  # thia@mail.dealclaw.io
SENDER = "thia@mail.dealclaw.io"

# 雪特朗邮件判定关键词（subject / cc / to 里出现）
STELANG_HINTS = ("stelang", "stelong", "maxd", "咖啡", "cafeteras", "catermex",
                 "animo", "calupoh", "cafeboato", "disamexico", "xaze", "multimarcas")


def _ts_to_utc(ts: str) -> str:
    """founder-direct 的 ts 是 Asia/Shanghai 本地时间，转 UTC ISO。"""
    if not ts:
        return datetime.now(timezone.utc).isoformat()
    try:
        # 无时区 → 按北京时间解析
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            from zoneinfo import ZoneInfo
            dt = dt.replace(tzinfo=ZoneInfo("Asia/Shanghai"))
        return dt.astimezone(timezone.utc).isoformat()
    except (ValueError, OSError):
        return datetime.now(timezone.utc).isoformat()


def load_cursor_status() -> dict[str, str]:
    """status-cursor.md 里的 resend_id -> 投递状态。"""
    out: dict[str, str] = {}
    if not CURSOR.exists():
        return out
    text = CURSOR.read_text(encoding="utf-8")
    for m in re.finditer(r'"([0-9a-f-]{36}):([a-z_]+)"', text):
        out[m.group(1)] = m.group(2)
    return out


def load_stelang_rows() -> list[dict]:
    rows = []
    for line in SENT_LOG.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("from") != SENDER:
            continue
        blob = json.dumps(d, ensure_ascii=False).lower()
        if not any(k in blob for k in STELANG_HINTS):
            continue
        if not d.get("resend_id") or not d.get("to"):
            continue
        rows.append(d)
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = load_stelang_rows()
    cursor = load_cursor_status()
    store = EmailStore()

    inserted = 0
    skipped_dup = 0
    skipped_no_status = 0
    status_count: dict[str, int] = {}
    errors = []

    for d in rows:
        rid = d["resend_id"]
        status = cursor.get(rid, "")
        if not status:
            # 不在 status-cursor → 投递状态未知，跳过（等 webhook 补），避免错标 delivered
            skipped_no_status += 1
            continue
        provider_status = "delivered" if status == "delivered" else status
        # suppressed/bounced 也落，但 dc_followup 会跳过
        if store.find_outbound_by_resend_id(rid):
            skipped_dup += 1
            continue
        ts_utc = _ts_to_utc(d.get("ts", ""))
        record = {
            "direction": "outbound",
            "account_id": ACCOUNT_ID,
            "sender": SENDER,
            "recipients": [d["to"]],
            "subject": d.get("subject", ""),
            "text": "",
            "html": "",
            "company_id": COMPANY_ID,
            "campaign_id": "stelang-mx-backfill",
            "resend_id": rid,
            "message_id": rid,
            "local_message_id": rid,
            "sent_at": ts_utc,
            "created_at": ts_utc,
            "status": "sent",
            "provider_status": provider_status,
            "touch_number": 1,
            "legacy": 1,
        }
        if args.dry_run:
            status_count[provider_status] = status_count.get(provider_status, 0) + 1
            inserted += 1
            continue
        try:
            if store.insert_message(record):
                inserted += 1
                status_count[provider_status] = status_count.get(provider_status, 0) + 1
            else:
                skipped_dup += 1
        except Exception as e:  # noqa: BLE001
            errors.append(f"{rid}: {str(e)[:120]}")

    print(json.dumps({
        "dry_run": args.dry_run,
        "total_stelang_rows": len(rows),
        "inserted": inserted,
        "skipped_duplicate": skipped_dup,
        "skipped_no_status": skipped_no_status,
        "status_breakdown": status_count,
        "errors": errors,
    }, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
