#!/usr/bin/env python3
"""export-email-diagnostic.py — 租户侧**只读**邮件诊断导出。

用途：租户环境里没有我们的开发数据，需要一份「能拿去对账、但不泄密」的包。

**只读**：不写任何存储、不改状态、不发邮件。

**导出内容**：邮件事件与投递/互动状态、归属与绑定状态、按业务时区的指标。
**明确不导出**：正文（text/html）、主题、收件人/发件人邮箱、附件、账号与配置、
密钥、任何可还原身份的信息。

**假名**：所有消息/线程/买家 ID 都用稳定假名（`email_metrics.pseudonym`），
同一次导出与多次导出之间保持可对齐，但仍不可还原为真实值。
盐来自 `DC_DIAGNOSTIC_SALT`；未设置时用固定常量（只保证稳定，不保证抗枚举）。

用法：
    python3 export-email-diagnostic.py --data-dir <DC_DATA_DIR> --company-id <id> \\
        --out /tmp/dc-email-diagnostic.json [--since 2026-09-01 --until 2026-09-12] \\
        [--report-timezone Asia/Shanghai]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from email_metrics.adapter import load_legacy_from_dir  # noqa: E402
from email_metrics.facts import replay  # noqa: E402
from email_metrics.reconcile import reconcile, render_markdown  # noqa: E402
from email_metrics.views import DEFAULT_REPORT_TZ, activity_view, metrics_view  # noqa: E402


def build_export(data_dir: str, company_id: str | None = None,
                 since: str | None = None, until: str | None = None,
                 report_timezone: str = DEFAULT_REPORT_TZ,
                 include_markdown: bool = True) -> dict:
    facts_root = Path(data_dir) / "email-facts"
    if not facts_root.exists():
        facts_root = Path(data_dir)

    adapted = load_legacy_from_dir(facts_root)
    result = replay(adapted["events"], watermark_utc=None)
    date_range = (since, until) if (since or until) else None

    metrics = metrics_view(result, company_id=company_id, date_range=date_range,
                           report_timezone=report_timezone,
                           legacy_unverified=adapted["stats"]["legacy_unverified"])
    activity = activity_view(result, company_id=company_id, date_range=date_range,
                             report_timezone=report_timezone,
                             legacy_unverified=adapted["stats"]["legacy_unverified"])
    report = reconcile(result, company_id=company_id, date_range=date_range,
                       report_timezone=report_timezone,
                       legacy_unverified=adapted["stats"]["legacy_unverified"])

    out = {
        "export_schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "facts_root": str(facts_root),
            "mode": "read_only",
            "pseudonymized": True,
            "excluded_fields": ["text", "html", "subject", "sender", "recipients",
                                "attachments", "accounts", "config", "secrets"],
        },
        "company_id": company_id or "",
        "report_timezone": report_timezone,
        "adapted_stats": adapted["stats"],
        "metrics": metrics,
        "activity": activity,
        "reconcile": report,
    }
    if include_markdown:
        out["reconcile_markdown"] = render_markdown(report)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="只读导出邮件诊断包（脱敏）")
    ap.add_argument("--data-dir", required=True, help="DC_DATA_DIR（含 email-facts/）")
    ap.add_argument("--company-id", default=None)
    ap.add_argument("--since", default=None, help="业务日 YYYY-MM-DD")
    ap.add_argument("--until", default=None, help="业务日 YYYY-MM-DD")
    ap.add_argument("--report-timezone", default=DEFAULT_REPORT_TZ)
    ap.add_argument("--out", required=True)
    ap.add_argument("--no-markdown", action="store_true")
    args = ap.parse_args(argv)

    payload = build_export(args.data_dir, company_id=args.company_id,
                           since=args.since, until=args.until,
                           report_timezone=args.report_timezone,
                           include_markdown=not args.no_markdown)
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                              encoding="utf-8")

    m = payload["metrics"]
    print(f"已导出（只读·脱敏）：{args.out}")
    print(f"  发送 {m['sent']} · 送达(final) {m['delivered_final']}"
          f" · 送达(ever) {m['delivered_ever']} · 退信 {m['bounced']}"
          f" · pending {m['pending']} · legacy_unverified {m['legacy_unverified']}")
    print(f"  回复：inbound {m['inbound_messages']} · 唯一买家 {m['unique_repliers']}"
          f" · 线程 {m['replied_threads']} · 商机 {m['confirmed_opportunity_repliers']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
