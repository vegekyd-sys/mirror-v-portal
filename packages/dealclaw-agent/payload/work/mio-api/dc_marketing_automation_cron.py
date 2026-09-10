#!/usr/bin/env python3
"""
dc_marketing_automation_cron.py — 展自动营销「出站」全链路编排（cron 入口）

一条命令跑完三步：
    ① run_cycle()        扫 memory → evaluate_next_action → 落 automations.json
    ② dispatch_pending()  active → 草稿（+content_route +审批位）
    ③ run_send_cycle()    草稿 → generator 生成正文 → 发送 → 关 automation

发送通道：`send_via_email_channel`（dc_email_send，GS/FD，退订+追踪+回执）。
正文生成：`openclaw_generator`（走 dealclaw agent，按 skill 口径）。
dry_run=True 时三步都不落库/不发送。
"""

from __future__ import annotations

import argparse
import json
import os
from typing import Any, Callable, Optional

DEFAULT_AGENT_ID = "dealclaw"
DEFAULT_CHANNEL = "GS"
DEFAULT_FROM = "V <V@mail.dealclaw.io>"


def make_send_fn(*, channel: str = DEFAULT_CHANNEL, from_addr: str = DEFAULT_FROM,
                 enterprise: str = "", receipt_target: str = "") -> Callable:
    """返回 send_one 用的 send_fn（走 dc_email_send 营销通道）。"""
    from dc_marketing_automation_send import send_via_email_channel

    def _send(draft_id: str, confirmed_by: str = "") -> dict:
        return send_via_email_channel(
            draft_id, confirmed_by, channel=channel, from_addr=from_addr,
            enterprise=enterprise, receipt_target=receipt_target)
    return _send


def run_all(
    company_id: str,
    *,
    workspace_root: Optional[str] = None,
    dry_run: bool = True,
    agent_id: str = DEFAULT_AGENT_ID,
    channel: str = DEFAULT_CHANNEL,
    from_addr: str = DEFAULT_FROM,
    receipt_target: str = "",
    generator: Optional[Callable] = None,
    send_fn: Optional[Callable] = None,
    now: Optional[str] = None,
) -> dict:
    """出站全链路：决策 → 路由 → 生成+发送。返回三步脱敏摘要。"""
    from dc_marketing_automation_runner import run_cycle
    from dc_marketing_automation_dispatch import dispatch_pending
    from dc_marketing_automation_send import run_send_cycle
    from dc_marketing_automation_generator import openclaw_generator

    gen = generator or (
        lambda task: openclaw_generator(task, agent_id=agent_id, workspace_root=workspace_root))
    sfn = send_fn or make_send_fn(channel=channel, from_addr=from_addr,
                                  enterprise=company_id, receipt_target=receipt_target)

    decided = run_cycle(company_id, workspace_root=workspace_root, dry_run=dry_run, now=now)
    dispatched = dispatch_pending(company_id, workspace_root=workspace_root, dry_run=dry_run)
    sent = run_send_cycle(company_id, gen, send_fn=sfn,
                          workspace_root=workspace_root, dry_run=dry_run)

    return {
        "company_id": company_id,
        "dry_run": dry_run,
        "decided": {"scanned": decided.get("scanned"),
                    "tasks_created": decided.get("tasks_created"),
                    "by_action": decided.get("by_action")},
        "dispatched": {"active_processed": dispatched.get("active_processed"),
                       "by_disposition": dispatched.get("by_disposition")},
        "sent": {"pending_total": sent.get("pending_total"), "sent": sent.get("sent"),
                 "pending_approval": sent.get("pending_approval"),
                 "failed": sent.get("failed")},
    }


def _cli() -> int:
    ap = argparse.ArgumentParser(description="展自动营销出站全链路（决策→路由→生成→发送）")
    ap.add_argument("--company-id", required=True)
    ap.add_argument("--workspace-root", default="")
    ap.add_argument("--no-dry-run", action="store_true", help="真正落库 + 发送（默认 dry_run）")
    ap.add_argument("--agent-id", default=DEFAULT_AGENT_ID)
    ap.add_argument("--channel", default=DEFAULT_CHANNEL)
    ap.add_argument("--from", dest="from_addr", default=DEFAULT_FROM)
    ap.add_argument("--receipt-target", default="")
    args = ap.parse_args()

    result = run_all(
        args.company_id,
        workspace_root=args.workspace_root or None,
        dry_run=not args.no_dry_run,
        agent_id=args.agent_id, channel=args.channel,
        from_addr=args.from_addr, receipt_target=args.receipt_target,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
