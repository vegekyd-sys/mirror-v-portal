#!/usr/bin/env python3
"""dc_daily_pipeline.py — Daily Brief 组合编排（Email + Opportunity + Exhibition）

把 Provider 的事实合并成一个 plan：
  1. EmailProvider：邮件送达/退信/观察期 → 通用批量跟进（待分层）。
  2. OpportunityProvider：商机 Memory 客户级证据 → 客户级 action。
  3. ExhibitionProvider：展会五阶段 → result/action/risk/insight。
  4. 分层（规则 6）：邮件客户级 action 命中的买家，从通用批量跟进人数中扣除。
  5. 跨 Provider 去重（规则 8）：同一买家多个客户级 action → 保留证据更完整的。
  6. 早报 Top-N 标注；晚报按真实事件核销（followup_sent/quote_sent/sample_sent +
     展会阶段推进 signal_resolved）。

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
from dc_exhibition_provider import ExhibitionProvider

STAGE_RANK = {"profiling": 0, "planning": 1, "inviting": 2, "live": 3, "followup": 4}
# 跨 Provider 去重时的来源偏好（证据数相同时优先更具体的客户级商机证据）
_SOURCE_PRIORITY = {"opportunity": 2, "exhibition": 1, "email": 0}


def _send_kind(ob: dict) -> str:
    k = str(ob.get("send_kind") or ob.get("category") or ob.get("outbound_kind") or "").strip().lower()
    if k in ("quote", "sample", "followup"):
        return k
    if int(ob.get("touch_number", 0) or 0) >= 1:
        return "followup"
    return ""


def dedupe_cross_provider(items: list) -> tuple[list, list]:
    """规则 8：同一买家多个客户级 action → 保留证据更完整的那个（其他丢弃）。

    只对 target type=buyer 的 action 去重；阶段/聚合 action 不参与。
    返回 (items, dropped)。
    """
    groups: dict[str, list] = {}
    passthrough: list = []
    for it in items:
        if it.kind != "action":
            passthrough.append(it)
            continue
        buyer_targets = [t.id for t in it.target_refs if t.type == "buyer"]
        if not buyer_targets:
            passthrough.append(it)
            continue
        groups.setdefault(buyer_targets[0], []).append(it)

    kept: list = []
    dropped: list = []
    for target, acts in groups.items():
        if len(acts) == 1:
            kept.append(acts[0])
            continue
        winner = max(acts, key=lambda a: (len(a.evidence_refs),
                                          _SOURCE_PRIORITY.get(a.source, 0)))
        kept.append(winner)
        dropped += [a for a in acts if a is not winner]
    return passthrough + kept, dropped


def collect_completion_events(context: BriefContext, plan: dict,
                              email_store=None, exh_store=None) -> list[dict]:
    """真实事件：邮件 followup/quote/sample 发送 + 展会阶段推进（signal_resolved）。"""
    events: list[dict] = []
    # 1) 邮件发送事件
    try:
        store = email_store or EmailProvider()._get_store()
        outbounds = store.list_outbound_records(company_id=context.company)
    except Exception:  # noqa: BLE001
        outbounds = []
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
            events.append({"action_key": akey, "kind": f"{kind}_sent", "target_id": buyer,
                           "event_id": f"{kind}_{buyer}_{rid}",
                           "occurred_at": ob.get("sent_at") or ob.get("created_at") or ""})

    # 2) 展会阶段推进事件（signal_resolved）
    try:
        store = exh_store or ExhibitionProvider()._get_store()
        meta = store.read_meta(context.company)
        cur_stage = (meta or {}).get("exhibition_stage") or ""
    except Exception:  # noqa: BLE001
        cur_stage = ""
    if cur_stage in STAGE_RANK:
        for action in plan.get("actions", []):
            if not str(action.get("category") or "").startswith("stage_"):
                continue
            stage = (action.get("detail") or {}).get("stage") or ""
            if stage in STAGE_RANK and STAGE_RANK[cur_stage] > STAGE_RANK[stage]:
                sid = ((action.get("completion_rule") or {}).get("params") or {}).get("signal_id")
                events.append({"action_key": action.get("action_key"), "kind": "signal",
                               "status": "resolved", "signal_id": sid,
                               "event_id": f"stage_{stage}->{cur_stage}",
                               "occurred_at": _now()})
    return events


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_morning_brief(context: BriefContext, base_dir: Path, email_store=None,
                      opp_store=None, exh_store=None, reminded_keys=(),
                      top_n: int = 3) -> dict:
    """早报：三 Provider → 分层 → 跨 Provider 去重 → plan.json（Top-N 标注）。"""
    email_result = safe_collect(EmailProvider(store=email_store), context)
    opp_result = safe_collect(OpportunityProvider(store=opp_store), context)
    exh_result = safe_collect(ExhibitionProvider(store=exh_store, reminded_keys=reminded_keys),
                              context)

    opp_actions = [it for it in opp_result.items if it.kind == "action"]
    email_items, layer_info = layer_batch_followup(context, email_result.items, opp_actions)

    items = email_items + list(opp_result.items) + list(exh_result.items)
    items, dropped = dedupe_cross_provider(items)

    plan = build_plan(items, max_actions=10 ** 6)
    plan["layering"] = layer_info
    plan["cross_provider_dropped"] = [
        {"title": a.title, "source": a.source, "category": a.category} for a in dropped]
    plan["top_n"] = top_n
    plan["top_n_action_keys"] = [a["action_key"] for a in plan["actions"][:top_n]]

    d = safe_memory_dir(base_dir, context.tenant, context.company, context.date)
    plan = write_plan(d / "plan.json", plan)
    return {
        "plan": plan,
        "layering": layer_info,
        "cross_provider_dropped": plan["cross_provider_dropped"],
        "provider_errors": (list(email_result.errors) + list(opp_result.errors)
                            + list(exh_result.errors)),
        "provider_warnings": (list(email_result.warnings) + list(opp_result.warnings)
                              + list(exh_result.warnings)),
    }


def run_evening_brief(context: BriefContext, base_dir: Path, email_store=None,
                      exh_store=None, events=None) -> dict:
    """晚报：读 plan.json → 真实事件核销 → review.json（部分核销返回 partial）。"""
    d = safe_memory_dir(base_dir, context.tenant, context.company, context.date)
    plan_path = d / "plan.json"
    if not plan_path.exists():
        return {"review": None, "error": "no plan.json"}
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    evs = (events if events is not None
           else collect_completion_events(context, plan, email_store, exh_store))
    review = review_plan(plan, evs)
    atomic_write_json(d / "review.json", review)
    return {"review": review}


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Daily Brief 组合编排（Email + Opportunity + Exhibition）")
    ap.add_argument("cmd", choices=["morning", "evening"])
    ap.add_argument("--company", required=True)
    ap.add_argument("--tenant", default="meorient")
    ap.add_argument("--date", required=True)
    ap.add_argument("--out", default="data/daily-brief")
    args = ap.parse_args()

    now = _now()
    ctx = BriefContext(tenant=args.tenant, company=args.company,
                       report_type=args.cmd, date=args.date, tz="Asia/Shanghai",
                       as_of=now, window_start=now, window_end=now)
    base = Path(args.out)
    out = run_morning_brief(ctx, base) if args.cmd == "morning" else run_evening_brief(ctx, base)
    print(json.dumps(out, ensure_ascii=False, indent=2))
