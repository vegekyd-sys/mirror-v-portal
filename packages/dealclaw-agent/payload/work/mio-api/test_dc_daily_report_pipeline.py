#!/usr/bin/env python3
"""test_dc_daily_report_pipeline.py — 新 Daily Brief 管线接入推送文案的测试

覆盖：
  - 早报片段：Top3（有证据）+ 待分层批量跟进 + 风险
  - 晚报片段：核销状态（含标题）
  - 管线异常/无数据时不影响旧文案（返回空串）
  - build_morning_report 把管线片段拼进 text

运行：cd work/mio-api && python3 test_dc_daily_report_pipeline.py
"""
import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dc_daily_report as dr  # noqa: E402
import dc_daily_pipeline  # noqa: E402


PLAN = {
    "actions": [
        {"action_key": "k1", "source": "opportunity", "title": "逾期跟进 Overdue Co",
         "reason": "下一步已到期"},
        {"action_key": "k2", "source": "email",
         "title": "跟进 65 家（待分层批量跟进）", "reason": "无商机证据"},
    ],
    "top_n_action_keys": ["k1"],
    "context": [{"kind": "risk", "title": "数据质量风险：本届数据未就绪"}],
}


class TestMorningFormat(unittest.TestCase):
    def test_top3_batch_risk(self):
        out = dr._fmt_pipeline_morning(PLAN)
        self.assertIn("【今日优先】", out)
        self.assertIn("逾期跟进 Overdue Co", out)
        self.assertIn("待分层批量跟进", out)
        self.assertIn("【风险】", out)

    def test_empty_plan(self):
        self.assertEqual(dr._fmt_pipeline_morning({}), "")


class TestEveningFormat(unittest.TestCase):
    def test_review_status_with_title(self):
        review = {"reviews": [{"action_key": "k1", "status": "done"}]}
        out = dr._fmt_pipeline_evening(review, PLAN)
        self.assertIn("【晚报核销】", out)
        self.assertIn("逾期跟进 Overdue Co", out)
        self.assertIn("done", out)

    def test_none_review(self):
        self.assertEqual(dr._fmt_pipeline_evening(None, PLAN), "")


class TestErrorIsolation(unittest.TestCase):
    def test_pipeline_brief_swallows_errors(self):
        orig = dc_daily_pipeline.run_morning_brief

        def boom(*a, **k):
            raise RuntimeError("boom")

        dc_daily_pipeline.run_morning_brief = boom
        try:
            self.assertEqual(dr._pipeline_brief("C1", "morning"), "")
        finally:
            dc_daily_pipeline.run_morning_brief = orig


class TestWiredIntoReport(unittest.TestCase):
    def test_morning_report_includes_pipeline(self):
        orig = dr._pipeline_brief
        dr._pipeline_brief = lambda cid, slot: "【今日优先】\n1. X"
        try:
            rep = dr.build_morning_report("C1")
            self.assertIn("【今日优先】", rep["text"])
        finally:
            dr._pipeline_brief = orig

    def test_evening_report_includes_pipeline(self):
        orig = dr._pipeline_brief
        dr._pipeline_brief = lambda cid, slot: "【晚报核销】\n- X：done"
        try:
            rep = dr.build_evening_report("C1")
            self.assertIn("【晚报核销】", rep["text"])
        finally:
            dr._pipeline_brief = orig


class TestTodayMetrics(unittest.TestCase):
    def test_local_date_of_cross_day(self):
        # UTC 09-10 17:10 = 上海 09-11 01:10（解决 UTC/本地跨日错配）
        self.assertEqual(dr._local_date_of("2026-09-10T17:10:00+00:00"), "2026-09-11")
        self.assertEqual(dr._local_date_of("2026-09-10T02:00:00+00:00"), "2026-09-10")
        self.assertEqual(dr._local_date_of(None), "")

    def test_follow_count_distinct_buyers(self):
        plan = {"actions": [
            {"target_refs": [{"type": "buyer", "id": "a@x.com"}]},
            {"target_refs": [{"type": "buyer", "id": "a@x.com"},
                             {"type": "buyer", "id": "b@x.com"},
                             {"type": "exhibition", "id": "E1"}]},
        ]}
        self.assertEqual(dr._follow_count(plan), 2)

    def test_today_metrics_counts(self):
        import dc_memory_data
        import dc_email_controller.dc_email_signals as sigmod
        now = datetime.now(timezone.utc).isoformat()
        om, osm, osl = dc_memory_data.read_interactions, dr.collect_metrics, sigmod.list_signals
        dc_memory_data.read_interactions = lambda cid: (
            [{"interaction_id": "m1", "customer_id": "M1", "channel": "meeting",
              "occurred_at": now}]
            + [{"interaction_id": "r1", "customer_id": "R1", "channel": "email",
                "direction": "inbound", "occurred_at": now}])
        dr.collect_metrics = lambda *a, **k: {"sent": 3, "delivered": 3, "bounced": 0, "replied": 1}
        sigmod.list_signals = lambda *a, **k: [{"signal_type": "quote_request", "created_at": now}]
        try:
            out = dr._today_metrics("C1", {"actions": [
                {"target_refs": [{"type": "buyer", "id": "a@x.com"},
                                 {"type": "buyer", "id": "b@x.com"}]}]})
            self.assertIn("【今日数据】", out)
            self.assertIn("今日会谈 1 家", out)
            self.assertIn("收到回复 1 家", out)
            self.assertIn("待跟进 2 家", out)
            self.assertIn("报价 1", out)
        finally:
            dc_memory_data.read_interactions = om
            dr.collect_metrics = osm
            sigmod.list_signals = osl

    def test_today_metrics_error_isolated(self):
        import dc_memory_data
        om = dc_memory_data.read_interactions

        def boom(cid):
            raise RuntimeError("boom")

        dc_memory_data.read_interactions = boom
        try:
            # 不抛异常，仍返回可用的块（至少含今日汇总行）
            out = dr._today_metrics("C1", {"actions": []})
            self.assertIn("【今日数据】", out)
        finally:
            dc_memory_data.read_interactions = om


if __name__ == "__main__":
    unittest.main(verbosity=2)
