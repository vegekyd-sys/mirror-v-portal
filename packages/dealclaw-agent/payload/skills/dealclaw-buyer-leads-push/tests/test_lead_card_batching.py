#!/usr/bin/env python3
"""test_lead_card_batching.py — 线索卡片批量切批测试（2026-09-15 现场事故回归）。

事故：现场一次性给 49 条时明细被折叠/丢失。
新口径：渲染器内部按 ≤ MAX_LEADS_PER_MESSAGE 切批，产出多条 message，
整批 batch_id 语义不变，明细一条不丢；>5 家不再抛错。

运行：
  cd skills/dealclaw-buyer-leads-push/tests && python3 -m unittest discover -s . -p "test_*.py" -t .
"""

import json
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from lead_card_renderer import (  # noqa: E402
    CardRenderError,
    MAX_LEADS_PER_MESSAGE,
    fixture,
    many_leads_fixture,
    render,
)


class BatchRenderingTests(unittest.TestCase):
    def test_1_le5_unchanged_single_message(self):
        """≤5 家：仍是单条 message，标题不带分批后缀，lead_ids / batch_id 口径不变。"""
        payload = fixture()
        result = render(payload)
        self.assertEqual(result["message_count"], 1)
        self.assertEqual(result["lead_count"], 1)
        message = result["messages"][0]
        self.assertEqual(message["lead_ids"], ["lead-1"])
        self.assertEqual(message["batch_id"], result["batch_id"])
        card = json.dumps(message["card"], ensure_ascii=False)
        self.assertIn("AI猎客｜来自巴西买家的采购机会", card)
        self.assertNotIn("（1/", card)

    def test_2_six_leads_split_into_two_messages(self):
        result = render(many_leads_fixture(6))
        self.assertEqual(result["lead_count"], 6)
        self.assertEqual(result["message_count"], 2)
        self.assertEqual([len(m["lead_ids"]) for m in result["messages"]], [5, 1])

    def test_3_twelve_leads_all_detail_present(self):
        """12 家 → 多条 message，每条都带自己的明细，全部覆盖。"""
        result = render(many_leads_fixture(12))
        self.assertEqual(result["message_count"], 3)
        self.assertTrue(all(len(m["lead_ids"]) <= MAX_LEADS_PER_MESSAGE for m in result["messages"]))
        delivered = [lead_id for m in result["messages"] for lead_id in m["lead_ids"]]
        self.assertEqual(delivered, [f"lead-{i}" for i in range(1, 13)])
        card_text = json.dumps(result["messages"], ensure_ascii=False)
        for index in range(1, 13):
            self.assertIn(f"批量买家{index}", card_text)
        self.assertEqual(
            [m["card"]["header"]["title"]["content"] for m in result["messages"]],
            ["AI猎客｜来自巴西买家的采购机会（1/3）",
             "AI猎客｜来自巴西买家的采购机会（2/3）",
             "AI猎客｜来自巴西买家的采购机会（3/3）"],
        )

    def test_4_forty_nine_leads_none_lost(self):
        """49 家（事故规模）→ 10 条 message，明细一条不丢，顺序即优先级顺序。"""
        result = render(many_leads_fixture(49))
        self.assertEqual(result["lead_count"], 49)
        self.assertEqual(result["message_count"], 10)
        delivered = [lead_id for m in result["messages"] for lead_id in m["lead_ids"]]
        self.assertEqual(delivered, [f"lead-{i}" for i in range(1, 50)])
        card_text = json.dumps(result["messages"], ensure_ascii=False)
        for index in range(1, 50):
            self.assertIn(f"批量买家{index}", card_text)
        for folded in ("未逐条", "其余", "汇总"):
            self.assertNotIn(folded, card_text)

    def test_5_priority_order_and_rank_markers(self):
        """切批不重排；序号 >5 用「N.」，不越界取奖牌。"""
        result = render(many_leads_fixture(12))
        first_card = json.dumps(result["messages"][0]["card"], ensure_ascii=False)
        last_card = json.dumps(result["messages"][-1]["card"], ensure_ascii=False)
        self.assertIn("🥇", first_card)
        self.assertIn("12.", last_card)

    def test_6_batch_id_shared_across_messages(self):
        """同一批交付共用一个 batch_id（幂等键不因切批而变）。"""
        result = render(many_leads_fixture(12))
        batch_ids = {m["batch_id"] for m in result["messages"]}
        self.assertEqual(batch_ids, {result["batch_id"]})
        self.assertTrue(result["batch_id"].startswith("sha256:"))
        self.assertEqual(
            {m["receive_id"] for m in result["messages"]},
            {result["messages"][0]["receive_id"]},
        )

    def test_7_guards_still_enforced_on_large_batch(self):
        """大批量下原有校验不放松：重复 ID、非 push 记录照样拒绝。"""
        duplicated = many_leads_fixture(12)
        duplicated["selected_lead_ids"][-1] = "lead-1"
        with self.assertRaises(CardRenderError):
            render(duplicated)
        pool_only = many_leads_fixture(12)
        pool_only["delivery"]["pipeline_result"]["records"][7]["匹配动作"] = "pool_only"
        with self.assertRaises(CardRenderError):
            render(pool_only)

    def test_8_empty_selection_rejected(self):
        payload = fixture()
        payload["selected_lead_ids"] = []
        with self.assertRaises(CardRenderError):
            render(payload)

    def test_9_issue_style_report_is_consistent(self):
        """回归：49 家一条不漏 = 每条 message 的 lead_ids 之和。"""
        result = render(many_leads_fixture(49))
        self.assertEqual(sum(len(m["lead_ids"]) for m in result["messages"]), result["lead_count"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
