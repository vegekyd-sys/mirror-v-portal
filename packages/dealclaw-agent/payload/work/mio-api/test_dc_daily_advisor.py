#!/usr/bin/env python3
"""test_dc_daily_advisor.py — Advisor 层契约 / Guard / feedback reducer 测试（标准库 unittest）

覆盖（对应最后一轮简化 8 条）：
  - Advice 契约：advice_key、confidence low/medium/high、confidence_reason、limitations；不可变
  - ProposedAction：新建议先 proposal，用户确认（authorized）后才创建正式 BriefItem
  - Guard 三拆：Decision（权限/退订/频控/幂等）、Grounding（事实/数字不改写）、Content（禁止表达只校验最终外发内容）
  - 校验返回独立 ValidationResult，不向 Advice 写违规
  - AdvisorSnapshot 只读精简快照；feedback reducer 归纳偏好（accept 不自动成为永久偏好）
  - proposal 未授权不能执行；单条违规不影响其他 proposal；内部建议不被禁止表达误伤

运行：cd work/mio-api && python3 test_dc_daily_advisor.py
"""
import os
import sys
import unittest
from dataclasses import FrozenInstanceError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_daily_advisor import (  # noqa: E402
    ProposedAction, Advice, Violation, ValidationResult, AdvisorSnapshot, GuardContext,
    DecisionGuard, GroundingGuard, ContentGuard, validate_advice,
    reduce_feedback, build_snapshot, materialize_proposal, CONFIDENCE_LEVELS,
)
from dc_daily_brief import TargetRef, EvidenceRef  # noqa: E402


def make_proposal(*, proposal_id="p1", action_type="followup", scope="global",
                  target_ids=("buyer@x.com",), reason="r", fact_refs=("sent",),
                  outbound_content=None, due_at=None, authorized=False) -> ProposedAction:
    return ProposedAction(
        proposal_id=proposal_id, action_type=action_type, scope=scope,
        target_refs=tuple(TargetRef(type="buyer", id=t) for t in target_ids),
        reason=reason, fact_refs=tuple(fact_refs),
        outbound_content=outbound_content, due_at=due_at, authorized=authorized,
    )


def make_advice(*, advice_key="a1", claim="发送 69 封", confidence="medium",
                confidence_reason="事实充分", fact_refs=("sent",),
                proposed_actions=None) -> Advice:
    return Advice(
        advice_key=advice_key, claim=claim,
        evidence_refs=(EvidenceRef(type="record", source="email_facts", id="resend_1"),),
        confidence=confidence, confidence_reason=confidence_reason,
        assumptions=("前提成立",), counter_evidence=(), limitations=("局限",),
        recommendation="建议跟进", proposed_actions=proposed_actions or (),
        action_refs=(), fact_refs=tuple(fact_refs), reason_adjusted=None,
    )


def make_ctx(*, unsubscribe=frozenset(), executed=frozenset(),
             allowed=frozenset({"followup"}), frequency=None,
             forbidden=(), facts=None) -> GuardContext:
    return GuardContext(
        unsubscribe_blocked=unsubscribe, executed_action_keys=executed,
        allowed_action_types=allowed, frequency=frequency or {},
        forbidden_expression=tuple(forbidden), facts=facts or {},
    )


class TestAdviceContract(unittest.TestCase):
    def test_confidence_levels(self):
        self.assertEqual(CONFIDENCE_LEVELS, {"low", "medium", "high"})

    def test_advice_immutable(self):
        adv = make_advice()
        with self.assertRaises(FrozenInstanceError):
            adv.confidence = "high"

    def test_advice_has_required_fields(self):
        adv = make_advice()
        self.assertTrue(adv.advice_key)
        self.assertTrue(adv.confidence_reason)
        self.assertTrue(adv.limitations)
        self.assertEqual(adv.confidence, "medium")


class TestDecisionGuard(unittest.TestCase):
    def test_permission_violation(self):
        adv = make_advice(proposed_actions=(make_proposal(action_type="invite"),))
        v = DecisionGuard().validate(adv, make_ctx(allowed=frozenset({"followup"})))
        self.assertTrue(any(x.rule == "permission" for x in v))

    def test_unsubscribe_violation(self):
        adv = make_advice(proposed_actions=(make_proposal(target_ids=("blocked@x.com",)),))
        v = DecisionGuard().validate(adv, make_ctx(unsubscribe=frozenset({"blocked@x.com"})))
        self.assertTrue(any(x.rule == "unsubscribe" for x in v))

    def test_frequency_violation(self):
        adv = make_advice(proposed_actions=(make_proposal(target_ids=("a@x.com",)),))
        v = DecisionGuard().validate(adv, make_ctx(frequency={"a@x.com": {"max": 2, "sent": 2}}))
        self.assertTrue(any(x.rule == "frequency" for x in v))

    def test_idempotency_violation(self):
        adv = make_advice(proposed_actions=(make_proposal(proposal_id="p_done"),))
        v = DecisionGuard().validate(adv, make_ctx(executed=frozenset({"p_done"})))
        self.assertTrue(any(x.rule == "idempotency" for x in v))

    def test_clean_passes(self):
        adv = make_advice(proposed_actions=(make_proposal(),))
        self.assertEqual(DecisionGuard().validate(adv, make_ctx()), ())


class TestGroundingGuard(unittest.TestCase):
    def test_fact_ref_missing(self):
        adv = make_advice(fact_refs=("sent", "ghost"))
        v = GroundingGuard().validate(adv, make_ctx(facts={"sent": 69}))
        self.assertTrue(any(x.rule == "fact_mismatch" and "ghost" in x.detail for x in v))

    def test_claim_number_not_grounded(self):
        adv = make_advice(claim="发送 70 封", fact_refs=("sent",))
        v = GroundingGuard().validate(adv, make_ctx(facts={"sent": 69}))
        self.assertTrue(any("70" in x.detail for x in v))

    def test_grounded_claim_passes(self):
        adv = make_advice(claim="发送 69 封", fact_refs=("sent",))
        self.assertEqual(GroundingGuard().validate(adv, make_ctx(facts={"sent": 69})), ())


class TestContentGuard(unittest.TestCase):
    def test_forbidden_in_outbound(self):
        adv = make_advice(proposed_actions=(make_proposal(outbound_content="保证成交"),))
        v = ContentGuard().validate(adv, make_ctx(forbidden=("保证",)))
        self.assertTrue(any(x.rule == "forbidden_expression" for x in v))

    def test_internal_advice_not_flagged(self):
        """内部建议（claim 含禁止词）不被禁止表达误伤——ContentGuard 只校验最终外发内容。"""
        adv = make_advice(claim="建议对买家保证成交", proposed_actions=(make_proposal(outbound_content=None),))
        self.assertEqual(ContentGuard().validate(adv, make_ctx(forbidden=("保证",))), ())


class TestValidateAdvice(unittest.TestCase):
    def test_returns_validation_result_not_mutate_advice(self):
        adv = make_advice(proposed_actions=(make_proposal(action_type="invite"),))
        result = validate_advice(adv, make_ctx(allowed=frozenset({"followup"})))
        self.assertIsInstance(result, ValidationResult)
        self.assertFalse(result.ok)
        # Advice 本身没有被写违规字段（不可变，无 hard_rule_violations 字段）
        self.assertFalse(hasattr(adv, "hard_rule_violations"))

    def test_single_violation_does_not_affect_others(self):
        """单条违规不影响其他 proposal：一个退订违规，另一个合规。"""
        p_bad = make_proposal(proposal_id="p_bad", target_ids=("blocked@x.com",))
        p_ok = make_proposal(proposal_id="p_ok", target_ids=("ok@x.com",))
        adv = make_advice(proposed_actions=(p_bad, p_ok))
        result = validate_advice(adv, make_ctx(unsubscribe=frozenset({"blocked@x.com"}),
                                               facts={"sent": 69}))
        self.assertEqual(len(result.violations), 1)
        self.assertTrue(result.violations[0].detail.endswith("blocked@x.com' unsubscribed"))


class TestFeedbackReducer(unittest.TestCase):
    def test_accept_not_reduced(self):
        fb = [{"advice_id": "a1", "verdict": "accept"}, {"advice_id": "a2", "verdict": "accept"}]
        self.assertEqual(reduce_feedback(fb), {})

    def test_revise_reduced(self):
        fb = [{"advice_id": "a1", "verdict": "revise", "revised": {"priority": "buyer_reply"}}]
        self.assertEqual(reduce_feedback(fb), {"revised": {"priority": "buyer_reply"}})

    def test_reject_reduced(self):
        fb = [{"advice_id": "a1", "verdict": "reject", "pattern": "cold_invite"}]
        self.assertEqual(reduce_feedback(fb), {"rejected_patterns": ["cold_invite"]})

    def test_reject_dedup(self):
        fb = [{"advice_id": "a1", "verdict": "reject", "pattern": "cold_invite"},
              {"advice_id": "a2", "verdict": "reject", "pattern": "cold_invite"}]
        self.assertEqual(reduce_feedback(fb), {"rejected_patterns": ["cold_invite"]})


class TestAdvisorSnapshot(unittest.TestCase):
    def test_snapshot_injects_preferences(self):
        """feedback reducer 归纳的偏好正确注入 AdvisorSnapshot。"""
        fb = [{"advice_id": "a1", "verdict": "revise", "revised": {"priority": "buyer_reply"}}]
        prefs = reduce_feedback(fb)
        snap = build_snapshot(tenant="t", company="c", report_type="morning", date="2026-09-10",
                              tz="Asia/Shanghai", as_of="2026-09-10T08:00:00+08:00",
                              preferences=prefs)
        self.assertEqual(snap.preferences, {"revised": {"priority": "buyer_reply"}})

    def test_snapshot_has_no_hard_rules(self):
        """AdvisorSnapshot 不含退订名单/完整 HardRules（精简快照）。"""
        snap = build_snapshot(tenant="t", company="c", report_type="morning", date="2026-09-10",
                              tz="Asia/Shanghai", as_of="2026-09-10T08:00:00+08:00")
        self.assertFalse(hasattr(snap, "unsubscribe_blocked"))
        self.assertFalse(hasattr(snap, "hard_rules"))


class TestMaterialize(unittest.TestCase):
    def test_unauthorized_proposal_returns_none(self):
        """未授权 proposal 不能执行 → materialize 返回 None。"""
        pa = make_proposal(authorized=False)
        self.assertIsNone(materialize_proposal(pa, tenant="t", company="c", opportunity="op"))

    def test_authorized_proposal_materializes(self):
        pa = make_proposal(authorized=True)
        item = materialize_proposal(pa, tenant="t", company="c", opportunity="op")
        self.assertIsNotNone(item)
        self.assertTrue(item.action_key)
        self.assertEqual(item.kind, "action")


if __name__ == "__main__":
    unittest.main(verbosity=2)
