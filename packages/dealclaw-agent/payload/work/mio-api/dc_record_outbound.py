#!/usr/bin/env python3
"""DC-RecordOutbound — 把 GS 群发(Resend 直发)的发送事实落进 email-facts outbound。

send.mjs 走 Resend API 直发，不经过 email_gateway，之前不落 outbound 事实，
导致 dc_followup 扫不到「已送达未回复」买家。现在 send.mjs 发送成功后调本脚本，
复用 EmailStore.insert_message 落一条 outbound 记录（带 resend_id），
后续 dc_webhook_handler 能按 resend_id 更新投递状态（delivered/bounced），
dc_followup 能据此生成跟进草稿。

用法：
  python3 dc_record_outbound.py --company-id <sid> --from <addr> --to <a,b,c> \
      --subject <s> --text <t> --resend-id <id> [--account-id <真实账号>]

2026-09-16 修复：`--account-id` 原先默认写死 `resend_gs`（一个不存在的账号），
调用方不传时事实里就落这个假账号 → **回信按账号匹配时永远配不上**（回信通知失灵的根因）。
现在默认改为「按 `--from` 发件地址反查本租户真实邮箱账号」；显式传 `--account-id` 仍以传入值为准；
反查不到时如实落空（不再造假），由链路自检 `dc_email_selfcheck.py` 标为无归属并自愈。
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
from enterprise_ids import canonical_company_id  # noqa: E402


def _bare_address(raw: str) -> str:
    """``Name <a@b>`` / ``a@b`` → 小写裸地址。"""
    text = str(raw or "").strip()
    if "<" in text and ">" in text:
        text = text[text.find("<") + 1:text.rfind(">")]
    return text.strip().lower()


def resolve_account_id(store: EmailStore, from_addr: str) -> str:
    """按发件地址反查本租户真实邮箱账号；查不到返回空串（**不猜、不造假**）。"""
    addr = _bare_address(from_addr)
    if not addr:
        return ""
    try:
        accounts = store.list_accounts() or []
    except Exception:  # noqa: BLE001
        return ""
    for acc in accounts:
        if str(acc.get("email_address") or "").strip().lower() == addr:
            return str(acc.get("account_id") or "")
    return ""


def main() -> int:
    p = argparse.ArgumentParser(description="记录一条 GS/Resend 直发 outbound 事实")
    p.add_argument("--company-id", default="")
    p.add_argument("--account-id", default="",
                   help="真实邮箱账号 id；不传则按 --from 发件地址反查（查不到落空，不造假）")
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

    company_id = canonical_company_id(args.company_id)
    if not company_id:
        print(json.dumps({"ok": False, "error": "company_id cannot be resolved"}))
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

    # 账号：显式传入优先；否则按发件地址反查真实账号（不再写死 resend_gs）
    account_id = str(args.account_id or "").strip()
    resolved = bool(account_id)
    if not account_id:
        account_id = resolve_account_id(store, args.from_addr)
        resolved = bool(account_id)
    if not account_id:
        print(json.dumps({"warning": "account_id unresolved from sender address",
                          "from": _bare_address(args.from_addr)}, ensure_ascii=False),
              file=sys.stderr)

    now = utc_now()
    record = {
        "direction": "outbound",
        "account_id": account_id,
        "sender": args.from_addr,
        "recipients": to_list,
        "subject": args.subject,
        "text_preview": args.text,
        "html": args.html,
        "company_id": company_id,
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
                          "company_id": company_id, "account_id": account_id,
                          "account_resolved": resolved}))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:200]}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
