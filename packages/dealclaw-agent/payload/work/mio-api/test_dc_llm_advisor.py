#!/usr/bin/env python3
"""test_dc_llm_advisor.py — LLM Advisor 影子模式测试（标准库 unittest）

覆盖需求 7/8/10/11：
  - 异常返回：超时 / 429 / 5xx / HTML / 非法 JSON / 字段缺失 / Token 超限 → 降级 TemplateAdvisor
  - 事实幻觉：引用未知 fact_id → GroundingGuard 违规 → fallback
  - 决策违规：未授权 action_type → DecisionGuard 违规 → fallback
  - 过期 Snapshot：回显 snapshot_hash 不匹配 → 拦截
  - 幂等：同 snapshot_hash+model+prompt_version → 命中缓存、不再调用
  - 租户隔离：evals 路径按 tenant/company 隔离、拒绝穿越
  - 未授权 Proposal：authorized 强制 false、materialize 返回 None、不执行
  - 限权输入：≤10 候选 / ≤30 事实 / 无退订名单、无完整 Memory
  - 排序差异与指标记录

运行：cd work/mio-api && python3 test_dc_llm_advisor.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_daily_brief import BriefItem, CompletionRule, EvidenceRef, FactRef, TargetRef  # noqa: E402
from dc_daily_advisor import Advice, ProposedAction, build_snapshot, materialize_proposal  # noqa: E402
from dc_llm_advisor import (  # noqa: E402
    LLMAdvisor, LLMAdvisorError, MockLLMClient, ShadowRunner, bounded_input, snapshot_hash,
    parse_advices, compress_advices, ERROR_TIMEOUT, ERROR_RATE_LIMIT, ERROR_SERVER, ERROR_HTML,
    ERROR_INVALID_JSON, ERROR_MISSING_FIELD, ERROR_TOKEN_LIMIT, ERROR_GUARD, ERROR_STALE,
    MAX_CANDIDATES, MAX_FACTS, MAX_ADVICES, MAX_CLAIM_CHARS, MAX_RECOMMENDATION_CHARS,
)


def item(cat, prio, target, fact, source="opportunity", action_key=None):
    return BriefItem(
        item_key=f"ik_{cat}_{target}", kind="action", dedupe_key=f"dk_{cat}_{target}",
        source=source, scope="global", category=cat, priority=prio, title=f"t {cat} {target}",
        reason_facts=[FactRef(fact_id=fact, kind="text", value="v")], reason="r",
        target_refs=[TargetRef(type="buyer", id=target)],
        evidence_refs=[EvidenceRef(type="record", source="s", id=f"e_{target}")],
        due_at="2026-09-11T10:00:00+08:00", detail={"customer_id": target},
        completion_rule=CompletionRule(type="followup_sent",
                                       params={"target_ids": [target]}, expected_count=1),
        action_key=action_key or f"ak_{cat}_{target}", policy_version=None)


def make_snapshot(cands=2, category="followup"):
    cands = [item(category, "overdue", f"b{i}@x.com", f"f{i}") for i in range(cands)]
    return build_snapshot(tenant="meorient", company="C1", report_type="morning",
                          date="2026-09-11", tz="Asia/Shanghai",
                          as_of="2026-09-11T08:00:00+08:00", exhibition_stage="live",
                          preferences={"revised": {"tone": "short"}}, candidates=tuple(cands))


def template_advices():
    a = Advice(advice_key="adv_t1", claim="建议跟进", evidence_refs=(), confidence="medium",
               confidence_reason="模板", assumptions=(), counter_evidence=(), limitations=(),
               recommendation="跟进", proposed_actions=(), action_refs=("ak_followup_b0@x.com",),
               fact_refs=("f0",))
    return (a,)


def good_content(extra_fact="f0", action_type="followup"):
    return json.dumps({"advices": [{
        "advice_key": "llm_1", "claim": "先跟 A", "confidence": "medium",
        "confidence_reason": "基于事实", "assumptions": [], "counter_evidence": [],
        "limitations": [], "recommendation": "跟进 A",
        "evidence_refs": [{"type": "record", "source": "s", "id": "e_b0@x.com"}],
        "proposed_actions": [{"proposal_id": "p1", "action_type": action_type, "scope": "global",
                              "target_refs": [{"type": "buyer", "id": "b0@x.com"}],
                              "reason": "r", "fact_refs": [extra_fact]}],
        "action_refs": ["ak_followup_b0@x.com"], "fact_refs": [extra_fact]}]}, ensure_ascii=False)


class TestErrorFallback(unittest.TestCase):
    """需求 7：任一失败降级 TemplateAdvisor，不影响日报。"""

    def _run(self, client):
        snap = make_snapshot()
        tmp = Path(tempfile.mkdtemp(prefix="dc-llm-"))
        return ShadowRunner(tmp, LLMAdvisor(client)).run(snap, template_advices())

    def test_timeout(self):
        r = self._run(MockLLMClient(exc=LLMAdvisorError(ERROR_TIMEOUT, "x")))
        self.assertTrue(r["fallback"]); self.assertEqual(r["fallback_reason"], ERROR_TIMEOUT)

    def test_rate_limit_429(self):
        r = self._run(MockLLMClient(exc=LLMAdvisorError(ERROR_RATE_LIMIT, "429")))
        self.assertEqual(r["fallback_reason"], ERROR_RATE_LIMIT)

    def test_server_5xx(self):
        r = self._run(MockLLMClient(exc=LLMAdvisorError(ERROR_SERVER, "503")))
        self.assertEqual(r["fallback_reason"], ERROR_SERVER)

    def test_token_limit(self):
        r = self._run(MockLLMClient(exc=LLMAdvisorError(ERROR_TOKEN_LIMIT, "ctx")))
        self.assertEqual(r["fallback_reason"], ERROR_TOKEN_LIMIT)

    def test_html_response(self):
        r = self._run(MockLLMClient("<html><body>oops</body></html>"))
        self.assertEqual(r["fallback_reason"], ERROR_HTML)

    def test_invalid_json(self):
        r = self._run(MockLLMClient("not json at all"))
        self.assertEqual(r["fallback_reason"], ERROR_INVALID_JSON)

    def test_missing_field(self):
        bad = json.dumps({"advices": [{"advice_key": "x"}]})  # 缺 claim 等
        r = self._run(MockLLMClient(bad))
        self.assertEqual(r["fallback_reason"], ERROR_MISSING_FIELD)

    def test_unexpected_exception(self):
        r = self._run(MockLLMClient(exc=RuntimeError("boom")))
        self.assertTrue(r["fallback"])

    def test_ok_path(self):
        r = self._run(MockLLMClient(good_content()))
        self.assertTrue(r["ok"]); self.assertFalse(r["fallback"])
        self.assertEqual(r["parse_status"], "ok")


class TestGuards(unittest.TestCase):
    def _run(self, content):
        snap = make_snapshot()
        tmp = Path(tempfile.mkdtemp(prefix="dc-llm-"))
        return ShadowRunner(tmp, LLMAdvisor(MockLLMClient(content))).run(snap, template_advices())

    def test_fact_hallucination_falls_back(self):
        r = self._run(good_content(extra_fact="HALLUCINATED"))
        self.assertTrue(r["fallback"])
        self.assertEqual(r["fallback_reason"], ERROR_GUARD)
        self.assertTrue(any(v["guard"] == "grounding" for v in r["guard_violations"]))

    def test_decision_violation_falls_back(self):
        r = self._run(good_content(action_type="send_spam"))
        self.assertTrue(r["fallback"])
        self.assertTrue(any(v["guard"] == "decision" and v["rule"] == "permission"
                            for v in r["guard_violations"]))


class TestStaleAndIdempotency(unittest.TestCase):
    def test_stale_snapshot_intercepted(self):
        snap = make_snapshot()
        tmp = Path(tempfile.mkdtemp(prefix="dc-llm-"))
        client = MockLLMClient(good_content())
        # 让客户端回显一个过期的 snapshot_hash
        client.complete = lambda prompt, **kw: {"content": good_content(),
                                                "snapshot_hash": "OUTDATED", "input_tokens": 1,
                                                "output_tokens": 1}
        r = ShadowRunner(tmp, LLMAdvisor(client)).run(snap, template_advices())
        self.assertTrue(r["fallback"])
        self.assertEqual(r["fallback_reason"], ERROR_STALE)

    def test_idempotent_no_second_call(self):
        snap = make_snapshot()
        tmp = Path(tempfile.mkdtemp(prefix="dc-llm-"))
        client = MockLLMClient(good_content())
        runner = ShadowRunner(tmp, LLMAdvisor(client))
        r1 = runner.run(snap, template_advices())
        r2 = runner.run(snap, template_advices())
        self.assertEqual(client.calls, 1)          # 第二次命中缓存
        self.assertTrue(r2["cached"])
        self.assertEqual(r1["snapshot_hash"], r2["snapshot_hash"])

    def test_snapshot_hash_changes_with_model(self):
        payload = bounded_input(make_snapshot())
        self.assertNotEqual(snapshot_hash(payload, "m1", "1.0.0"),
                            snapshot_hash(payload, "m2", "1.0.0"))
        self.assertNotEqual(snapshot_hash(payload, "m1", "1.0.0"),
                            snapshot_hash(payload, "m1", "2.0.0"))


class TestUnauthorizedProposal(unittest.TestCase):
    def test_authorized_forced_false_and_no_materialize(self):
        content = json.dumps({"advices": [{
            "advice_key": "llm_1", "claim": "c", "confidence": "low", "confidence_reason": "r",
            "assumptions": [], "counter_evidence": [], "limitations": [], "recommendation": "rec",
            "evidence_refs": [], "action_refs": ["ak_followup_b0@x.com"], "fact_refs": ["f0"],
            "proposed_actions": [{"proposal_id": "p1", "action_type": "followup", "scope": "global",
                                  "target_refs": [{"type": "buyer", "id": "b0@x.com"}],
                                  "reason": "r", "fact_refs": ["f0"], "authorized": True}]}]})
        advices = parse_advices(content)
        pa = advices[0].proposed_actions[0]
        self.assertFalse(pa.authorized)                 # 强制 false
        self.assertIsNone(materialize_proposal(pa, tenant="meorient", company="C1",
                                               opportunity="op"))  # 未授权不能 materialize

    def test_runner_records_unauthorized_proposals(self):
        snap = make_snapshot()
        tmp = Path(tempfile.mkdtemp(prefix="dc-llm-"))
        r = ShadowRunner(tmp, LLMAdvisor(MockLLMClient(good_content()))).run(snap, template_advices())
        for a in r["advices"]:
            for p in a["proposed_actions"]:
                self.assertFalse(p["authorized"])


class TestInputBoundary(unittest.TestCase):
    def test_candidates_and_facts_capped(self):
        snap = make_snapshot(cands=25)
        payload = bounded_input(snap)
        self.assertEqual(len(payload["candidates"]), MAX_CANDIDATES)
        self.assertLessEqual(len(payload["facts"]), MAX_FACTS)

    def test_no_forbidden_payload_keys(self):
        payload = bounded_input(make_snapshot())
        blob = json.dumps(payload, ensure_ascii=False).lower()
        for forbidden in ("unsubscribe", "退订", "raw_email", "meeting_transcript", "full_memory"):
            self.assertNotIn(forbidden, blob)
        self.assertIn("exhibition_stage", payload)
        self.assertIn("preferences", payload)
        self.assertIn("template_advice", payload)


class TestTenantIsolation(unittest.TestCase):
    def test_eval_path_isolated_by_tenant_company(self):
        snap = make_snapshot()
        tmp = Path(tempfile.mkdtemp(prefix="dc-llm-"))
        ShadowRunner(tmp, LLMAdvisor(MockLLMClient(good_content()))).run(snap, template_advices())
        files = list(tmp.rglob("*.json"))
        self.assertTrue(files)
        self.assertTrue(any("meorient" in str(f) and "C1" in str(f) for f in files))

    def test_path_traversal_rejected(self):
        snap = build_snapshot(tenant="../evil", company="C1", report_type="morning",
                              date="2026-09-11", tz="Asia/Shanghai", as_of="x",
                              preferences={}, candidates=())
        tmp = Path(tempfile.mkdtemp(prefix="dc-llm-"))
        with self.assertRaises(ValueError):
            ShadowRunner(tmp, LLMAdvisor(MockLLMClient(good_content()))).run(snap, ())


class TestOrderDiffAndMetrics(unittest.TestCase):
    def test_order_diff_recorded(self):
        snap = make_snapshot(cands=2)
        tmp = Path(tempfile.mkdtemp(prefix="dc-llm-"))
        # 模板建议 a；LLM 建议 b → 排序差异应记录
        tmpl = (Advice(advice_key="adv_t", claim="c", evidence_refs=(), confidence="medium",
                       confidence_reason="r", assumptions=(), counter_evidence=(), limitations=(),
                       recommendation="rec", proposed_actions=(),
                       action_refs=("ak_followup_b0@x.com",), fact_refs=("f0",)),)
        r = ShadowRunner(tmp, LLMAdvisor(MockLLMClient(good_content()))).run(snap, tmpl)
        self.assertTrue(r["order_diff"])
        self.assertIn("latency_ms", r)
        self.assertIn("input_tokens", r)
        self.assertIn("output_tokens", r)

    def test_metrics_present_on_fallback(self):
        snap = make_snapshot()
        tmp = Path(tempfile.mkdtemp(prefix="dc-llm-"))
        r = ShadowRunner(tmp, LLMAdvisor(MockLLMClient(exc=LLMAdvisorError(ERROR_TIMEOUT, "x")))).run(
            snap, template_advices())
        self.assertEqual(r["parse_status"], ERROR_TIMEOUT)
        self.assertIn("fallback_reason", r)


class TestCompression(unittest.TestCase):
    def _advice(self, key, claim, rec, action_refs=()):
        return Advice(advice_key=key, claim=claim, evidence_refs=(), confidence="medium",
                      confidence_reason="r", assumptions=(), counter_evidence=(), limitations=(),
                      recommendation=rec, proposed_actions=(), action_refs=tuple(action_refs),
                      fact_refs=())

    def test_empty_array_allowed(self):
        self.assertEqual(parse_advices('{"advices": []}'), ())
        self.assertEqual(compress_advices(())[0], ())

    def test_cap_at_three(self):
        claims = ["优先跟进已回复客户", "发送正式报价", "跟进样品寄送",
                  "处理退信邮箱", "培育长期客户", "确认会议时间"]
        advs = tuple(self._advice(f"k{i}", claims[i], f"rec{i}", [f"a{i}"]) for i in range(6))
        out, stats = compress_advices(advs)
        self.assertEqual(len(out), MAX_ADVICES)
        self.assertEqual(stats["dropped_over_cap"], 3)

    def test_truncate_claim_and_recommendation(self):
        adv = self._advice("k", "x" * 200, "y" * 300, ["a"])
        out, stats = compress_advices((adv,))
        self.assertEqual(len(out[0].claim), MAX_CLAIM_CHARS)
        self.assertEqual(len(out[0].recommendation), MAX_RECOMMENDATION_CHARS)
        self.assertEqual(stats["truncated"], 1)

    def test_merge_similar_by_action_ref(self):
        a = self._advice("a", "跟进 A", "跟进", ["ak1"])
        b = self._advice("b", "跟进 B", "跟进", ["ak1"])
        out, stats = compress_advices((a, b))
        self.assertEqual(len(out), 1)
        self.assertEqual(stats["merged_count"], 1)

    def test_merge_similar_by_claim_jaccard(self):
        a = self._advice("a", "优先跟进已回复客户", "r", ["ak1"])
        b = self._advice("b", "优先跟进已回复客户", "r", ["ak2"])
        out, _ = compress_advices((a, b))
        self.assertEqual(len(out), 1)

    def test_distinct_kept(self):
        a = self._advice("a", "跟进 A", "r", ["ak1"])
        b = self._advice("b", "完全不同的一件事", "r", ["ak2"])
        out, _ = compress_advices((a, b))
        self.assertEqual(len(out), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
