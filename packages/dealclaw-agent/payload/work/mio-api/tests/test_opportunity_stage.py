#!/usr/bin/env python3
"""test_opportunity_stage.py — dc_opportunity_stage 阶段判断引擎单元测试。

覆盖：
- 14 个基础场景（现场扫码 / 有效名片 / 会议无需求 / 明确产品数量 / 要求报价 /
  单向邮件 / WA 双向 / 退信不回退 / 项目延期 / 项目取消 / 多源冲突 / 无证据 /
  人工修正 / 跨级推进）
- 10 个 signals 数据契约场景（canonical 推进 / 旧字段兼容 / evidence_text 缺失 /
  user_confirmed 优先 / 多信号 / 正负冲突 / email bounced 不回退 /
  邮箱失效 WhatsApp 有效 / summary 不 confirmed / 未知 signal 忽略）
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_opportunity_stage import evaluate_stage  # noqa: E402


def _sig(type_, value, evidence_text="", origin="agent_extracted"):
    return {"type": type_, "value": value, "evidence_text": evidence_text, "origin": origin}


class TestBaseStage(unittest.TestCase):
    """14 个基础场景 + 1 个 extracted 场景。"""

    def test_1_scan_only(self):
        r = evaluate_stage(interactions=[{"interaction_id": "i1", "raw_record_ref": "raw/scan.txt", "source": "scan"}])
        self.assertEqual(r["proposed_stage"], "已接触")
        self.assertEqual(r["status"], "confirmed")

    def test_2_valid_card(self):
        r = evaluate_stage(interactions=[{"interaction_id": "i1", "source": "card", "email": "a@b.com"}])
        self.assertEqual(r["proposed_stage"], "已留资")
        self.assertEqual(r["status"], "confirmed")

    def test_3_meeting_no_need(self):
        r = evaluate_stage(interactions=[{"interaction_id": "i1", "source": "meeting"}])
        self.assertEqual(r["proposed_stage"], "已沟通")
        self.assertEqual(r["status"], "confirmed")

    def test_4_clear_product_and_quantity_legacy(self):
        """旧平铺字段（无 evidence_text）→ 需求明确但 suggested，带 deprecated 提示。"""
        r = evaluate_stage(interactions=[{"interaction_id": "i1", "source": "meeting", "product_need": "户外桌", "quantity": "200套"}])
        self.assertEqual(r["proposed_stage"], "需求明确")
        self.assertEqual(r["status"], "suggested")
        self.assertTrue(any(w["type"] == "deprecated_field" for w in r["warnings"]))

    def test_5_quote_request_legacy(self):
        r = evaluate_stage(interactions=[{"interaction_id": "i1", "source": "meeting", "quote_request": True}])
        self.assertEqual(r["proposed_stage"], "商务跟进")
        self.assertEqual(r["status"], "suggested")

    def test_6_one_way_email_only(self):
        r = evaluate_stage(interactions=[{"interaction_id": "i1", "source": "email", "direction": "out"}])
        self.assertEqual(r["status"], "insufficient")

    def test_7_whatsapp_bidirectional(self):
        r = evaluate_stage(interactions=[{"interaction_id": "i1", "source": "whatsapp", "bidirectional": True}])
        self.assertEqual(r["proposed_stage"], "已沟通")
        self.assertEqual(r["status"], "confirmed")

    def test_8_bounce_no_regress(self):
        r = evaluate_stage(
            interactions=[{"interaction_id": "i1", "source": "email", "direction": "out", "bounced": True}],
            previous_evaluation={"effective_stage": "已沟通", "max_stage_reached": "已沟通"},
        )
        self.assertEqual(r["effective_stage"], "已沟通")

    def test_9_delayed(self):
        r = evaluate_stage(interactions=[{"interaction_id": "i1", "source": "email", "delayed": True}])
        self.assertEqual(r["opportunity_status"], "paused")

    def test_10_cancelled(self):
        r = evaluate_stage(interactions=[{"interaction_id": "i1", "source": "email", "cancelled": True}])
        self.assertEqual(r["opportunity_status"], "lost")

    def test_11_conflicting_sources(self):
        r = evaluate_stage(interactions=[
            {"interaction_id": "i1", "source": "meeting", "product_need": "户外桌"},
            {"interaction_id": "i2", "source": "email", "deny_need": True},
        ])
        self.assertEqual(r["status"], "conflicted")

    def test_12_no_evidence(self):
        r = evaluate_stage(interactions=[], opportunity={})
        self.assertEqual(r["status"], "insufficient")

    def test_13_manual_override(self):
        r = evaluate_stage(
            interactions=[{"interaction_id": "i1", "source": "scan"}],
            manual_override={"stage": "商务跟进", "by": "张三", "reason": "老板已确认重点客户"},
        )
        self.assertEqual(r["effective_stage"], "商务跟进")
        self.assertEqual(r["manual_override"]["original_auto_stage"], "已接触")

    def test_14_cross_level_advance_legacy(self):
        r = evaluate_stage(interactions=[
            {"interaction_id": "i1", "source": "scan"},
            {"interaction_id": "i2", "source": "meeting", "product_need": "户外桌", "quantity": "200套", "quote_request": True},
        ])
        self.assertEqual(r["proposed_stage"], "商务跟进")
        self.assertEqual(r["status"], "suggested")  # legacy 无 evidence_text

    def test_extracted_suggested_not_confirmed(self):
        r = evaluate_stage(opportunity={"extracted": {"needs": "户外桌", "quantity": "200套", "quote_status": "待报价"}})
        self.assertEqual(r["status"], "suggested")


class TestSignalsContract(unittest.TestCase):
    """10 个 signals 数据契约场景。"""

    def test_canonical_signals_advance(self):
        r = evaluate_stage(interactions=[{
            "interaction_id": "i1", "source": "meeting",
            "signals": [
                _sig("product_need", "户外桌", evidence_text="need outdoor table"),
                _sig("quantity", "200套", evidence_text="200 sets"),
            ],
        }])
        self.assertEqual(r["proposed_stage"], "需求明确")
        self.assertEqual(r["status"], "confirmed")

    def test_legacy_field_compat(self):
        r = evaluate_stage(interactions=[{
            "interaction_id": "i1", "source": "meeting",
            "product_need": "户外桌", "quantity": "200套",
        }])
        self.assertEqual(r["proposed_stage"], "需求明确")
        self.assertEqual(r["status"], "suggested")
        self.assertTrue(any(w["type"] == "deprecated_field" for w in r["warnings"]))

    def test_evidence_text_missing_not_confirmed(self):
        r = evaluate_stage(interactions=[{
            "interaction_id": "i1", "source": "meeting",
            "signals": [
                _sig("product_need", "户外桌", evidence_text=""),
                _sig("quantity", "200套", evidence_text=""),
            ],
        }])
        self.assertEqual(r["proposed_stage"], "需求明确")
        self.assertEqual(r["status"], "suggested")

    def test_user_confirmed_priority(self):
        r = evaluate_stage(interactions=[{
            "interaction_id": "i1", "source": "meeting",
            "signals": [
                _sig("product_need", "户外桌", evidence_text="", origin="agent_extracted"),
                _sig("product_need", "户外桌", evidence_text="", origin="user_confirmed"),
                _sig("quantity", "200套", evidence_text="", origin="user_confirmed"),
            ],
        }])
        self.assertEqual(r["status"], "confirmed")
        ev = [e for e in r["evidence"] if e.get("stage") == "需求明确"][0]
        self.assertEqual(ev.get("origin"), "user_confirmed")

    def test_multiple_signals_same_interaction(self):
        r = evaluate_stage(interactions=[{
            "interaction_id": "i1", "source": "meeting",
            "signals": [
                _sig("product_need", "户外桌", "need outdoor"),
                _sig("quantity", "200", "200 sets"),
                _sig("quote_request", "true", "please quote"),
            ],
        }])
        self.assertEqual(r["proposed_stage"], "商务跟进")
        self.assertEqual(r["status"], "confirmed")

    def test_signal_conflict(self):
        r = evaluate_stage(interactions=[
            {"interaction_id": "i1", "source": "meeting", "signals": [_sig("product_need", "户外桌", "need")]},
            {"interaction_id": "i2", "source": "email", "signals": [_sig("deny_need", "true", "no need")]},
        ])
        self.assertEqual(r["status"], "conflicted")

    def test_email_bounced_no_regress(self):
        r = evaluate_stage(
            interactions=[{"interaction_id": "i1", "source": "email", "signals": [_sig("email_bounced", "true", "bounced", origin="system")]}],
            previous_evaluation={"effective_stage": "已沟通", "max_stage_reached": "已沟通"},
        )
        self.assertEqual(r["effective_stage"], "已沟通")
        self.assertEqual(r["opportunity_status"], "active")
        self.assertEqual(r["contact_reachability"]["email"], "invalid")

    def test_email_invalid_whatsapp_valid(self):
        r = evaluate_stage(interactions=[
            {"interaction_id": "i1", "source": "email", "signals": [_sig("email_bounced", "true", origin="system")]},
            {"interaction_id": "i2", "source": "whatsapp", "bidirectional": True},
        ])
        self.assertEqual(r["contact_reachability"]["email"], "invalid")
        self.assertNotEqual(r["contact_reachability"]["whatsapp"], "invalid")
        self.assertEqual(r["proposed_stage"], "已沟通")

    def test_summary_not_confirmed(self):
        r = evaluate_stage(interactions=[{
            "interaction_id": "i1", "source": "meeting",
            "summary": "买家需要户外桌 200 套",
        }])
        self.assertEqual(r["proposed_stage"], "已沟通")  # 只有 meeting，无 signals 不推需求明确
        self.assertNotIn("需求明确", [e["stage"] for e in r["evidence"]])

    def test_unknown_signal_ignored_with_warning(self):
        r = evaluate_stage(interactions=[{
            "interaction_id": "i1", "source": "meeting",
            "signals": [
                {"type": "mystery_signal", "value": "x"},
                _sig("product_need", "户外桌", "need"),
            ],
        }])
        self.assertTrue(any(w["type"] == "unknown_signal" for w in r["warnings"]))
        self.assertIn(r["status"], ("confirmed", "suggested", "insufficient"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
