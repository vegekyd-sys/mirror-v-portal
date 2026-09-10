#!/usr/bin/env python3
"""DC-RecordOutbound — 把 GS 群发(Resend 直发)的发送事实落进 email-facts outbound。

send.mjs 走 Resend API 直发，不经过 email_gateway，之前不落 outbound 事实，
导致 dc_followup 扫不到「已送达未回复」买家。现在 send.mjs 发送成功后调本脚本，
复用 EmailStore.insert_message 落一条 outbound 记录（带 resend_id），
后续 dc_webhook_handler 能按 resend_id 更新投递状态（delivered/bounced），
dc_followup 能据此生成跟进草稿。

用法：
  python3 dc_record_outbound.py --company-id <sid> --from <addr> --to <a,b,c> \
      --subject <s> --text <t> --resend-id <id> [--account-id resend_gs]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _tenant_env import load_tenant_env

load_tenant_env()

from email_gateway.store import EmailStore, utc_now  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="记录一条 GS/Resend 直发 outbound 事实")
    p.add_argument("--company-id", default="")
    p.add_argument("--account-id", default="resend_gs")
    p.add_argument("--from", dest="from_addr", default="")
    p.add_argument("--to", default="")
    p.add_argument("--subject", default="")
    p.add_argument("--text", default="")
    p.add_argument("--html", default="")
    p.add_argument("--resend-id", default="")
    p.add_argument("--campaign-id", default="")
    args = p.parse_args()

    if not args.company_id or not args.resend_id or not args.to:
        print(json.dumps({"ok": False, "error": "missing required fields"}))
        return 1

    to_list = [t.strip() for t in args.to.split(",") if t.strip()]
    if not to_list:
        print(json.dumps({"ok": False, "error": "empty recipients"}))
        return 1

    store = EmailStore()
    # 幂等：同 resend_id 已落过则跳过（send.mjs 可能被重试）
    if store.find_outbound_by_resend_id(args.resend_id):
        print(json.dumps({"ok": True, "duplicate": True, "resend_id": args.resend_id}))
        return 0

    now = utc_now()
    record = {
        "direction": "outbound",
        "account_id": args.account_id,
        "sender": args.from_addr,
        "recipients": to_list,
        "subject": args.subject,
        "text_preview": args.text,
        "html": args.html,
        "company_id": args.company_id,
        "campaign_id": args.campaign_id,
        "status": "sent",
        "created_at": now,
        "message_id": args.resend_id,   # 稳定幂等键
        "resend_id": args.resend_id,
        "provider_status": "accepted",
        "touch_number": 0,
        "legacy": not bool(args.campaign_id),
        "updated_at": now,
    }
    try:
        inserted = store.insert_message(record)
        print(json.dumps({"ok": True, "inserted": inserted, "resend_id": args.resend_id,
                          "company_id": args.company_id}))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:200]}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
