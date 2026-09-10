#!/usr/bin/env python3
"""dc_opportunity_provider.py — OpportunityProvider + 与 EmailProvider 的分层

目标：把 EmailProvider 的「通用批量跟进」与商机 Memory 的「客户级证据」结合，
识别真正需要优先处理的客户。

读取（商机 Memory，单一来源 dc_memory_data.read_leads / read_interactions）：
  - opportunity_status / stage / fit_grade（= match_grade）
  - next_step.action / next_step.due（兼容 next_action / due 平铺字段）
  - interactions + confirmed signals（口径复用 dc_opportunity_stage）
  - buyer reply、询价/报价、样品、数量、交期、会议承诺
  - contact_policy、渠道有效性（email_bounced / contact_invalid）

规则（对应需求 1-8）：
  1. 买家回复 / 逾期 next_step / 报价·样品承诺 → 客户级 action。
  2. 每个 action 引用 opportunity + interaction/signal 证据（evidence_refs）。
  3. suggested 信号（无 evidence_text 且非 user_confirmed）不能作为高优先级 confirmed 事实。
  4. lost / 停止触达(do_not_contact) / 退订(unsubscribed) / paused / won → 不生成发送建议。
  5. fit_grade=A 不能单独判最高优先级，必须结合行为或到期证据。
  6. 与 EmailProvider 重复时，客户级商机 action 优先，该买家从批量跟进人数中扣除。
  7. 无商机证据时保留 EmailProvider 批量行动，不虚构重点客户。
  8. Provider 只输出事实与候选 action；经营建议仍由 Advisor 负责。

纯函数 + 可注入 store：不发送、不写外部接口；collect() 只读 memory。
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

from dc_daily_brief import (
    BriefItem, BriefContext, ProviderResult, CompletionRule,
    EvidenceRef, FactRef, TargetRef,
    make_item_key, make_action_key, make_dedupe_key, normalize_targets,
)
# 信号归一化与 confirmed 资格口径复用 dc_opportunity_stage，避免两套判断。
from dc_opportunity_stage import (
    _normalize_signals, _signal_confirmed_eligible,
    COMMERCIAL_TYPES, PRODUCT_NEED_TYPES, BUSINESS_INFO_TYPES,
)

# 报价/样品/合同/交期/下一轮谈判 + 会议承诺（meeting_interest）
COMMITMENT_TYPES = set(COMMERCIAL_TYPES) | {"meeting_interest"}

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso_to_utc(iso) -> float | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


def _has(v) -> bool:
    if v is None:
        return False
    if isinstance(v, bool):
        return v is True
    if isinstance(v, (int, float)):
        return True
    return str(v).strip() != ""


def _extract_email(*texts) -> str:
    for t in texts:
        if not t:
            continue
        if isinstance(t, (list, tuple)):
            t = " ".join(str(x) for x in t)
        m = _EMAIL_RE.search(str(t))
        if m:
            return m.group(0).lower()
    return ""


def _customer_id(opp: dict) -> str:
    """稳定 customer 主键（与 dc_memory_data._customer_id 一致口径）。"""
    cdp = (opp.get("company_cdp_id") or "").strip()
    if cdp:
        return cdp
    cid = (opp.get("customer_id") or "").strip()
    if cid:
        return cid
    base = f"{(opp.get('company') or '').strip().lower()}|{(opp.get('website') or '').strip().lower()}"
    return "c_" + hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def _next_step(opp: dict) -> dict:
    """next_step.action / next_step.due，兼容 next_action / due 平铺字段。"""
    ns = opp.get("next_step")
    if isinstance(ns, dict):
        return {"action": (ns.get("action") or ns.get("next_action") or "").strip(),
                "due": (ns.get("due") or ns.get("due_at") or "").strip()}
    return {"action": (opp.get("next_action") or "").strip(),
            "due": (opp.get("due") or opp.get("due_at") or "").strip()}


def _fit_grade(opp: dict) -> str:
    return (opp.get("fit_grade") or opp.get("match_grade") or "").strip()


def _exclusion(opp: dict) -> tuple[bool, str]:
    """规则 4：lost / 停止触达 / 退订 / paused / won → 不生成发送建议。"""
    if opp.get("unsubscribed") or opp.get("opted_out"):
        return True, "unsubscribed"
    policy = (opp.get("contact_policy") or "active").strip() or "active"
    status = (opp.get("opportunity_status") or "active").strip() or "active"
    if policy == "do_not_contact":
        return True, "do_not_contact"
    if status == "lost":
        return True, "lost"
    if status == "won":
        return True, "won"
    if policy == "paused" or status == "paused":
        return True, "paused"
    return False, ""


class OpportunityMemoryStore:
    """默认数据源：读 data/memory 的 leads + interactions。"""

    def list_opportunities(self, company_id: str) -> list[dict]:
        from dc_memory_data import read_leads
        return read_leads(company_id) or []

    def list_interactions(self, company_id: str) -> list[dict]:
        from dc_memory_data import read_interactions
        return read_interactions(company_id) or []


def collect_evidence(opp: dict, interactions: list, now_ts: float) -> dict:
    """收集单个客户的客户级证据（纯函数）。

    返回：
      replies      买家回复（inbound/bidirectional/has_reply）→ confirmed
      commitments  confirmed 强商务/承诺信号（报价/样品/合同/交期/会议承诺）
      suggested    仅有 suggested 资格的承诺信号（无 evidence_text 且非 user_confirmed）
      support      产品需求/业务信息（数量/交期/预算…）支持事实
      overdue      逾期 next_step（due 已过）
      latest       最近一次 interaction（用于 overdue 的引用）
    """
    replies: list = []
    commitments: list = []
    suggested: list = []
    support: list = []
    latest = None
    for it in sorted((i for i in interactions if isinstance(i, dict)),
                     key=lambda x: str(x.get("occurred_at") or "")):
        latest = it
        if (it.get("direction") in ("inbound", "bidirectional")
                or it.get("has_reply") is True or it.get("replied")):
            replies.append(it)
        warnings: list = []
        for sig in _normalize_signals(it, warnings):
            if not _has(sig.get("value")):
                continue
            stype = sig.get("type") or ""
            if stype in COMMITMENT_TYPES:
                (commitments if _signal_confirmed_eligible(sig) else suggested).append((it, stype))
            elif stype in (PRODUCT_NEED_TYPES | BUSINESS_INFO_TYPES):
                support.append((it, stype))

    ns = _next_step(opp)
    due_ts = _parse_iso_to_utc(ns.get("due"))
    overdue = bool(due_ts is not None and due_ts < now_ts)
    return {"replies": replies, "commitments": commitments, "suggested": suggested,
            "support": support, "overdue": overdue, "next_step": ns, "latest": latest}


def _candidate(evidence: dict) -> dict | None:
    """规则 1 + 5：只有行为/到期/已确认承诺才生成客户级 action。

    action_type 由最强可执行证据决定（已确认报价/样品承诺 → quote/sample，否则 followup）；
    priority 按紧迫度取最高：逾期 > 买家回复 > 承诺（对齐 PRIORITY_ORDER）。
    fit_grade=A 单独（无行为/到期/承诺证据）不生成 action。
    """
    has_commit = bool(evidence["commitments"])
    if has_commit:
        types = {t for _, t in evidence["commitments"]}
        if "sample_request" in types and "quote_request" not in types:
            action_type, completion, trigger = "sample", "sample_sent", "sample_commitment"
        else:
            action_type, completion, trigger = "quote", "quote_sent", "quote_commitment"
    else:
        action_type, completion, trigger = "followup", "followup_sent", ""

    if evidence["overdue"]:
        priority = "overdue"
        trigger = trigger or "next_step_overdue"
    elif evidence["replies"]:
        priority = "buyer_reply"
        trigger = trigger or "buyer_reply"
    elif has_commit:
        priority = "commitment"
    else:
        return None  # 无行为/到期/已确认承诺证据 → 不虚构重点客户
    return {"trigger": trigger, "priority": priority,
            "action_type": action_type, "completion": completion}


def _build_action(context: BriefContext, opp: dict, buyer_email: str, cand: dict,
                  evidence: dict) -> BriefItem:
    cid = _customer_id(opp)
    company = (opp.get("company") or "").strip() or buyer_email or cid
    grade = _fit_grade(opp)
    stage = (opp.get("stage") or "").strip()
    target = buyer_email or cid

    # ── 规则 2：opportunity 证据 + interaction/signal 证据，缺一不可 ──
    evidence_refs = [EvidenceRef(type="record", source="opportunity", id=cid)]
    reason_facts = [FactRef(fact_id="company", kind="entity", value=company)]
    if stage:
        reason_facts.append(FactRef(fact_id="stage", kind="text", value=stage))
    if grade:
        reason_facts.append(FactRef(fact_id="fit_grade", kind="text", value=grade))

    if cand["trigger"] == "buyer_reply":
        it = evidence["replies"][-1]
        iid = it.get("interaction_id") or it.get("source_record_id") or cid
        evidence_refs.append(EvidenceRef(type="record", source="interaction", id=iid))
        reason_facts.append(FactRef(fact_id="buyer_reply", kind="text", value=iid))
        title = f"回复买家 {company}"
        reason = f"{company} 已回复（证据 {iid}），需优先响应跟进"
    elif cand["trigger"] == "next_step_overdue":
        ns = evidence["next_step"]
        evidence_refs.append(EvidenceRef(type="record", source="opportunity_next_step",
                                         id=f"{cid}:next_step"))
        reason_facts.append(FactRef(fact_id="next_step_due", kind="time", value=ns.get("due")))
        latest = evidence.get("latest")
        if latest is not None:
            iid = latest.get("interaction_id") or latest.get("source_record_id") or ""
            if iid:
                evidence_refs.append(EvidenceRef(type="record", source="interaction", id=iid))
        title = f"逾期跟进 {company}"
        reason = (f"{company} 下一步「{ns.get('action') or '待办'}」已于 {ns.get('due')} 到期，"
                  f"需立即处理")
    else:  # quote_commitment / sample_commitment
        it, stype = evidence["commitments"][0]
        iid = it.get("interaction_id") or it.get("source_record_id") or cid
        evidence_refs.append(EvidenceRef(type="record", source="signal", id=f"{iid}:{stype}"))
        reason_facts.append(FactRef(fact_id="commitment", kind="text", value=stype))
        if stype == "sample_request":
            title = f"发送样品 {company}"
            reason = f"{company} 已有 confirmed 样品承诺信号（{stype}，证据 {iid}）"
        else:
            title = f"发送报价 {company}"
            reason = f"{company} 已有 confirmed 报价承诺信号（{stype}，证据 {iid}）"

    action_key = make_action_key(tenant=context.tenant, company=context.company,
                                 scope="global", opportunity=cid,
                                 action_type=cand["action_type"],
                                 target_id=normalize_targets([target]), occurrence="1")
    item_key = make_item_key(tenant=context.tenant, company=context.company, scope="global",
                             kind="action", source="opportunity", category=cand["action_type"],
                             business_id=normalize_targets([target]), occurrence="1")
    dedupe_key = make_dedupe_key(source="opportunity", category=cand["action_type"],
                                 scope="global", business_id=normalize_targets([target]),
                                 occurrence="1")
    if cand["trigger"] == "next_step_overdue":
        due_at = evidence["next_step"].get("due") or _now_iso()
    else:
        due_at = _now_iso()
    return BriefItem(
        item_key=item_key, kind="action", dedupe_key=dedupe_key, source="opportunity",
        scope="global", category=cand["action_type"], priority=cand["priority"], title=title,
        reason_facts=reason_facts, reason=reason,
        target_refs=[TargetRef(type="buyer", id=target)],
        evidence_refs=evidence_refs, due_at=due_at,
        detail={"customer_id": cid, "company": company, "trigger": cand["trigger"],
                "buyer_email": buyer_email, "fit_grade": grade, "stage": stage,
                "evidence_level": "confirmed"},
        completion_rule=CompletionRule(type=cand["completion"],
                                       params={"target_ids": [target]}, expected_count=1),
        action_key=action_key, policy_version=None,
    )


class OpportunityProvider:
    """从商机 Memory 读客户级证据，产出客户级候选 action（只输出事实，不做经营建议）。"""
    name = "opportunity"

    def __init__(self, store=None):
        self._store = store

    def _get_store(self):
        return self._store if self._store is not None else OpportunityMemoryStore()

    def collect(self, context: BriefContext) -> ProviderResult:
        try:
            store = self._get_store()
            opportunities = store.list_opportunities(context.company)
            interactions = store.list_interactions(context.company)
        except Exception as e:  # noqa: BLE001
            return ProviderResult(name=self.name, items=[], updated_at="",
                                  warnings=[], errors=[f"{type(e).__name__}: {e}"])

        by_customer: dict[str, list] = {}
        for it in interactions:
            if not isinstance(it, dict):
                continue
            cid = (it.get("customer_id") or "").strip()
            if cid:
                by_customer.setdefault(cid, []).append(it)

        now_ts = datetime.now(timezone.utc).timestamp()
        actions: list[BriefItem] = []
        excluded: list[str] = []
        suggested_only = 0
        total = 0
        for opp in opportunities:
            if not isinstance(opp, dict):
                continue
            total += 1
            excluded_flag, reason = _exclusion(opp)
            if excluded_flag:
                excluded.append(reason)
                continue
            cid = _customer_id(opp)
            buyer_email = _extract_email(opp.get("buyer_email"), opp.get("email"),
                                         opp.get("contact"))
            ev = collect_evidence(opp, by_customer.get(cid, []), now_ts)
            cand = _candidate(ev)
            if cand is None:
                if ev["suggested"]:
                    suggested_only += 1
                continue  # 规则 7：无证据不虚构重点客户（不升级 fit_grade=A 单独项）
            actions.append(_build_action(context, opp, buyer_email, cand, ev))

        items = [self._make_result(context, total, len(actions), excluded, suggested_only)]
        items += actions
        items.append(self._make_insight(context, len(actions), excluded))
        return ProviderResult(name=self.name, items=items, updated_at=_now_iso(),
                              warnings=[], errors=[])

    def _make_result(self, context, total, n_actions, excluded, suggested_only) -> BriefItem:
        facts = [FactRef(fact_id="opportunities", kind="number", value=total),
                 FactRef(fact_id="with_evidence", kind="number", value=n_actions),
                 FactRef(fact_id="excluded", kind="number", value=len(excluded))]
        return BriefItem(
            item_key=make_item_key(tenant=context.tenant, company=context.company,
                                   scope="global", kind="result", source="opportunity",
                                   category="metrics", business_id="metrics", occurrence="1"),
            kind="result",
            dedupe_key=make_dedupe_key(source="opportunity", category="metrics", scope="global",
                                       business_id="metrics", occurrence="1"),
            source="opportunity", scope="global", category="metrics", priority="match",
            title=f"商机 {total} · 有客户级证据 {n_actions} · 已排除 {len(excluded)}",
            reason_facts=facts,
            reason=f"商机 {total} 家，有客户级证据 {n_actions} 家，已排除 {len(excluded)} 家",
            target_refs=[],
            evidence_refs=[EvidenceRef(type="snapshot", source="opportunity_memory",
                                       id=f"{context.company}:opportunities")],
            due_at=None,
            detail={"total": total, "with_evidence": n_actions,
                    "excluded": len(excluded), "suggested_only": suggested_only},
            completion_rule=None, action_key=None, policy_version=None,
        )

    def _make_insight(self, context, n_actions, excluded) -> BriefItem:
        if n_actions:
            text = f"{n_actions} 家有客户级商机证据（回复/逾期/承诺），进入优先跟进"
        else:
            text = "无客户级商机证据，保留批量跟进待分层"
        if excluded:
            text += f"；{len(excluded)} 家已排除（lost/停止触达/退订/暂停）"
        return BriefItem(
            item_key=make_item_key(tenant=context.tenant, company=context.company,
                                   scope="global", kind="insight", source="opportunity",
                                   category="insight", business_id="insight", occurrence="1"),
            kind="insight",
            dedupe_key=make_dedupe_key(source="opportunity", category="insight", scope="global",
                                       business_id="insight", occurrence="1"),
            source="opportunity", scope="global", category="insight", priority="match",
            title=text, reason_facts=[FactRef(fact_id="insight", kind="text", value=text)],
            reason=text, target_refs=[],
            evidence_refs=[EvidenceRef(type="snapshot", source="opportunity_memory",
                                       id=f"{context.company}:opportunities")],
            due_at=None, detail={}, completion_rule=None, action_key=None, policy_version=None,
        )


# ── 规则 6：客户级商机 action 优先，买家从通用批量跟进人数中扣除 ──
def layer_batch_followup(context: BriefContext, email_items: list,
                         opp_actions: list) -> tuple[list, dict]:
    """把客户级商机 action 命中的买家，从 EmailProvider 的通用批量跟进中扣除。

    返回 (email_items_after, info)。info = {batch_layered, deducted_emails, remaining_count}。
    无商机证据（opp_actions 空）时不改批量行动（规则 7）。
    """
    opp_emails = set()
    for a in opp_actions:
        for tr in a.target_refs:
            if "@" in (tr.id or ""):
                opp_emails.add(tr.id.strip().lower())
    info = {"batch_layered": False, "deducted_emails": [], "remaining_count": None}
    if not opp_emails:
        return list(email_items), info

    out: list = []
    for it in email_items:
        is_batch = (it.kind == "action" and it.source == "email"
                    and it.category == "followup" and it.detail.get("pending_layering"))
        if not is_batch:
            out.append(it)
            continue
        targets = list(it.detail.get("buyer_emails") or [])
        keep = [t for t in targets if t.strip().lower() not in opp_emails]
        deducted = [t for t in targets if t.strip().lower() in opp_emails]
        info["batch_layered"] = True
        info["deducted_emails"] = deducted
        info["remaining_count"] = len(keep)
        if not keep:
            continue  # 全部被客户级 action 覆盖 → 不再需要批量项
        out.append(_rebuild_batch(context, it, keep, deducted))
    return out, info


def _rebuild_batch(context: BriefContext, original: BriefItem, keep: list,
                   deducted: list) -> BriefItem:
    n = len(keep)
    business_id = normalize_targets(keep)
    return BriefItem(
        item_key=make_item_key(tenant=context.tenant, company=context.company, scope="global",
                               kind="action", source="email", category="followup",
                               business_id=business_id, occurrence="1"),
        kind="action",
        dedupe_key=make_dedupe_key(source="email", category="followup", scope="global",
                                   business_id=business_id, occurrence="1"),
        source="email", scope="global", category="followup",
        priority="match",  # 分层后为最低一档：客户级 action 优先
        title=f"跟进 {n} 家（待分层批量跟进）",
        reason_facts=[FactRef(fact_id="layered_count", kind="number", value=n),
                      FactRef(fact_id="deducted_count", kind="number", value=len(deducted)),
                      FactRef(fact_id="wait_state", kind="text", value="超过观察期仍无回复，且无商机证据")],
        reason=f"{n} 家送达超过观察期仍无回复、无商机级证据，保留为待分层批量跟进",
        target_refs=[TargetRef(type="buyer", id=t) for t in keep],
        evidence_refs=list(original.evidence_refs), due_at=original.due_at,
        detail={"overdue_count": n, "buyer_emails": keep, "pending_layering": False,
                "layered_out": deducted},
        completion_rule=CompletionRule(type="followup_sent",
                                       params={"target_ids": keep}, expected_count=n),
        action_key=make_action_key(tenant=context.tenant, company=context.company,
                                   scope="global", opportunity="global", action_type="followup",
                                   target_id=business_id, occurrence="1"),
        policy_version=None,
    )


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(description="OpportunityProvider（纯函数，供调试）")
    ap.add_argument("--company", required=True)
    ap.add_argument("--tenant", default="meorient")
    ap.add_argument("--date", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    args = ap.parse_args()

    ctx = BriefContext(tenant=args.tenant, company=args.company, report_type="morning",
                       date=args.date, tz="Asia/Shanghai", as_of=_now_iso(),
                       window_start="", window_end="")
    res = OpportunityProvider().collect(ctx)
    print(json.dumps({"errors": res.errors,
                      "actions": [{"title": a.title, "priority": a.priority,
                                   "category": a.category, "reason": a.reason}
                                  for a in res.items if a.kind == "action"]},
                     ensure_ascii=False, indent=2))
