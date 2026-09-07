#!/usr/bin/env python3
"""
dc_priority.py — 客户跟进优先级引擎（阶段③）

把「现在先跟谁」从「冷热/阶段」里拆出来，独立成 followup_priority 三档：
  优先跟进 / 普通跟进 / 长期培育。

核心原则：
  1. 优先级 ≠ 阶段。阶段说「关系推到哪」，优先级说「现在先跟谁」。
  2. 多因子综合判断，不写死单一信号（不定「已回复=优先、待触达=长期培育」）。
  3. 每次输出证据化理由 + 可核验引用（evidence_refs）+ 缺失信号（missing_signals）。
  4. 排序前先做排除：do_not_contact 排除、lost 排除进历史、paused 不进今日行动列表、
     won 排除（已成交不催），只有 active 才参与优先级计算。
  5. 人工调整优先于自动结果；自动结果保留，不覆盖人工判断。

纯函数实现：不写文件、不调外部接口、不修改原始 interaction。

contact_policy（customer 层）：active / paused / do_not_contact
opportunity_status（opportunity 层）：active / paused / won / lost
「停止触达/暂不跟进」落在 contact_policy=do_not_contact 或 opportunity_status=paused，
不写入商机阶段（stage）、不写入优先级。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

RULE_VERSION = "1.0.0"

PRIORITY_HIGH = "优先跟进"
PRIORITY_NORMAL = "普通跟进"
PRIORITY_NURTURE = "长期培育"
PRIORITIES = (PRIORITY_HIGH, PRIORITY_NORMAL, PRIORITY_NURTURE)

CONTACT_POLICIES = ("active", "paused", "do_not_contact")
OPP_STATUSES = ("active", "paused", "won", "lost")

# 信号分组（复用 dc_opportunity_stage 的口径，补 meeting_interest 为强商务信号）
PRODUCT_NEED_TYPES = {"product_need", "needs"}
BUSINESS_INFO_TYPES = {"quantity", "usage", "budget", "timeline", "spec", "project_context"}
STRONG_COMMERCIAL_TYPES = {"quote_request", "sample_request", "contract", "payment",
                           "delivery_confirm", "next_negotiation", "commercial", "meeting_interest"}
NEGATIVE_TYPES = {"deny_need", "identity_mismatch"}

# stage 权重（推进越深，越值得优先）
STAGE_RANK = {"报价中": 5, "需求明确": 4, "已回复": 3, "已触达": 2, "待触达": 1, "": 0}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _has(v) -> bool:
    if v is None:
        return False
    if isinstance(v, bool):
        return v is True
    if isinstance(v, (int, float)):
        return True
    return str(v).strip() != ""


def _parse_dt(s) -> Optional[datetime]:
    if not s:
        return None
    if isinstance(s, datetime):
        return s
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, OSError):
        return None


def _ref(it: dict, signal: str) -> dict:
    """构造一条可核验证据引用。"""
    return {
        "interaction_id": (it or {}).get("interaction_id", ""),
        "raw_record_ref": (it or {}).get("raw_record_ref", ""),
        "signal": signal,
    }


# ─────────────────────────────────────────────────────────────
# 排除层（排序前先执行，D 要求）
# ─────────────────────────────────────────────────────────────

def _exclusion(customer: dict, opportunity: dict) -> tuple[bool, str]:
    """返回 (excluded, reason)。excluded 表示不进今日行动列表。"""
    contact_policy = (customer or {}).get("contact_policy") or "active"
    opp_status = (opportunity or {}).get("opportunity_status") or "active"

    if contact_policy == "do_not_contact":
        return True, "do_not_contact"
    if opp_status == "lost":
        return True, "lost"
    if opp_status == "won":
        return True, "won"
    if contact_policy == "paused" or opp_status == "paused":
        return True, "paused"
    return False, ""


# ─────────────────────────────────────────────────────────────
# 证据收集
# ─────────────────────────────────────────────────────────────

def _collect(interactions: list, opportunity: dict) -> dict:
    """从 interactions 收集优先级证据。返回 {strong, need, biz, negative, evidence_refs, missing}。"""
    strong: list = []
    need: list = []
    biz: list = []
    negative: list = []
    evidence_refs: list = []

    for it in interactions:
        if not isinstance(it, dict):
            continue
        for sig in (it.get("signals") or []):
            if not isinstance(sig, dict):
                continue
            stype = sig.get("type", "")
            if not _has(sig.get("value")):
                continue
            if stype in STRONG_COMMERCIAL_TYPES:
                strong.append(sig)
                evidence_refs.append(_ref(it, stype))
            elif stype in PRODUCT_NEED_TYPES:
                need.append(sig)
                evidence_refs.append(_ref(it, stype))
            elif stype in BUSINESS_INFO_TYPES:
                biz.append(sig)
                evidence_refs.append(_ref(it, stype))
            elif stype in NEGATIVE_TYPES:
                negative.append(sig)

    missing: list = []
    if not strong:
        missing.append("缺商务推进信号（报价/样品/会议意向/合同等）")
    if not need:
        missing.append("缺产品需求信号")
    if not biz:
        missing.append("缺业务信息（数量/预算/交期/规格等）")
    next_due = ((opportunity or {}).get("next_step") or {}).get("due")
    if not _has(next_due):
        missing.append("缺下一步动作/截止时间")

    return {"strong": strong, "need": need, "biz": biz, "negative": negative,
            "evidence_refs": evidence_refs, "missing": missing}


# ─────────────────────────────────────────────────────────────
# 优先级判定（多因子规则，非单一数值公式）
# ─────────────────────────────────────────────────────────────

def _judge_priority(collected: dict, opportunity: dict, now_dt: datetime) -> tuple[str, list[str]]:
    """多因子规则判定优先级。返回 (priority, reasons)。"""
    strong = collected["strong"]
    need = collected["need"]
    biz = collected["biz"]
    negative = collected["negative"]

    grade = (opportunity or {}).get("match_grade") or "待确认"
    stage = (opportunity or {}).get("stage") or ""
    next_due = ((opportunity or {}).get("next_step") or {}).get("due")

    reasons: list = []

    # 负面信号：明确拒绝/身份不匹配 → 直接降为培育，不主动追（负面信号是硬拦截，优先于一切正向）
    if negative:
        reasons.append(f"有负面信号（{'、'.join(sorted({s.get('type', '') for s in negative}))}），不主动追")
        return PRIORITY_NURTURE, reasons

    # 强商务信号 → 优先跟进
    if strong:
        sig_names = "、".join(sorted({s.get("type", "") for s in strong}))
        reasons.append(f"有强商务推进信号（{sig_names}）")
        return PRIORITY_HIGH, reasons

    # 需求明确 + 时间紧迫（下一步已到期）→ 优先跟进
    overdue = False
    if _has(next_due):
        due_dt = _parse_dt(next_due)
        if due_dt and due_dt < now_dt:
            overdue = True
            reasons.append("下一步已到期，需立即处理")
    if need and biz and overdue:
        return PRIORITY_HIGH, reasons

    # 需求明确 或 阶段已推进到报价/需求明确 → 优先跟进
    if need and biz:
        reasons.append("产品需求 + 业务信息已明确")
        return PRIORITY_HIGH, reasons
    if stage in ("报价中", "需求明确"):
        reasons.append(f"阶段已推进到「{stage}」")
        return PRIORITY_HIGH, reasons

    # 有触达/有回复/有需求（未完全明确）→ 普通跟进
    if need or stage in ("已触达", "已回复") or grade in ("A", "B"):
        reasons.append(f"匹配度 {grade} · 阶段 {stage or '未知'}，中等推进价值")
        return PRIORITY_NORMAL, reasons

    # 无触达、无信号、低匹配 → 长期培育
    reasons.append(f"匹配度 {grade} · 无强信号，长期培育")
    return PRIORITY_NURTURE, reasons


# ─────────────────────────────────────────────────────────────
# 人工覆盖（F 要求）
# ─────────────────────────────────────────────────────────────

def _apply_manual_override(auto: dict, override: dict) -> dict:
    """人工结果优先；自动结果保留在 auto_priority，不覆盖人工判断。"""
    manual_priority = override.get("priority", "")
    if manual_priority not in PRIORITIES:
        manual_priority = auto.get("priority", "")
    return {
        **auto,
        "priority": manual_priority,
        "auto_priority": auto.get("priority", ""),
        "priority_reason": override.get("reason", "") or auto.get("priority_reason", ""),
        "manual_override": {
            "priority": manual_priority,
            "by": override.get("by", ""),
            "at": override.get("at", _now()),
            "reason": override.get("reason", ""),
        },
    }


# ─────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────

def compute_lead_priority(lead: Optional[dict] = None, interactions: Optional[list] = None,
                          now: Optional[str] = None) -> dict:
    """线索池 lead → 优先级结果（桥接 evaluate_priority，阶段③双写用）。

    映射规则：
      - stage「停止触达」→ contact_policy=do_not_contact（排除，不写阶段、不写优先级）
      - stage「成交」→ opportunity_status=won（排除）
      - match_grade / next_step 若 lead 有则透传，无则留空（引擎走缺省逻辑）
      - 优先级不依赖 hot_cold（冷热 deprecated，不再作新逻辑依据）
    """
    import hashlib
    lead = lead or {}
    stage = (lead.get("stage") or "").strip()
    contact_policy = "do_not_contact" if stage == "停止触达" else "active"
    opportunity_status = "won" if stage == "成交" else "active"
    opportunity = {
        "match_grade": lead.get("match_grade") or "",
        "stage": stage,
        "opportunity_status": opportunity_status,
        "next_step": lead.get("next_step") or {},
    }
    customer = {"contact_policy": contact_policy}
    return evaluate_priority(customer, opportunity, interactions, now=now)


def apply_priorities_to_leads(leads: list, interactions_by_customer: dict = None,
                              now: Optional[str] = None) -> tuple[list, dict]:
    """对线索池 leads 批量算优先级，双写 6 个新字段。

    返回 (leads_updated, report)。report 含按 followup_priority 的排序结果：
      - order：按 followup_priority（优先/普通/培育）排序的公司名列表

    双写字段：followup_priority / priority_reason / contact_policy /
             opportunity_status / priority_rule_version / priority_updated_at
    """
    import hashlib
    interactions_by_customer = interactions_by_customer or {}
    now = now or _now()

    def _cid(lead):
        cdp = (lead.get("company_cdp_id") or "").strip()
        if cdp:
            return cdp
        return "c_" + hashlib.sha1(
            f"{(lead.get('company') or '').strip().lower()}|{(lead.get('website') or '').strip().lower()}".encode()
        ).hexdigest()[:16]

    updated = []
    for lead in leads:
        r = compute_lead_priority(
            lead, interactions_by_customer.get(_cid(lead), []), now=now)
        lead = dict(lead)
        lead["followup_priority"] = r.get("priority", "")
        lead["priority_reason"] = r.get("priority_reason", "")
        lead["contact_policy"] = "do_not_contact" if r.get("excluded_reason") == "do_not_contact" else "active"
        lead["opportunity_status"] = r.get("excluded_reason", "") if r.get("excluded_reason") in ("won", "lost", "paused") else "active"
        lead["priority_rule_version"] = r.get("rule_version", "")
        lead["priority_updated_at"] = now
        updated.append(lead)

    pri_rank = {PRIORITY_HIGH: 0, PRIORITY_NORMAL: 1, PRIORITY_NURTURE: 2}
    new_order = [l["company"] for l in sorted(updated, key=lambda x: pri_rank.get(x.get("followup_priority", ""), 99))]

    report = {
        "total": len(updated),
        "sort_field": "followup_priority",
        "order": new_order,
        "rule_version": RULE_VERSION,
    }
    return updated, report


def evaluate_priority(
    customer: Optional[dict] = None,
    opportunity: Optional[dict] = None,
    interactions: Optional[list] = None,
    previous: Optional[dict] = None,
    now: Optional[str] = None,
    manual_override: Optional[dict] = None,
) -> dict:
    """优先级判断主入口（纯函数）。

    customer       : 含 contact_policy（active/paused/do_not_contact）
    opportunity    : 含 match_grade / stage / opportunity_status / next_step.due
    interactions   : 含 signals 数组
    previous       : 上次评估结果（含 followup_priority / 人工覆盖）
    now            : ISO 时间，判断 next_step 是否到期
    manual_override: 人工调整 {priority, by, reason}
    """
    customer = customer or {}
    opportunity = opportunity or {}
    interactions = [it for it in (interactions or []) if isinstance(it, dict)]
    previous = previous or {}
    now_dt = _parse_dt(now) if now else datetime.now(timezone.utc)

    excluded, excluded_reason = _exclusion(customer, opportunity)
    collected = _collect(interactions, opportunity)

    if excluded:
        # 排除的客户仍保留优先级参考（供历史/查看），但不进今日行动列表
        priority, reasons = _judge_priority(collected, opportunity, now_dt)
        return {
            "priority": priority,
            "actionable": False,
            "excluded_reason": excluded_reason,
            "priority_reason": "；".join(reasons),
            "evidence_refs": collected["evidence_refs"],
            "missing_signals": collected["missing"],
            "rule_version": RULE_VERSION,
            "auto_priority": priority,
        }

    priority, reasons = _judge_priority(collected, opportunity, now_dt)
    result = {
        "priority": priority,
        "actionable": True,
        "excluded_reason": "",
        "priority_reason": "；".join(reasons),
        "evidence_refs": collected["evidence_refs"],
        "missing_signals": collected["missing"],
        "rule_version": RULE_VERSION,
    }

    # 历史人工覆盖优先（若 previous 里带 manual_override）
    if (previous or {}).get("manual_override") and not manual_override:
        manual_override = previous.get("manual_override")

    if manual_override:
        return _apply_manual_override(result, manual_override)
    return result


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(description="客户跟进优先级判断（纯函数，供调试）")
    ap.add_argument("--customer", default="{}", help="customer JSON")
    ap.add_argument("--opportunity", default="{}", help="opportunity JSON")
    ap.add_argument("--interactions", default="[]", help="interactions JSON 数组")
    ap.add_argument("--override", default="", help="manual_override JSON（可选）")
    args = ap.parse_args()

    result = evaluate_priority(
        json.loads(args.customer),
        json.loads(args.opportunity),
        json.loads(args.interactions),
        manual_override=json.loads(args.override) if args.override else None,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
