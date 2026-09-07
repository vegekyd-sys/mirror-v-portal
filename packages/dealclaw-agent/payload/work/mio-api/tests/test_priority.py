#!/usr/bin/env python3
"""test_priority.py — 跟进优先级引擎测试（阶段③）。

覆盖 A-F 要求：
  - 优先级三档（优先/普通/长期培育），与阶段/冷热严格分开
  - contact_policy（active/paused/do_not_contact）+ opportunity_status（active/paused/won/lost）
  - 排序前排除：do_not_contact 排除、lost 排除、paused 不进今日行动、won 排除、仅 active 参与
  - 多因子判定 + 证据化理由，不写死单一信号
  - 输出 priority/priority_reason/evidence_refs/missing_signals/rule_version
  - 人工调整优先，记录 by/at/reason，自动结果保留不覆盖
"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_priority import (  # noqa: E402
    evaluate_priority,
    compute_lead_priority,
    apply_priorities_to_leads,
    PRIORITY_HIGH,
    PRIORITY_NORMAL,
    PRIORITY_NURTURE,
    RULE_VERSION,
)


def _sig(signal_type, value="x", **kw):
    s = {"type": signal_type, "value": value, "evidence_text": "原文证据句",
         "origin": "agent_extracted"}
    s.update(kw)
    return s


def _interaction(**kw):
    it = {"interaction_id": "it_1", "raw_record_ref": "raw/1.txt", "signals": []}
    it.update(kw)
    return it


def _now():
    return datetime.now(timezone.utc).isoformat()


class TestPriorityTiers(unittest.TestCase):
    def test_1_strong_commercial_signal_high(self):
        """强商务信号（报价）→ 优先跟进。"""
        r = evaluate_priority(
            opportunity={"match_grade": "B", "stage": "已回复"},
            interactions=[_interaction(signals=[_sig("quote_request")])],
        )
        self.assertEqual(r["priority"], PRIORITY_HIGH)
        self.assertIn("强商务", r["priority_reason"])

    def test_2_need_biz_high(self):
        """产品需求 + 业务信息明确 → 优先跟进。"""
        r = evaluate_priority(
            opportunity={"match_grade": "A", "stage": "需求明确"},
            interactions=[_interaction(signals=[_sig("product_need", "户外桌"), _sig("quantity", "200")])],
        )
        self.assertEqual(r["priority"], PRIORITY_HIGH)

    def test_3_high_match_untouched_normal(self):
        """高匹配但未触达、无信号 → 普通跟进（不误判为优先）。"""
        r = evaluate_priority(
            opportunity={"match_grade": "A", "stage": "待触达"},
            interactions=[],
        )
        self.assertEqual(r["priority"], PRIORITY_NORMAL)

    def test_4_low_match_no_signal_nurture(self):
        """低匹配、无信号 → 长期培育。"""
        r = evaluate_priority(
            opportunity={"match_grade": "C", "stage": "待触达"},
            interactions=[],
        )
        self.assertEqual(r["priority"], PRIORITY_NURTURE)


class TestNotHardcoded(unittest.TestCase):
    def test_5_replied_but_do_not_contact_not_high(self):
        """「请不要再联系」的回复 → 不因回复升优先（do_not_contact 排除）。"""
        r = evaluate_priority(
            customer={"contact_policy": "do_not_contact"},
            opportunity={"match_grade": "A", "stage": "已回复"},
            interactions=[_interaction(signals=[_sig("quote_request")])],
        )
        self.assertFalse(r["actionable"])
        self.assertEqual(r["excluded_reason"], "do_not_contact")

    def test_6_negative_signal_not_prioritized(self):
        """有负面信号（否认需求）→ 不主动追。"""
        r = evaluate_priority(
            opportunity={"match_grade": "A", "stage": "需求明确"},
            interactions=[_interaction(signals=[_sig("deny_need")])],
        )
        self.assertEqual(r["priority"], PRIORITY_NURTURE)
        self.assertIn("负面信号", r["priority_reason"])


class TestExclusion(unittest.TestCase):
    def test_7_do_not_contact_excluded(self):
        """do_not_contact → 排除，不进今日行动。"""
        r = evaluate_priority(customer={"contact_policy": "do_not_contact"}, opportunity={})
        self.assertFalse(r["actionable"])
        self.assertEqual(r["excluded_reason"], "do_not_contact")

    def test_8_lost_excluded(self):
        """lost → 排除（进历史）。"""
        r = evaluate_priority(opportunity={"opportunity_status": "lost"})
        self.assertFalse(r["actionable"])
        self.assertEqual(r["excluded_reason"], "lost")

    def test_9_won_excluded(self):
        """won → 排除（已成交不催）。"""
        r = evaluate_priority(opportunity={"opportunity_status": "won"})
        self.assertFalse(r["actionable"])
        self.assertEqual(r["excluded_reason"], "won")

    def test_10_paused_excluded(self):
        """paused → 不进今日行动列表。"""
        r = evaluate_priority(customer={"contact_policy": "paused"}, opportunity={})
        self.assertFalse(r["actionable"])
        self.assertEqual(r["excluded_reason"], "paused")
        # opportunity_status=paused 同样排除
        r2 = evaluate_priority(opportunity={"opportunity_status": "paused"})
        self.assertFalse(r2["actionable"])
        self.assertEqual(r2["excluded_reason"], "paused")

    def test_11_active_participates(self):
        """active 才参与优先级计算。"""
        r = evaluate_priority(
            customer={"contact_policy": "active"},
            opportunity={"opportunity_status": "active", "match_grade": "B"},
        )
        self.assertTrue(r["actionable"])


class TestOutputContract(unittest.TestCase):
    def test_12_output_fields(self):
        """输出包含 priority/priority_reason/evidence_refs/missing_signals/rule_version。"""
        r = evaluate_priority(
            opportunity={"match_grade": "A"},
            interactions=[_interaction(signals=[_sig("quote_request", value="询价")])],
        )
        for k in ("priority", "priority_reason", "evidence_refs", "missing_signals", "rule_version"):
            self.assertIn(k, r)
        self.assertEqual(r["rule_version"], RULE_VERSION)
        self.assertTrue(r["evidence_refs"])  # 有证据引用

    def test_13_missing_signals_reported(self):
        """无信号时 missing_signals 报告缺什么。"""
        r = evaluate_priority(opportunity={"match_grade": "C"})
        self.assertTrue(r["missing_signals"])


class TestManualOverride(unittest.TestCase):
    def test_14_manual_override_priority(self):
        """人工调整优先，记录 by/at/reason。"""
        r = evaluate_priority(
            opportunity={"match_grade": "C"},
            manual_override={"priority": PRIORITY_HIGH, "by": "张三", "reason": "老板点名"},
        )
        self.assertEqual(r["priority"], PRIORITY_HIGH)
        self.assertEqual(r["auto_priority"], PRIORITY_NURTURE)  # 自动结果保留
        self.assertEqual(r["manual_override"]["by"], "张三")
        self.assertIn("reason", r["manual_override"])

    def test_15_manual_override_from_previous(self):
        """previous 里的 manual_override 持续生效。"""
        prev = {"manual_override": {"priority": PRIORITY_HIGH, "by": "张三", "reason": "r"}}
        r = evaluate_priority(opportunity={"match_grade": "C"}, previous=prev)
        self.assertEqual(r["priority"], PRIORITY_HIGH)
        self.assertEqual(r["auto_priority"], PRIORITY_NURTURE)


class TestTimeUrgency(unittest.TestCase):
    def test_16_overdue_next_step_high(self):
        """需求明确 + 下一步已到期 → 优先跟进。"""
        overdue = (datetime.now(timezone.utc) - timedelta(hours=4)).isoformat()
        r = evaluate_priority(
            opportunity={"match_grade": "B", "next_step": {"due": overdue}},
            interactions=[_interaction(signals=[_sig("product_need"), _sig("budget", "5k")])],
            now=_now(),
        )
        self.assertEqual(r["priority"], PRIORITY_HIGH)
        self.assertIn("到期", r["priority_reason"])


class TestLeadBridge(unittest.TestCase):
    def test_17_stop_contact_do_not_contact(self):
        """lead stage=停止触达 → contact_policy=do_not_contact，不进行动列表。"""
        r = compute_lead_priority({"company": "A", "stage": "停止触达"})
        self.assertFalse(r["actionable"])
        self.assertEqual(r["excluded_reason"], "do_not_contact")

    def test_18_closed_won_excluded(self):
        """lead stage=成交 → opportunity_status=won，排除。"""
        r = compute_lead_priority({"company": "B", "stage": "成交"})
        self.assertFalse(r["actionable"])
        self.assertEqual(r["excluded_reason"], "won")

    def test_19_apply_priorities_dual_write(self):
        """apply_priorities_to_leads 双写 6 字段。"""
        leads = [
            {"company": "X", "stage": "待触达"},
            {"company": "Y", "stage": "报价中"},
        ]
        updated, report = apply_priorities_to_leads(leads)
        for l in updated:
            for k in ("followup_priority", "priority_reason", "contact_policy",
                      "opportunity_status", "priority_rule_version", "priority_updated_at"):
                self.assertIn(k, l)
        self.assertEqual(report["total"], 2)

    def test_20_report_sort(self):
        """报告按 followup_priority 排序（冷热已退役）。"""
        leads = [
            {"company": "X", "stage": "待触达"},
            {"company": "Y", "stage": "报价中"},
            {"company": "Z", "stage": "已回复"},
        ]
        updated, report = apply_priorities_to_leads(leads)
        self.assertEqual(report["sort_field"], "followup_priority")
        # Y（报价中）→ 优先跟进 → 排序应排最前
        self.assertEqual(report["order"][0], "Y")


if __name__ == "__main__":
    unittest.main(verbosity=2)
