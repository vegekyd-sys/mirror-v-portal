#!/usr/bin/env python3
"""dc_daily_pipeline.py — Daily Brief 组合编排（EmailProvider + OpportunityProvider）

把两个 Provider 的事实合并成一个 plan：
  1. EmailProvider：邮件送达/退信/观察期 → 通用批量跟进（待分层）。
  2. OpportunityProvider：商机 Memory 客户级证据 → 客户级 action。
  3. 分层（规则 6）：客户级 action 命中的买家，从通用批量跟进人数中扣除。
  4. 早报 Top3 只标注客户级证据行动；剩余批量项仍「保留」在 plan 并参与晚报核销。
  5. 晚报按真实事件（followup_sent / quote_sent / sample_sent）核销。

职责边界：本层只读写 memory（plan.json / review.json），不发送、不接 LLM。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from dc_daily_brief import (
    BriefContext, build_plan, write_plan, review_plan,
    safe_memory_dir, atomic_write_json, safe_collect,
)
from dc_email_provider import EmailProvider
from dc_opportunity_provider import OpportunityProvider, layer_batch_followup


def _send_kind(ob: dict) -> str:
    """outbound → 发送类别：quote / sample / followup（无标记时 touch>=1 视为 followup）。"""
    k = str(ob.get("send_kind") or ob.get("category") or ob.get("outbound_kind") or "").strip().lower()
    if k in ("quote", "sample", "followup"):
        return k
    if int(ob.get("touch_number", 0) or 0) >= 1:
        return "followup"
    return ""


def collect_completion_events(context: BriefContext, plan: dict,
                              email_store=None) -> list[dict]:
    """从真实 outbound 记录生成核销事件（followup_sent / quote_sent / sample_sent）。"""
    try:
        store = email_store or EmailProvider()._get_store()
        outbounds = store.list_outbound_records(company_id=context.company)
    except Exception:  # noqa: BLE001
        return []
    events: list[dict] = []
    for action in plan.get("actions", []):
        rule = action.get("completion_rule") or {}
        targets = set((rule.get("params") or {}).get("target_ids") or [])
        akey = action.get("action_key")
        for ob in outbounds:
            buyer = (ob.get("recipients") or [""])[0]
            if buyer not in targets:
                continue
            kind = _send_kind(ob)
            if not kind:
                continue
            rid = ob.get("resend_id") or ob.get("local_message_id") or ob.get("smtp_message_id") or ""
            events.append({
                "action_key": akey,
                "kind": f"{kind}_sent",
                "target_id": buyer,
                "event_id": f"{kind}_{buyer}_{rid}",
                "occurred_at": ob.get("sent_at") or ob.get("created_at") or "",
            })
    return events


def run_morning_brief(context: BriefContext, base_dir: Path, email_store=None,
                      opp_store=None, top_n: int = 3) -> dict:
    """早报：EmailProvider + OpportunityProvider → 分层 → plan.json。

    plan["actions"] 保留全部行动（含剩余批量项，供晚报核销）；
    plan["top_n_action_keys"] 标出 Top-N（客户级证据优先，不按读取顺序）。
    """
    email_result = safe_collect(EmailProvider(store=email_store), context)
    opp_result = safe_collect(OpportunityProvider(store=opp_store), context)

    opp_actions = [it for it in opp_result.items if it.kind == "action"]
    email_items, layer_info = layer_batch_followup(context, email_result.items, opp_actions)

    items = email_items + list(opp_result.items)
    # 保留全部 action（大 max_actions），Top-N 单独标注；排序/去重仍复用 build_plan。
    plan = build_plan(items, max_actions=10 ** 6)
    plan["layering"] = layer_info
    plan["top_n"] = top_n
    plan["top_n_action_keys"] = [a["action_key"] for a in plan["actions"][:top_n]]

    d = safe_memory_dir(base_dir, context.tenant, context.company, context.date)
    plan = write_plan(d / "plan.json", plan)
    return {
        "plan": plan,
        "layering": layer_info,
        "provider_errors": list(email_result.errors) + list(opp_result.errors),
        "provider_warnings": list(email_result.warnings) + list(opp_result.warnings),
    }


def run_evening_brief(context: BriefContext, base_dir: Path, email_store=None,
                      events=None) -> dict:
    """晚报：读 plan.json → 真实事件核销 → review.json（部分核销返回 partial）。"""
    d = safe_memory_dir(base_dir, context.tenant, context.company, context.date)
    plan_path = d / "plan.json"
    if not plan_path.exists():
        return {"review": None, "error": "no plan.json"}
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    evs = events if events is not None else collect_completion_events(context, plan, email_store)
    review = review_plan(plan, evs)
    atomic_write_json(d / "review.json", review)
    return {"review": review}


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Daily Brief 组合编排（Email + Opportunity）")
    ap.add_argument("cmd", choices=["morning", "evening"])
    ap.add_argument("--company", required=True)
    ap.add_argument("--tenant", default="meorient")
    ap.add_argument("--date", required=True)
    ap.add_argument("--out", default="data/daily-brief")
    args = ap.parse_args()

    now = datetime.now(timezone.utc).isoformat()
    ctx = BriefContext(tenant=args.tenant, company=args.company,
                       report_type=args.cmd, date=args.date, tz="Asia/Shanghai",
                       as_of=now, window_start=now, window_end=now)
    base = Path(args.out)
    out = run_morning_brief(ctx, base) if args.cmd == "morning" else run_evening_brief(ctx, base)
    print(json.dumps(out, ensure_ascii=False, indent=2))
