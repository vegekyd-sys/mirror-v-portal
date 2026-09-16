#!/usr/bin/env python3
"""DC-BackfillOutbound — 短期回填：把 Resend 历史直发邮件重建进 email-facts/outbound。

背景：send.mjs（GS 直发）走 Resend API，历史上不写 email-facts，导致 dc_followup
扫不到「已送达未回复」买家。长期统一已让 send.mjs 落库，但历史邮件仍是空窗。
本脚本从 Resend 拉历史邮件详情，按 from 地址归属到 company，幂等回填 outbound 记录。

归属规则（关键）：Resend 邮件没有 company_id，只能靠「from 地址」反查公司。
from 地址 → company 的映射由调用方通过 --from 显式指定（多租户下同一个代理邮箱
可能被多个公司复用，不能自动推断，避免把别的公司的邮件错归到当前公司）。

用法：
  python3 dc_backfill_outbound.py --company-id <sid> --from <proxy@mail.dealclaw.io> \
      [--since 2026-08-01] [--until 2026-09-10] [--dry-run]

- --from：必填，该公司的代理发件邮箱（裸地址，如 wangwenhua@mail.dealclaw.io）
- --dry-run：只打印候选，不写库
- 幂等：resend_id 已存在于 email-facts 的跳过
- provider_status 从 Resend last_event 映射（delivered/bounced/suppressed/sent）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from _tenant_env import load_tenant_env

load_tenant_env()

from email_gateway.store import EmailStore, utc_now  # noqa: E402

# last_event → provider_status
_EVENT_STATUS = {
    "delivered": "delivered",
    "bounced": "bounced",
    "suppressed": "suppressed",
    "complained": "complained",
    "sent": "accepted",
    "delivery_delayed": "delivery_delayed",
}


def _extract_addr(fr: str) -> str:
    if not fr:
        return ""
    import re
    m = re.search(r"<?([^<>\s]+@[^<>\s]+)>?$", fr.strip())
    return m.group(1) if m else fr.strip()


def _list_emails(api_key: str, since: str, until: str, limit: int = 100) -> list[dict]:
    """Resend GET /emails 分页拉全量（created_at 倒序）。按时间范围过滤。"""
    out: list[dict] = []
    offset = None
    while True:
        url = f"https://api.resend.com/emails?limit={limit}"
        if offset:
            url += f"&offset={offset}"
        req = urllib.request.Request(
            url, headers={"Authorization": f"Bearer {api_key}", "User-Agent": "DealClaw-backfill/1.0"})
        try:
            r = json.load(urllib.request.urlopen(req, timeout=30))
        except Exception as e:  # noqa: BLE001
            print(f"[backfill] 拉取列表失败: {e}", file=sys.stderr)
            break
        data = r.get("data") or []
        if not data:
            break
        for e in data:
            ca = e.get("created_at") or ""
            if since and ca < since:
                continue
            if until and ca > until:
                continue
            out.append(e)
        offset = data[-1].get("id")
        if not r.get("has_more"):
            break
    return out


def main() -> int:
    p = argparse.ArgumentParser(description="短期回填：Resend 直发 → email-facts outbound")
    p.add_argument("--company-id", required=True)
    p.add_argument("--from", dest="from_addr", required=True, help="代理发件邮箱裸地址")
    p.add_argument("--account-id", default="",
                   help="真实邮箱账号 id；不传则按 --from 反查（查不到落空，不造假）")
    p.add_argument("--since", default="", help="起始时间 ISO（含）")
    p.add_argument("--until", default="", help="截止时间 ISO（含）")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    api_key = os.environ.get("RESEND_API_KEY", "")
    if not api_key:
        print(json.dumps({"error": "RESEND_API_KEY 未配置"}))
        return 1

    from_filter = args.from_addr.strip().lower()
    store = EmailStore()

    # 2026-09-16 修复：不再写死 resend_gs（假账号 → 回信永远配不上）。
    # 显式传 --account-id 优先；否则按 --from 发件地址反查本租户真实账号，查不到落空。
    account_id = str(args.account_id or "").strip()
    if not account_id:
        try:
            from dc_record_outbound import resolve_account_id  # noqa: PLC0415

            account_id = resolve_account_id(store, args.from_addr)
        except Exception:  # noqa: BLE001
            account_id = ""
    if not account_id:
        print(json.dumps({"warning": "account_id unresolved from sender address",
                          "from": from_filter}, ensure_ascii=False))

    emails = _list_emails(api_key, args.since, args.until)
    candidates = []
    for e in emails:
        if _extract_addr(e.get("from") or "").lower() != from_filter:
            continue
        rid = e.get("id") or ""
        if not rid:
            continue
        if store.find_outbound_by_resend_id(rid):
            continue  # 已回填/已存在
        candidates.append(e)

    if args.dry_run:
        print(f"[dry-run] 命中 {len(candidates)} 封待回填（from={args.from_addr}, company={args.company_id}）")
        for e in candidates:
            print(f"  {e.get('id')} | {e.get('last_event')} | {(e.get('subject') or '')[:50]} | {e.get('to')}")
        return 0

    written = 0
    skipped = 0
    for e in candidates:
        to_list = e.get("to") or []
        rec = {
            "direction": "outbound",
            "account_id": account_id,
            "sender": e.get("from") or "",
            "recipients": to_list,
            "subject": e.get("subject") or "",
            "text_preview": "",
            "html": "",
            "company_id": args.company_id,
            "campaign_id": "",
            "status": "sent",
            "created_at": e.get("created_at") or utc_now(),
            "message_id": e.get("id") or "",
            "resend_id": e.get("id") or "",
            "provider_status": _EVENT_STATUS.get(e.get("last_event") or "", "accepted"),
            "touch_number": 0,
            "legacy": True,
            "updated_at": utc_now(),
        }
        try:
            if store.insert_message(rec):
                written += 1
            else:
                skipped += 1
        except Exception as ex:  # noqa: BLE001
            print(f"[backfill] 写失败 {e.get('id')}: {ex}", file=sys.stderr)
            skipped += 1

    print(json.dumps({"ok": True, "company_id": args.company_id,
                      "written": written, "skipped": skipped,
                      "total_candidates": len(candidates)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
