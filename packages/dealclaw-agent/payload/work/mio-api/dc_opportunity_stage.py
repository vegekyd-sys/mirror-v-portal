#!/usr/bin/env python3
"""
dc_opportunity_stage.py — 展会商机阶段判断引擎

根据 opportunity 的提炼字段和 interactions 原始记录，为展会商机提出阶段建议。
规则负责校验证据，Agent 负责理解上下文；判断可解释、可修正、不编造。

纯函数实现：不写文件、不调外部接口、不修改原始 interaction。

信号数据契约（canonical signals）：
  interaction.signals 是结构化信号数组，每条含 type / value / normalized_value /
  evidence_text / confidence / origin / extractor_version / extracted_at。
  - evidence_text 是原文证据句，找不到（空）时该信号不能标记 confirmed。
  - origin=user_confirmed 优先于 agent_extracted。
  - confidence 只表示提取可信度，不等于商机等级或成交概率。
  - 旧平铺字段（product_need/quantity/quote_request 等）经 normalization adapter 兼容，
    并输出 deprecated 提示，方便迁移。
  - summary 只用于展示，绝不作为 confirmed 硬证据。

stage（5 个，从低到高）：
  已接触 → 已留资 → 已沟通 → 需求明确 → 商务跟进
报价状态 / 成交 / 失单 / 暂停 放独立字段 opportunity_status，不塞进 stage。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

RULE_VERSION = "1.1.0"

STAGES = ["已接触", "已留资", "已沟通", "需求明确", "商务跟进"]
STAGE_RANK = {s: i for i, s in enumerate(STAGES)}

VALID_SOURCES = {"meeting", "card", "onsite", "email", "whatsapp", "translation", "scan"}
VALID_STATUS = {"confirmed", "suggested", "insufficient", "conflicted"}
VALID_OPP_STATUS = {"active", "paused", "won", "lost"}
VALID_ORIGINS = {"agent_extracted", "user_confirmed", "system"}

# signal type 语义分组
PRODUCT_NEED_TYPES = {"product_need", "needs"}
BUSINESS_INFO_TYPES = {"quantity", "usage", "budget", "timeline", "spec", "project_context"}
COMMERCIAL_TYPES = {"quote_request", "sample_request", "contract", "payment", "delivery_confirm", "next_negotiation", "commercial"}
NEGATIVE_TYPES = {"deny_need", "identity_mismatch"}
STATUS_TYPES = {"delayed", "cancelled", "won", "deal_closed"}
CONTACT_TYPES = {"email_bounced", "contact_invalid"}
KNOWN_TYPES = PRODUCT_NEED_TYPES | BUSINESS_INFO_TYPES | COMMERCIAL_TYPES | NEGATIVE_TYPES | STATUS_TYPES | CONTACT_TYPES

# origin 优先级（user_confirmed 最高）
ORIGIN_PRIORITY = {"user_confirmed": 3, "system": 2, "agent_extracted": 1}

# 旧平铺字段 → canonical signal type（兼容层，deprecated）
LEGACY_FIELD_TO_TYPE = {
    "product_need": "product_need",
    "needs": "product_need",
    "quantity": "quantity",
    "usage": "usage",
    "budget": "budget",
    "timeline": "timeline",
    "spec": "spec",
    "project_context": "project_context",
    "quote_request": "quote_request",
    "sample_request": "sample_request",
    "contract": "contract",
    "payment": "payment",
    "delivery_confirm": "delivery_confirm",
    "next_negotiation": "next_negotiation",
    "commercial": "commercial",
    "deny_need": "deny_need",
    "identity_mismatch": "identity_mismatch",
    "delayed": "delayed",
    "cancelled": "cancelled",
    "won": "won",
    "deal_closed": "won",
    "bounced": "email_bounced",
    "contact_invalid": "contact_invalid",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _has(v) -> bool:
    """非空且非空白字符串；数字 0 视为有值；False 视为无值。"""
    if v is None:
        return False
    if isinstance(v, bool):
        return v is True
    if isinstance(v, (int, float)):
        return True
    return str(v).strip() != ""


def _ev(it: dict, signal: str, source: str, confirmed: bool = True, origin: str = "") -> dict:
    """构造一条证据（引用 interaction_id / raw_record_ref，保证可核验）。"""
    e = {
        "interaction_id": (it or {}).get("interaction_id", ""),
        "raw_record_ref": (it or {}).get("raw_record_ref", ""),
        "signal": signal,
        "source": source,
        "confirmed": confirmed,
    }
    if origin:
        e["origin"] = origin
    return e


# ─────────────────────────────────────────────────────────────
# normalization adapter（canonical signals 优先 + 旧字段兼容）
# ─────────────────────────────────────────────────────────────

def _normalize_signals(interaction: dict, warnings: list) -> list:
    """归一化单个 interaction 的信号：优先 canonical signals 数组，兼容旧平铺字段。

    返回 signal 列表。旧平铺字段转成 signal 时带 deprecated 标记 + 无 evidence_text。
    """
    signals: list = []
    # 1. canonical signals 数组
    for s in interaction.get("signals") or []:
        if not isinstance(s, dict):
            warnings.append({
                "type": "invalid_signal",
                "interaction_id": interaction.get("interaction_id", ""),
                "detail": "signal 非对象，已忽略",
            })
            continue
        stype = s.get("type", "")
        if stype not in KNOWN_TYPES:
            warnings.append({
                "type": "unknown_signal",
                "interaction_id": interaction.get("interaction_id", ""),
                "signal_type": stype,
                "detail": "未知 signal type，已忽略（不影响判断）",
            })
            continue
        signals.append(s)

    # 2. 旧平铺字段兼容（deprecated）
    for field, stype in LEGACY_FIELD_TO_TYPE.items():
        val = interaction.get(field)
        if not _has(val):
            continue
        if any(s.get("type") == stype for s in signals):
            continue  # canonical 已有同 type，跳过 legacy
        signals.append({
            "type": stype,
            "value": val,
            "normalized_value": "",
            "evidence_text": "",
            "confidence": None,
            "origin": "agent_extracted",
            "extractor_version": "legacy",
            "extracted_at": "",
            "deprecated": True,
        })
        warnings.append({
            "type": "deprecated_field",
            "interaction_id": interaction.get("interaction_id", ""),
            "field": field,
            "detail": f"旧平铺字段「{field}」已废弃，请迁移到 signals 数组",
        })
    return signals


def _signal_confirmed_eligible(sig: dict) -> bool:
    """signal 是否具备 confirmed 资格。

    - origin=user_confirmed：用户确认是可核验证据 → confirmed 资格。
    - agent_extracted / system：必须有 evidence_text（原文证据句）→ confirmed 资格。
    - 若带 evidence_verified 标记（ingest 链路做原文定位校验后的结果），优先用：
      evidence_verified=False 时即使 evidence_text 非空也不能 confirmed。
    """
    if not _has(sig.get("value")):
        return False
    origin = sig.get("origin") or "agent_extracted"
    if origin == "user_confirmed":
        return True
    if "evidence_verified" in sig:
        return bool(sig.get("evidence_verified")) and _has(sig.get("evidence_text"))
    return _has(sig.get("evidence_text"))


def _best_signal(signals: list, types: set) -> Optional[dict]:
    """从 signals 里取「匹配 type 且 value 非空」的最高 origin 信号（user_confirmed 优先）。"""
    matched = [s for s in signals if s.get("type") in types and _has(s.get("value"))]
    if not matched:
        return None
    return max(matched, key=lambda s: ORIGIN_PRIORITY.get(s.get("origin") or "agent_extracted", 0))


# ─────────────────────────────────────────────────────────────
# 证据收集
# ─────────────────────────────────────────────────────────────

def _collect_evidence(interactions: list) -> tuple:
    """从原始互动收集证据。返回 (evidence_by_stage, negative, contact_reachability, warnings)。"""
    result: dict[str, list] = {s: [] for s in STAGES}
    negative: list = []
    contact = {"email": "unknown", "phone": "unknown", "whatsapp": "unknown"}
    warnings: list = []

    for it in interactions:
        if not isinstance(it, dict):
            continue
        source = str(it.get("source") or "").lower()
        signals = _normalize_signals(it, warnings)

        # 已接触：扫码 / 到展 / 现场接触（source 客观事实，天然 confirmed）
        if source in ("onsite", "scan"):
            result["已接触"].append(_ev(it, "现场接触/扫码", source, confirmed=True))

        # 已留资：有效名片或可识别联系方式（source + 联系方式字段客观）
        if source == "card" and (_has(it.get("email")) or _has(it.get("phone")) or _has(it.get("contact_id"))):
            result["已留资"].append(_ev(it, "有效名片/联系方式", source, confirmed=True))

        # 已沟通：有效会议 / 邮件回复 / WhatsApp 双向（source + 方向客观）
        if source == "meeting":
            result["已沟通"].append(_ev(it, "有效会议", source, confirmed=True))
        elif source == "email" and (it.get("replied") or it.get("direction") == "in" or it.get("inbound")):
            result["已沟通"].append(_ev(it, "邮件回复", source, confirmed=True))
        elif source == "whatsapp" and (it.get("bidirectional") or it.get("direction") == "in" or it.get("inbound")):
            result["已沟通"].append(_ev(it, "WhatsApp 双向沟通", source, confirmed=True))

        # 需求明确：product_need + 业务信息（数量/用途/预算/交期/规格/项目背景 至少一项）
        pn = _best_signal(signals, PRODUCT_NEED_TYPES)
        biz = _best_signal(signals, BUSINESS_INFO_TYPES)
        if pn and biz:
            confirmed = _signal_confirmed_eligible(pn) and _signal_confirmed_eligible(biz)
            origin = pn.get("origin") or biz.get("origin") or "agent_extracted"
            result["需求明确"].append(_ev(it, "产品需求+业务信息", source, confirmed=confirmed, origin=origin))

        # 商务跟进：报价/样品/合同/付款/交期确认/下一轮谈判
        comm = _best_signal(signals, COMMERCIAL_TYPES)
        if comm:
            confirmed = _signal_confirmed_eligible(comm)
            result["商务跟进"].append(_ev(it, "商务推进信号", source, confirmed=confirmed, origin=comm.get("origin") or ""))

        # 负面信号：否认需求 / 身份不匹配
        for sig in signals:
            if sig.get("type") in NEGATIVE_TYPES and _has(sig.get("value")):
                negative.append(_ev(it, sig.get("type"), source, confirmed=True, origin=sig.get("origin") or ""))

        # 联系人可达性：email_bounced / contact_invalid（不影响 stage，不直接 lost）
        for sig in signals:
            if sig.get("type") == "email_bounced" and _has(sig.get("value")):
                contact["email"] = "invalid"
            elif sig.get("type") == "contact_invalid":
                val = sig.get("value")
                if isinstance(val, dict):
                    channel = str(val.get("channel", "")).lower()
                else:
                    channel = str(val or sig.get("channel") or "").lower()
                if channel in contact:
                    contact[channel] = "invalid"

    return result, negative, contact, warnings


def _collect_extracted_signals(opportunity: dict) -> dict:
    """从 opportunity.extracted 提取软信号（无 interaction 引用，仅作 suggested 依据）。"""
    extracted = opportunity.get("extracted") or {}
    signals: dict[str, list] = {s: [] for s in STAGES}

    has_product = _has(extracted.get("needs")) or _has(extracted.get("product_need"))
    if has_product and any(_has(extracted.get(k)) for k in BUSINESS_INFO_TYPES):
        signals["需求明确"].append({
            "interaction_id": "",
            "raw_record_ref": "",
            "signal": "提炼字段：产品需求 + 业务信息",
            "source": "extracted",
            "confirmed": False,
        })

    if _has(extracted.get("quote_status")) or any(_has(extracted.get(k)) for k in COMMERCIAL_TYPES):
        signals["商务跟进"].append({
            "interaction_id": "",
            "raw_record_ref": "",
            "signal": "提炼字段：报价/商务推进",
            "source": "extracted",
            "confirmed": False,
        })

    return signals


# ─────────────────────────────────────────────────────────────
# 冲突 / 机会状态
# ─────────────────────────────────────────────────────────────

def _collect_conflicts(evidence_by_stage: dict, negative: list) -> list:
    """多来源证据冲突：正面信号 vs 负面信号（否认需求/身份不匹配）。"""
    conflicts: list = []
    if not negative:
        return conflicts

    has_positive = any(evidence_by_stage.get(s) for s in ("已沟通", "需求明确", "商务跟进"))
    if has_positive:
        for neg in negative:
            conflicts.append({
                "type": "evidence_conflict",
                "interaction_id": neg.get("interaction_id", ""),
                "raw_record_ref": neg.get("raw_record_ref", ""),
                "detail": "同时存在正面需求信号与负面信号（否认需求/身份不匹配）",
            })
    return conflicts


def _judge_opportunity_status(interactions: list, opportunity: dict, previous: dict) -> str:
    """机会状态：延期→paused，取消/否认需求→lost，成交→won；默认沿用历史或 active。

    注意：email_bounced / contact_invalid 不直接改 opportunity_status（只标记联系人可达性）。
    """
    warnings: list = []
    for it in interactions:
        if not isinstance(it, dict):
            continue
        for sig in _normalize_signals(it, warnings):
            stype = sig.get("type")
            if not _has(sig.get("value")):
                continue
            if stype in ("cancelled", "deny_need"):
                return "lost"
            if stype == "delayed":
                return "paused"
            if stype in ("won", "deal_closed"):
                return "won"

    opp = opportunity.get("opportunity_status") or opportunity.get("status")
    if opp in VALID_OPP_STATUS:
        return opp
    prev = (previous or {}).get("opportunity_status")
    if prev in VALID_OPP_STATUS:
        return prev
    return "active"


# ─────────────────────────────────────────────────────────────
# 阶段提议 / 状态判定
# ─────────────────────────────────────────────────────────────

def _propose_stage(evidence_by_stage: dict, extracted_signals: dict) -> tuple[str, list[str]]:
    """计算 proposed_stage = 最高有硬证据或软信号支持的 stage。"""
    triggered: list[str] = []
    proposed: Optional[str] = None
    for stage in STAGES:
        hard = evidence_by_stage.get(stage, [])
        soft = extracted_signals.get(stage, [])
        if hard:
            triggered.append(f"{stage}:硬证据")
            proposed = stage
        elif soft:
            triggered.append(f"{stage}:软信号")
            proposed = stage
    return proposed or "", triggered


def _judge_status(
    proposed: str,
    evidence_by_stage: dict,
    extracted_signals: dict,
    conflicts: list,
) -> tuple[str, list[str]]:
    """判定 confirmed / suggested / insufficient / conflicted，并给出 missing 说明。"""
    if conflicts:
        return "conflicted", ["存在证据冲突，需人工仲裁"]

    hard_any = any(evidence_by_stage.get(s) for s in STAGES)
    soft_any = any(extracted_signals.get(s) for s in STAGES)

    if not hard_any and not soft_any:
        return "insufficient", ["无任何原始记录或提炼字段证据，不升级"]

    if proposed and evidence_by_stage.get(proposed):
        # 硬证据存在，但要确认 proposed 的证据是否 confirmed（有 evidence_text 或 user_confirmed）
        hard_confirmed = [e for e in evidence_by_stage.get(proposed, []) if e.get("confirmed")]
        if hard_confirmed:
            return "confirmed", []
        return "suggested", [f"阶段「{proposed}」的证据缺少原文 evidence_text，暂标 suggested"]

    if proposed and extracted_signals.get(proposed):
        return "suggested", [f"阶段「{proposed}」仅有提炼字段、无原始记录引用"]

    return "suggested", []


def _max_stage(proposed: str, previous: dict) -> str:
    """历史最高阶段：不因回退/延期而降低。"""
    prev = (previous or {}).get("max_stage_reached") or (previous or {}).get("effective_stage") or ""
    candidates = [s for s in (proposed, prev) if s in STAGE_RANK]
    if not candidates:
        return proposed or ""
    return max(candidates, key=lambda s: STAGE_RANK[s])


def _apply_manual_override(
    opportunity: dict, interactions: list, previous: dict, override: dict
) -> dict:
    """人工修正优先于自动判断；保留原自动判断 + 修改人/时间/原因。"""
    auto = evaluate_stage(opportunity, interactions, previous, None)
    manual_stage = override.get("stage", "")
    if manual_stage not in STAGE_RANK:
        manual_stage = auto.get("effective_stage", "")
    return {
        **auto,
        "proposed_stage": auto.get("proposed_stage", ""),
        "effective_stage": manual_stage,
        "status": "confirmed",
        "manual_override": {
            "stage": manual_stage,
            "by": override.get("by", ""),
            "at": override.get("at", _now()),
            "reason": override.get("reason", ""),
            "original_auto_stage": auto.get("proposed_stage", ""),
        },
        "triggered_rules": ["manual_override"],
    }


# ─────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────

def evaluate_stage(
    opportunity: Optional[dict] = None,
    interactions: Optional[list] = None,
    previous_evaluation: Optional[dict] = None,
    manual_override: Optional[dict] = None,
) -> dict:
    """阶段判断主入口（纯函数）。"""
    opportunity = opportunity or {}
    interactions = [it for it in (interactions or []) if isinstance(it, dict)]
    previous_evaluation = previous_evaluation or {}

    if manual_override:
        return _apply_manual_override(opportunity, interactions, previous_evaluation, manual_override)

    hard, negative, contact, warnings = _collect_evidence(interactions)
    soft = _collect_extracted_signals(opportunity)

    conflicts = _collect_conflicts(hard, negative)
    proposed, triggered = _propose_stage(hard, soft)
    status, missing = _judge_status(proposed, hard, soft, conflicts)

    max_stage = _max_stage(proposed, previous_evaluation)
    opp_status = _judge_opportunity_status(interactions, opportunity, previous_evaluation)

    effective = proposed if status == "confirmed" else (previous_evaluation.get("effective_stage") or proposed)

    evidence = []
    for s in STAGES:
        for e in hard.get(s, []):
            evidence.append({**e, "stage": s})

    return {
        "proposed_stage": proposed,
        "effective_stage": effective,
        "status": status,
        "evidence": evidence,
        "missing": missing,
        "conflicts": conflicts,
        "max_stage_reached": max_stage,
        "opportunity_status": opp_status,
        "contact_reachability": contact,
        "warnings": warnings,
        "triggered_rules": triggered,
        "rule_version": RULE_VERSION,
        "evaluated_at": _now(),
    }


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(description="展会商机阶段判断（纯函数，供调试）")
    ap.add_argument("--opportunity", default="{}", help="opportunity JSON")
    ap.add_argument("--interactions", default="[]", help="interactions JSON 数组")
    ap.add_argument("--previous", default="{}", help="previous_evaluation JSON")
    ap.add_argument("--override", default="", help="manual_override JSON（可选）")
    args = ap.parse_args()

    result = evaluate_stage(
        json.loads(args.opportunity),
        json.loads(args.interactions),
        json.loads(args.previous),
        json.loads(args.override) if args.override else None,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
