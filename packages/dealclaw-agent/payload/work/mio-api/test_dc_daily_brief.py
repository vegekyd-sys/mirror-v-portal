#!/usr/bin/env python3
"""test_dc_daily_brief.py — Daily Brief Engine 契约与纯函数测试（标准库 unittest）

覆盖（对应修订清单）：
  - 契约校验：action 强制 due_at + completion_rule；evidence_refs / reason_facts 非空
  - key 生成：item_key / action_key / dedupe_key；occurrence 区分轮次；policy_version 不参与幂等
  - 排序：固定映射 + 跨时区 due_at
  - 去重：action 去重（action_key）与展示去重（dedupe_key，逾期不吞）
  - 早报 plan top N + 晚报真实核销（done/partial/unresolved/skipped/failed + expected_count）
  - 路径安全（防穿越）+ 跨 tenant/company 隔离 + 原子写入
  - Provider 异常包装

运行：cd work/mio-api && python3 test_dc_daily_brief.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_daily_brief import (  # noqa: E402
    BriefItem, BriefContext, CompletionRule, EvidenceRef, FactRef, TargetRef,
    ProviderResult, make_item_key, make_action_key, make_dedupe_key,
    validate_brief_item, sort_items, dedupe_actions, dedupe_display,
    build_plan, review_plan, safe_memory_dir, atomic_write_json, safe_collect,
    normalize_targets, next_revision, write_plan,
    PRIORITY_ORDER,
)


def make_item(*, kind="action", source="email", scope="global", category="followup",
              priority="deadline", occurrence="1", business_id="b1",
              tenant="t1", company="c1", opportunity="op1", action_type="followup",
              target_id=None, due_at="2026-09-11T10:00:00+08:00",
              completion_type="reply_received", expected_count=1) -> BriefItem:
    """快速构造合法 BriefItem。"""
    target_id = target_id or business_id
    item_key = make_item_key(tenant=tenant, company=company, scope=scope, kind=kind,
                             source=source, category=category, business_id=business_id,
                             occurrence=occurrence)
    action_key = None
    completion = None
    if kind == "action":
        action_key = make_action_key(tenant=tenant, company=company, scope=scope,
                                     opportunity=opportunity, action_type=action_type,
                                     target_id=target_id, occurrence=occurrence)
        completion = CompletionRule(type=completion_type,
                                    params={"resend_id": f"r_{business_id}"},
                                    expected_count=expected_count)
    dedupe_key = make_dedupe_key(source=source, category=category, scope=scope,
                                 business_id=business_id, occurrence=occurrence)
    return BriefItem(
        item_key=item_key, kind=kind, dedupe_key=dedupe_key, source=source, scope=scope,
        category=category, priority=priority, title=f"title {business_id}",
        reason_facts=[FactRef(fact_id="buyer", kind="entity", value=f"buyer{business_id}")],
        reason=f"reason {business_id}",
        target_refs=[TargetRef(type="buyer", id=target_id)],
        evidence_refs=[EvidenceRef(type="record", source="email_facts", id=f"resend_{business_id}")],
        due_at=due_at, detail={}, completion_rule=completion,
        action_key=action_key, policy_version="v1",
    )


class TestKeyGen(unittest.TestCase):
    def test_item_key_stable(self):
        a = make_item_key(tenant="t", company="c", scope="g", kind="action",
                          source="email", category="followup", business_id="b", occurrence="1")
        b = make_item_key(tenant="t", company="c", scope="g", kind="action",
                          source="email", category="followup", business_id="b", occurrence="1")
        self.assertEqual(a, b)

    def test_action_key_distinguishes_occurrence(self):
        """相同业务（同 target_id + action_type）不同轮次 → 不同 action_key，不误去重。"""
        k1 = make_action_key(tenant="t", company="c", scope="g", opportunity="op",
                             action_type="followup", target_id="buyer1", occurrence="1")
        k2 = make_action_key(tenant="t", company="c", scope="g", opportunity="op",
                             action_type="followup", target_id="buyer1", occurrence="2")
        self.assertNotEqual(k1, k2)

    def test_action_key_distinguishes_action_type(self):
        """相同业务 ID（target_id）不同 action_type → 不同 action_key。"""
        k1 = make_action_key(tenant="t", company="c", scope="g", opportunity="op",
                             action_type="followup", target_id="buyer1", occurrence="1")
        k2 = make_action_key(tenant="t", company="c", scope="g", opportunity="op",
                             action_type="invite", target_id="buyer1", occurrence="1")
        self.assertNotEqual(k1, k2)

    def test_action_key_distinguishes_target(self):
        k1 = make_action_key(tenant="t", company="c", scope="g", opportunity="op",
                             action_type="followup", target_id="buyer1", occurrence="1")
        k2 = make_action_key(tenant="t", company="c", scope="g", opportunity="op",
                             action_type="followup", target_id="buyer2", occurrence="1")
        self.assertNotEqual(k1, k2)

    def test_dedupe_key_readable(self):
        dk = make_dedupe_key(source="email", category="followup", scope="g",
                             business_id="b", occurrence="1")
        self.assertEqual(dk, "email:followup:g:b:1")

    def test_policy_version_not_in_action_key(self):
        """policy_version 是 BriefItem 独立字段，不参与 action_key（make_action_key 无此参数）。"""
        a = make_item(business_id="x")
        b = make_item(business_id="x")
        b.policy_version = "v99"
        self.assertEqual(a.action_key, b.action_key)
        self.assertNotEqual(a.policy_version, b.policy_version)


class TestValidate(unittest.TestCase):
    def test_valid_action_passes(self):
        self.assertEqual(validate_brief_item(make_item()), [])

    def test_action_requires_due_at(self):
        it = make_item(due_at=None)
        errs = validate_brief_item(it)
        self.assertTrue(any("due_at" in e for e in errs))

    def test_action_requires_completion_rule(self):
        it = make_item()
        it.completion_rule = None
        errs = validate_brief_item(it)
        self.assertTrue(any("completion_rule" in e for e in errs))

    def test_action_requires_action_key(self):
        it = make_item()
        it.action_key = None
        errs = validate_brief_item(it)
        self.assertTrue(any("action_key" in e for e in errs))

    def test_empty_evidence_refs_rejected(self):
        it = make_item()
        it.evidence_refs = []
        errs = validate_brief_item(it)
        self.assertTrue(any("evidence" in e for e in errs))

    def test_empty_reason_facts_rejected(self):
        it = make_item()
        it.reason_facts = []
        errs = validate_brief_item(it)
        self.assertTrue(any("reason_facts" in e for e in errs))

    def test_non_action_no_due_at_ok(self):
        it = make_item(kind="insight", due_at=None)
        self.assertEqual(validate_brief_item(it), [])

    def test_query_evidence_allows_missing_field(self):
        """query 型 evidence 可表达「已检查但字段缺失」。"""
        it = make_item(kind="insight", due_at=None)
        it.evidence_refs = [EvidenceRef(type="query", source="kb", id="doc1", missing="字段缺失")]
        self.assertEqual(validate_brief_item(it), [])


class TestSort(unittest.TestCase):
    def test_priority_order(self):
        items = [make_item(priority=p, business_id=f"b{i}")
                 for i, p in enumerate(["match", "deadline", "overdue", "commitment", "buyer_reply"])]
        got = [it.priority for it in sort_items(items)]
        self.assertEqual(got, ["overdue", "buyer_reply", "commitment", "deadline", "match"])

    def test_same_priority_due_ascending(self):
        a = make_item(due_at="2026-09-11T10:00:00+08:00", business_id="a")
        b = make_item(due_at="2026-09-10T10:00:00+08:00", business_id="b")
        got = [it.business_id if hasattr(it, "business_id") else it.title
               for it in sort_items([a, b])]
        self.assertEqual([it.dedupe_key.split(":")[-2] for it in sort_items([a, b])], ["b", "a"])

    def test_cross_timezone_due_sort(self):
        """跨时区：东八区 10 点（UTC 02:00）应早于西三区 10 点（UTC 13:00）。"""
        east = make_item(due_at="2026-09-11T10:00:00+08:00", business_id="east")
        west = make_item(due_at="2026-09-11T10:00:00-03:00", business_id="west")
        got = [it.dedupe_key.split(":")[-2] for it in sort_items([west, east])]
        self.assertEqual(got, ["east", "west"])

    def test_none_due_last(self):
        a = make_item(due_at=None, kind="insight", business_id="a")
        b = make_item(due_at="2026-09-11T10:00:00+08:00", business_id="b")
        got = [it.dedupe_key.split(":")[-2] for it in sort_items([a, b])]
        self.assertEqual(got, ["b", "a"])


class TestDedupe(unittest.TestCase):
    def test_action_dedupe_same_key(self):
        a = make_item(business_id="x")
        b = make_item(business_id="x")  # 同 target/action_type/occurrence → 同 action_key
        self.assertEqual(a.action_key, b.action_key)
        self.assertEqual(len(dedupe_actions([a, b])), 1)

    def test_action_dedupe_keeps_different_occurrence(self):
        """相同业务 ID 不同轮次不误去重（修订第 10 条）。"""
        a = make_item(business_id="x", occurrence="1")
        b = make_item(business_id="x", occurrence="2")
        self.assertNotEqual(a.action_key, b.action_key)
        self.assertEqual(len(dedupe_actions([a, b])), 2)

    def test_display_dedupe_keeps_overdue(self):
        """专项卡提醒过的逾期任务仍进早报（修订第 5 条）。"""
        it = make_item(priority="overdue")
        self.assertEqual(len(dedupe_display([it], {it.dedupe_key})), 1)

    def test_display_dedupe_removes_non_overdue(self):
        it = make_item(priority="deadline")
        self.assertEqual(len(dedupe_display([it], {it.dedupe_key})), 0)


class TestPlan(unittest.TestCase):
    def test_build_plan_top3(self):
        items = [make_item(priority=p, business_id=f"b{i}")
                 for i, p in enumerate(["deadline", "overdue", "match", "buyer_reply", "commitment"])]
        plan = build_plan(items, max_actions=3)
        self.assertEqual(len(plan["actions"]), 3)
        self.assertEqual(plan["actions"][0]["priority"], "overdue")
        self.assertEqual(plan["actions"][1]["priority"], "buyer_reply")
        self.assertEqual(plan["actions"][2]["priority"], "commitment")

    def test_build_plan_context_holds_non_action(self):
        items = [make_item(kind="action"), make_item(kind="insight", due_at=None)]
        plan = build_plan(items)
        self.assertEqual(len(plan["actions"]), 1)
        self.assertEqual(len(plan["context"]), 1)
        self.assertEqual(plan["context"][0]["kind"], "insight")


class TestReview(unittest.TestCase):
    def _action_dict(self, **kw):
        it = make_item(**kw)
        return {
            "action_key": it.action_key,
            "completion_rule": {"type": it.completion_rule.type,
                                "params": it.completion_rule.params,
                                "expected_count": it.completion_rule.expected_count},
        }

    def test_review_done(self):
        a = self._action_dict()
        events = [{"action_key": a["action_key"], "kind": "reply", "resend_id": "r_b1"}]
        self.assertEqual(review_plan({"actions": [a]}, events)["reviews"][0]["status"], "done")

    def test_review_partial(self):
        a = self._action_dict(expected_count=3)
        events = [{"action_key": a["action_key"], "kind": "reply", "resend_id": "r_b1"}]
        self.assertEqual(review_plan({"actions": [a]}, events)["reviews"][0]["status"], "partial")

    def test_review_unresolved(self):
        a = self._action_dict()
        self.assertEqual(review_plan({"actions": [a]}, [])["reviews"][0]["status"], "unresolved")

    def test_review_skipped(self):
        a = self._action_dict()
        events = [{"action_key": a["action_key"], "status": "skipped"}]
        self.assertEqual(review_plan({"actions": [a]}, events)["reviews"][0]["status"], "skipped")

    def test_review_failed(self):
        a = self._action_dict()
        events = [{"action_key": a["action_key"], "status": "failed"}]
        self.assertEqual(review_plan({"actions": [a]}, events)["reviews"][0]["status"], "failed")

    def test_review_wrong_action_key_ignored(self):
        """真实核销：只有匹配 action_key 的事件才算数。"""
        a = self._action_dict()
        events = [{"action_key": "other-key", "kind": "reply", "resend_id": "r_b1"}]
        self.assertEqual(review_plan({"actions": [a]}, events)["reviews"][0]["status"], "unresolved")


class TestPathSafety(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="dc-brief-test-")

    def test_safe_path(self):
        p = safe_memory_dir(Path(self._tmp), "t1", "c1", "2026-09-10")
        self.assertEqual(str(p), str(Path(self._tmp) / "t1" / "c1" / "2026-09-10"))

    def test_path_traversal_rejected(self):
        with self.assertRaises(ValueError):
            safe_memory_dir(Path(self._tmp), "../evil", "c1", "2026-09-10")
        with self.assertRaises(ValueError):
            safe_memory_dir(Path(self._tmp), "t1", "..", "2026-09-10")

    def test_invalid_date_rejected(self):
        with self.assertRaises(ValueError):
            safe_memory_dir(Path(self._tmp), "t1", "c1", "2026/09/10")

    def test_cross_company_isolated(self):
        p1 = safe_memory_dir(Path(self._tmp), "t1", "c1", "2026-09-10")
        p2 = safe_memory_dir(Path(self._tmp), "t1", "c2", "2026-09-10")
        self.assertNotEqual(p1, p2)


class TestAtomicWrite(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="dc-brief-test-"))

    def test_roundtrip(self):
        p = self._tmp / "plan.json"
        atomic_write_json(p, {"a": 1, "b": "x"})
        import json
        self.assertEqual(json.loads(p.read_text(encoding="utf-8")), {"a": 1, "b": "x"})

    def test_no_temp_leftover(self):
        p = self._tmp / "plan.json"
        atomic_write_json(p, {"a": 1})
        leftovers = list(self._tmp.glob(".tmp-*"))
        self.assertEqual(leftovers, [])


class TestProviderWrapper(unittest.TestCase):
    def test_safe_collect_ok(self):
        class OkProvider:
            name = "ok"
            def collect(self, ctx):
                return ProviderResult(name="ok", items=[], updated_at="", warnings=[], errors=[])
        ctx = BriefContext(tenant="t", company="c", report_type="morning", date="2026-09-10",
                           tz="Asia/Shanghai", as_of="2026-09-10T00:00:00+08:00",
                           window_start="2026-09-10T00:00:00+08:00", window_end="2026-09-10T23:59:59+08:00")
        r = safe_collect(OkProvider(), ctx)
        self.assertEqual(r.errors, [])

    def test_safe_collect_exception(self):
        class BadProvider:
            name = "bad"
            def collect(self, ctx):
                raise RuntimeError("boom")
        ctx = BriefContext(tenant="t", company="c", report_type="morning", date="2026-09-10",
                           tz="Asia/Shanghai", as_of="2026-09-10T00:00:00+08:00",
                           window_start="2026-09-10T00:00:00+08:00", window_end="2026-09-10T23:59:59+08:00")
        r = safe_collect(BadProvider(), ctx)
        self.assertEqual(r.items, [])
        self.assertTrue(any("RuntimeError" in e for e in r.errors))


class TestMultiTarget(unittest.TestCase):
    def test_normalize_targets_order_independent(self):
        self.assertEqual(normalize_targets(["a", "b"]), normalize_targets(["b", "a"]))

    def test_normalize_targets_dedup(self):
        self.assertEqual(normalize_targets(["a", "a", "b"]), normalize_targets(["a", "b"]))

    def test_normalize_targets_no_collision(self):
        self.assertNotEqual(normalize_targets(["a", "b"]), normalize_targets(["a", "c"]))

    def test_action_key_multi_target_stable(self):
        """多 target 聚合行动：同集合（顺序无关）→ 同 action_key；异集合 → 不误撞。"""
        k1 = make_action_key(tenant="t", company="c", scope="g", opportunity="op",
                             action_type="followup", target_id=normalize_targets(["x", "y"]),
                             occurrence="1")
        k2 = make_action_key(tenant="t", company="c", scope="g", opportunity="op",
                             action_type="followup", target_id=normalize_targets(["y", "x"]),
                             occurrence="1")
        self.assertEqual(k1, k2)
        k3 = make_action_key(tenant="t", company="c", scope="g", opportunity="op",
                             action_type="followup", target_id=normalize_targets(["x", "z"]),
                             occurrence="1")
        self.assertNotEqual(k1, k3)


class TestReviewEdges(unittest.TestCase):
    def _action_dict(self, **kw):
        it = make_item(**kw)
        return {
            "action_key": it.action_key,
            "completion_rule": {"type": it.completion_rule.type,
                                "params": it.completion_rule.params,
                                "expected_count": it.completion_rule.expected_count},
        }

    def test_duplicate_event_not_double_counted(self):
        """重复 event 不重复计数：expected_count=2，同一 reply 出现两次 → partial 非 done。"""
        a = self._action_dict(expected_count=2)
        dup = {"action_key": a["action_key"], "kind": "reply", "resend_id": "r_b1"}
        events = [dup, dup]
        self.assertEqual(review_plan({"actions": [a]}, events)["reviews"][0]["status"], "partial")

    def test_stale_event_cannot_review_new_plan(self):
        """旧事件（occurred_at 早于 plan.created_at）不能核销新计划。"""
        a = self._action_dict()
        plan = {"actions": [a], "created_at": "2026-09-10T12:00:00+00:00"}
        old = {"action_key": a["action_key"], "kind": "reply", "resend_id": "r_b1",
               "occurred_at": "2026-09-10T11:00:00+00:00"}
        self.assertEqual(review_plan(plan, [old])["reviews"][0]["status"], "unresolved")
        fresh = {"action_key": a["action_key"], "kind": "reply", "resend_id": "r_b1",
                 "occurred_at": "2026-09-10T13:00:00+00:00"}
        self.assertEqual(review_plan(plan, [fresh])["reviews"][0]["status"], "done")

    def test_unknown_completion_type_unresolved_warning(self):
        """未知 completion_rule.type → unresolved + warning。"""
        action = {"action_key": "k1",
                  "completion_rule": {"type": "mystery", "params": {}, "expected_count": 1}}
        result = review_plan({"actions": [action]}, [])
        self.assertEqual(result["reviews"][0]["status"], "unresolved")
        self.assertTrue(any("mystery" in w for w in result["warnings"]))


class TestRevision(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="dc-brief-test-"))

    def test_first_write_revision_1(self):
        p = self._tmp / "plan.json"
        out = write_plan(p, {"actions": []})
        self.assertEqual(out["revision"], 1)
        import json
        self.assertEqual(json.loads(p.read_text(encoding="utf-8"))["revision"], 1)

    def test_second_write_revision_increments(self):
        p = self._tmp / "plan.json"
        first = write_plan(p, {"actions": []})
        second = write_plan(p, {"actions": []}, existing_plan=first)
        self.assertEqual(first["revision"], 1)
        self.assertEqual(second["revision"], 2)
        import json
        self.assertEqual(json.loads(p.read_text(encoding="utf-8"))["revision"], 2)

    def test_next_revision(self):
        self.assertEqual(next_revision(None), 1)
        self.assertEqual(next_revision({"revision": 3}), 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
