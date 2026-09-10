#!/usr/bin/env python3
"""dc_daily_advisor.py — Advisor 层契约 + Guard + feedback reducer（不含真实 LLM 与业务 Provider）

分层（Daily Brief 契约保留在 dc_daily_brief.py）：
  Provider(事实) → 规则引擎(候选 action) → Advisor(建议 Advice) → Guard 校验 → 授权+Skill 执行
                                                        ↑
                                                  企业 Memory(用户反馈)

本阶段只落：契约（Advice/ProposedAction/ValidationResult/AdvisorSnapshot/GuardContext）、
三个 Guard（Decision/Grounding/Content）、feedback reducer、proposal 授权门控、测试。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Protocol

from dc_daily_brief import (
    EvidenceRef, FactRef, TargetRef, BriefItem,
    make_action_key, make_item_key, make_dedupe_key, normalize_targets,
)


CONFIDENCE_LEVELS = {"low", "medium", "high"}


# ── 契约 ──────────────────────────────────────────────
@dataclass(frozen=True)
class ProposedAction:
    """结构化建议动作。新建议先生成 proposal，用户确认后（authorized=True）才创建正式 BriefItem。"""
    proposal_id: str
    action_type: str
    scope: str
    target_refs: tuple[TargetRef, ...]
    reason: str
    fact_refs: tuple[str, ...]
    outbound_content: str | None = None  # 最终外发内容（ContentGuard 只校验这个）
    due_at: str | None = None
    authorized: bool = False             # 用户确认后才 True


@dataclass(frozen=True)
class Advice:
    """Advisor 的每个判断。不可变（frozen）。"""
    advice_key: str
    claim: str
    evidence_refs: tuple[EvidenceRef, ...]
    confidence: str                 # low / medium / high
    confidence_reason: str
    assumptions: tuple[str, ...]
    counter_evidence: tuple[EvidenceRef, ...]
    limitations: tuple[str, ...]
    recommendation: str
    proposed_actions: tuple[ProposedAction, ...]
    action_refs: tuple[str, ...]    # 关联候选 action_key（重排/合并）
    fact_refs: tuple[str, ...]      # 关联 fact_id（LLM 唯一可读事实）
    reason_adjusted: str | None = None


@dataclass(frozen=True)
class Violation:
    guard: str       # decision / grounding / content
    rule: str        # permission / unsubscribe / frequency / idempotency / fact_mismatch / forbidden_expression
    detail: str


@dataclass(frozen=True)
class ValidationResult:
    """独立校验结果，不向 Advice 写违规（Advice 保持不可变）。"""
    advice_key: str
    ok: bool
    violations: tuple[Violation, ...]


@dataclass(frozen=True)
class AdvisorSnapshot:
    """Advisor 只读的精简快照（不含完整 memory、退订名单、完整 HardRules）。"""
    tenant: str
    company: str
    report_type: str
    date: str
    tz: str
    as_of: str
    exhibition_stage: str | None
    company_goals: tuple[str, ...]
    preferences: dict                # 生效偏好（feedback reducer 归纳）
    candidates: tuple[BriefItem, ...]


@dataclass(frozen=True)
class GuardContext:
    """Guard 校验需要的完整规则数据（Advisor 不读，只有 Guard 读）。"""
    unsubscribe_blocked: frozenset[str] = frozenset()    # 退订邮箱
    executed_action_keys: frozenset[str] = frozenset()   # 幂等：已执行 proposal_id/action_key
    allowed_action_types: frozenset[str] = frozenset()   # 权限：允许的 action_type
    frequency: dict = field(default_factory=dict)        # 频控 {email: {"max":n,"sent":n}}
    forbidden_expression: tuple[str, ...] = ()           # 禁止表达词（只校验最终外发内容）
    facts: dict = field(default_factory=dict)            # fact_id -> 值（GroundingGuard 用）


class Advisor(Protocol):
    def advise(self, snapshot: AdvisorSnapshot) -> tuple[Advice, ...]: ...


# ── Guard ─────────────────────────────────────────────
class DecisionGuard:
    """决策硬规则：权限、退订、频控、幂等。"""

    def validate(self, advice: Advice, ctx: GuardContext) -> tuple[Violation, ...]:
        v: list[Violation] = []
        for pa in advice.proposed_actions:
            if pa.action_type not in ctx.allowed_action_types:
                v.append(Violation("decision", "permission",
                                   f"action_type {pa.action_type!r} not allowed"))
            if pa.proposal_id in ctx.executed_action_keys:
                v.append(Violation("decision", "idempotency",
                                   f"proposal {pa.proposal_id!r} already executed"))
            for tr in pa.target_refs:
                email = tr.id
                if email in ctx.unsubscribe_blocked:
                    v.append(Violation("decision", "unsubscribe",
                                       f"buyer {email!r} unsubscribed"))
                freq = ctx.frequency.get(email)
                if freq and int(freq.get("sent", 0)) >= int(freq.get("max", 0)):
                    v.append(Violation("decision", "frequency",
                                       f"buyer {email!r} over frequency limit"))
        return tuple(v)


class GroundingGuard:
    """事实依据：claim 只引用 fact_refs 指向的事实；数字不改写、不新造。"""

    def validate(self, advice: Advice, ctx: GuardContext) -> tuple[Violation, ...]:
        v: list[Violation] = []
        # 1. 引用完整性：fact_refs 的 fact_id 必须在事实库里
        for fid in advice.fact_refs:
            if fid not in ctx.facts:
                v.append(Violation("grounding", "fact_mismatch",
                                   f"fact_id {fid!r} not in facts"))
        # 2. 数字溯源：claim 里的数字必须 ⊆ fact_refs 引用的事实值
        claim_nums = set(re.findall(r"\d+", advice.claim))
        grounded_nums: set[str] = set()
        for fid in advice.fact_refs:
            val = ctx.facts.get(fid)
            if val is not None:
                grounded_nums.update(re.findall(r"\d+", str(val)))
        for n in claim_nums:
            if n not in grounded_nums:
                v.append(Violation("grounding", "fact_mismatch",
                                   f"claim number {n!r} not grounded in fact_refs"))
        return tuple(v)


class ContentGuard:
    """内容硬规则：禁止表达。只校验最终外发内容（proposal.outbound_content），不校验内部建议。"""

    def validate(self, advice: Advice, ctx: GuardContext) -> tuple[Violation, ...]:
        v: list[Violation] = []
        for pa in advice.proposed_actions:
            content = pa.outbound_content or ""
            for word in ctx.forbidden_expression:
                if word and word in content:
                    v.append(Violation("content", "forbidden_expression",
                                       f"proposal {pa.proposal_id!r} contains forbidden word {word!r}"))
        return tuple(v)


def validate_advice(advice: Advice, ctx: GuardContext) -> ValidationResult:
    """跑三个 Guard，返回独立 ValidationResult（不向 Advice 写违规）。"""
    violations: list[Violation] = []
    violations += DecisionGuard().validate(advice, ctx)
    violations += GroundingGuard().validate(advice, ctx)
    violations += ContentGuard().validate(advice, ctx)
    return ValidationResult(
        advice_key=advice.advice_key,
        ok=not violations,
        violations=tuple(violations),
    )


# ── feedback reducer ──────────────────────────────────
def reduce_feedback(feedbacks: list[dict]) -> dict:
    """把原始反馈归纳成生效偏好。普通 accept 不自动成为永久偏好。"""
    revised: dict = {}
    rejected: list[str] = []
    for fb in feedbacks:
        verdict = fb.get("verdict")
        if verdict == "revise":
            r = fb.get("revised")
            if isinstance(r, dict):
                revised.update(r)
        elif verdict == "reject":
            key = fb.get("pattern") or fb.get("advice_id")
            if key and key not in rejected:
                rejected.append(key)
        # accept：不自动归纳
    prefs: dict = {}
    if revised:
        prefs["revised"] = revised
    if rejected:
        prefs["rejected_patterns"] = rejected
    return prefs


def build_snapshot(*, tenant: str, company: str, report_type: str, date: str,
                   tz: str, as_of: str, exhibition_stage: str | None = None,
                   company_goals: tuple[str, ...] = (), preferences: dict | None = None,
                   candidates: tuple[BriefItem, ...] = ()) -> AdvisorSnapshot:
    """构造精简 AdvisorSnapshot（偏好由 feedback reducer 注入）。"""
    return AdvisorSnapshot(
        tenant=tenant, company=company, report_type=report_type, date=date,
        tz=tz, as_of=as_of, exhibition_stage=exhibition_stage,
        company_goals=tuple(company_goals), preferences=preferences or {},
        candidates=tuple(candidates),
    )


# ── proposal 授权门控 ─────────────────────────────────
def materialize_proposal(pa: ProposedAction, *, tenant: str, company: str,
                         opportunity: str) -> BriefItem | None:
    """授权后的 proposal → 正式 BriefItem + action_key。未授权返回 None（不能执行）。"""
    if not pa.authorized:
        return None
    target_id = normalize_targets([tr.id for tr in pa.target_refs])
    action_key = make_action_key(tenant=tenant, company=company, scope=pa.scope,
                                 opportunity=opportunity, action_type=pa.action_type,
                                 target_id=target_id, occurrence="1")
    item_key = make_item_key(tenant=tenant, company=company, scope=pa.scope, kind="action",
                             source="advisor", category=pa.action_type,
                             business_id=pa.proposal_id, occurrence="1")
    dedupe_key = make_dedupe_key(source="advisor", category=pa.action_type, scope=pa.scope,
                                 business_id=pa.proposal_id, occurrence="1")
    reason_facts = [FactRef(fact_id=fid, kind="text", value=fid) for fid in pa.fact_refs]
    return BriefItem(
        item_key=item_key, kind="action", dedupe_key=dedupe_key, source="advisor",
        scope=pa.scope, category=pa.action_type, priority="match", title=pa.reason,
        reason_facts=reason_facts, reason=pa.reason, target_refs=list(pa.target_refs),
        evidence_refs=[], due_at=pa.due_at, detail={},
        completion_rule=None, action_key=action_key, policy_version=None,
    )
