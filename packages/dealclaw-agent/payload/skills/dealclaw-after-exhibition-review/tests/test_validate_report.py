#!/usr/bin/env python3

import copy
import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from validate_report import validate


def valid_report():
    return {
        "report_id": "R1",
        "report_mode": "close_out",
        "exhibition_id": "E1",
        "scope": {"current_exhibition_only": True},
        "executive_summary": {"conclusion": "本届形成两个待报价机会"},
        "funnel": [
            {"stage": "目标买家", "unique_customers": 20},
            {"stage": "已邀约", "unique_customers": 16},
            {"stage": "到展/会面", "unique_customers": 12},
            {"stage": "有效商洽", "unique_customers": 10},
            {"stage": "商务推进", "unique_customers": 5},
        ],
        "diagnoses": [
            {
                "observation": "6 家到达展位，其中 2 家需求明确",
                "interpretation": "需求确认仍是主要机会点",
                "recommended_action": "补齐四家买家的用途和交期",
                "success_metric": "四家均完成资格确认",
                "evidence_refs": ["interaction:1"],
            }
        ],
        "buyer_actions": {
            "connected_followups": [
                {
                    "customer_id": "C1",
                    "followup_priority": "优先跟进",
                    "priority_reason": "询问定制尺寸，要求本周报价",
                    "evidence_refs": ["meeting:1", "email:1"],
                    "next_step": {"action": "发送报价", "owner": "张三", "due": "2026-09-09"},
                }
            ]
        },
        "demand_insights": [
            {
                "topic": "定制尺寸",
                "unique_customers": 2,
                "mention_count": 3,
                "sample_customer_count": 6,
                "evidence_refs": ["meeting:1", "meeting:2"],
            }
        ],
        "product_usage_review": [],
        "action_plan": [
            {
                "action": "发送报价",
                "owner": "张三",
                "due": "2026-09-09",
                "success_metric": "买家确认收到并反馈",
            }
        ],
        "data_completeness": {"status": "complete"},
        "benchmark_context": None,
        "report_version": "1.0.0",
    }


class ValidateReportTests(unittest.TestCase):
    def test_valid_report_passes(self):
        errors, warnings = validate(valid_report())
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_rejects_unsupported_claim(self):
        report = valid_report()
        report["executive_summary"]["conclusion"] = "这些买家具备明确复购基础"
        errors, _ = validate(report)
        self.assertTrue(any("unsupported claim" in error for error in errors))

    def test_rejects_template_priority_reasons(self):
        report = valid_report()
        template = report["buyer_actions"]["connected_followups"][0]
        report["buyer_actions"]["connected_followups"] = []
        for index in range(5):
            item = copy.deepcopy(template)
            item["customer_id"] = f"C{index}"
            item["priority_reason"] = "产品高度匹配，主动询价"
            report["buyer_actions"]["connected_followups"].append(item)
        errors, _ = validate(report)
        self.assertTrue(any("identical priority_reason" in error for error in errors))

    def test_rejects_mention_count_without_customer_count(self):
        report = valid_report()
        del report["demand_insights"][0]["unique_customers"]
        errors, _ = validate(report)
        self.assertIn("demand_insights[0].unique_customers is required", errors)


if __name__ == "__main__":
    unittest.main()
