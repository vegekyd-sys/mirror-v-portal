#!/usr/bin/env python3
"""test_onsite_recommend.py — 现场推荐气泡「分批全明细」测试（红线五.10 修订）。

2026-09-15 田耕郡现场实测：49 条被折叠成摘要、明细丢失。
新口径：按优先级分批逐条全发（每批 ≤ ONSITE_BATCH_SIZE 条），
总量 > ONSITE_SUMMARY_THRESHOLD 时先补一条汇总气泡，随后仍把全部明细分批补齐。

覆盖：
  - ≤10 家：单条气泡逐条列全（无汇总）
  - 12 家 → 汇总 + 2 批明细，全部含明细、顺序不变
  - 49 家 → 汇总 + 5 批明细，一条不丢、无「未逐条列出」折叠标记
  - 边界：10 条不加汇总；11 条先汇总后明细（明细全覆盖）
  - 池入口：有汇总就放汇总里；无汇总挂末条明细气泡
  - 空输入 → 不推气泡

运行：cd work/mio-api && python3 -m unittest discover -s tests -t tests -p "test_onsite_recommend.py"
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_onsite_recommend import (  # noqa: E402
    ONSITE_BATCH_SIZE,
    ONSITE_SUMMARY_THRESHOLD,
    build_onsite_bubbles,
)

HEADER = "📥 现场未邀约匹配买家（某展会）"


def _lines(n, prefix):
    return [f"{prefix}公司{i}｜国家｜产品对路" for i in range(n)]


def _all_lines(bubbles):
    """把气泡列表里的明细行按发送顺序摊平。

    汇总气泡整体跳过：它的「Top 亮点」只是明细的重复摘要，计入会重复计数。
    明细气泡里去掉表头、批次号、【主推】/【跟进】分节标记与末尾的线索池入口行。
    """
    out = []
    for bubble in bubbles:
        if "全部明细分 " in bubble:
            continue
        for line in bubble.splitlines():
            if line == HEADER or line.startswith("（第 "):
                continue
            if line.startswith("【") and line.endswith("】"):
                continue
            if line.startswith("📊 "):          # 线索池入口行（非明细）
                continue
            out.append(line)
    return out


class TestOnsiteBubblesUnchanged(unittest.TestCase):
    def test_1_le10_single_bubble_all_listed(self):
        """≤10 家：单条气泡，主推 + 跟进全部逐条列出（与改前 ≤5 家形态一致）。"""
        main = _lines(3, "主推")
        follow = _lines(2, "跟进")
        bubbles = build_onsite_bubbles(HEADER, main, follow)
        self.assertEqual(len(bubbles), 1)
        out = bubbles[0]
        self.assertIn(HEADER, out)
        self.assertIn("【主推】", out)
        self.assertIn("【跟进】", out)
        for i in range(3):
            self.assertIn(f"主推公司{i}", out)
        for i in range(2):
            self.assertIn(f"跟进公司{i}", out)
        self.assertNotIn("（第 ", out)          # 单批不写批次号
        self.assertNotIn("未逐条", out)         # 无折叠标记
        self.assertNotIn("其余", out)

    def test_2_exactly_batch_size_is_single_bubble(self):
        """边界：恰好 = 批大小 → 单条气泡。"""
        main = _lines(ONSITE_BATCH_SIZE, "主推")
        bubbles = build_onsite_bubbles(HEADER, main, [])
        self.assertEqual(len(bubbles), 1)
        self.assertIn(f"主推公司{ONSITE_BATCH_SIZE - 1}", bubbles[0])
        self.assertNotIn("【跟进】", bubbles[0])

    def test_3_one_over_batch_size_prefers_summary(self):
        """边界：11 条 > 阈值 10 → 先汇总、再把 2 批明细全补上。"""
        main = _lines(ONSITE_BATCH_SIZE + 1, "主推")
        bubbles = build_onsite_bubbles(HEADER, main, [])
        self.assertEqual(len(bubbles), 3, "汇总 + 2 批明细")
        self.assertIn(f"共 {ONSITE_BATCH_SIZE + 1} 家", bubbles[0])
        self.assertEqual(_all_lines(bubbles), main)

    def test_4_empty_input_no_bubble(self):
        self.assertEqual(build_onsite_bubbles(HEADER, [], []), [])

    def test_5_limit_boundary_5_is_single_bubble(self):
        """改前的 ≤5 全列场景不变。"""
        main = _lines(3, "主推")
        follow = _lines(2, "跟进")
        bubbles = build_onsite_bubbles(HEADER, main, follow)
        self.assertEqual(len(bubbles), 1)
        self.assertIn("主推公司2", bubbles[0])
        self.assertIn("跟进公司1", bubbles[0])


class TestOnsiteBubblesBatch(unittest.TestCase):
    def test_6_twelve_leads_summary_plus_two_batches(self):
        """12 家 → 汇总 + 2 批明细，每条明细都在，无一条丢失。"""
        main = _lines(7, "主推")
        follow = _lines(5, "跟进")
        bubbles = build_onsite_bubbles(HEADER, main, follow)
        self.assertEqual(len(bubbles), 3)
        self.assertEqual(_all_lines(bubbles), main + follow)
        for bubble in bubbles:
            self.assertIn(HEADER, bubble)

    def test_7_priority_order_preserved(self):
        """切批不重排：主推在前、跟进在后，顺序与入参一致。"""
        main = _lines(8, "主推")
        follow = _lines(9, "跟进")
        bubbles = build_onsite_bubbles(HEADER, main, follow)
        self.assertEqual(_all_lines(bubbles), main + follow)
        self.assertGreater(len(bubbles), 1)

    def test_8_forty_nine_leads_one_not_lost(self):
        """49 家（本次事故规模）→ 汇总 + 5 批明细，一条不丢。"""
        main = _lines(8, "主推")
        follow = _lines(41, "跟进")
        total = len(main) + len(follow)
        bubbles = build_onsite_bubbles(HEADER, main, follow)
        expected_batches = (total + ONSITE_BATCH_SIZE - 1) // ONSITE_BATCH_SIZE
        self.assertEqual(len(bubbles), 1 + expected_batches)     # 汇总 + 全部明细批
        self.assertEqual(_all_lines(bubbles), main + follow)
        joined = "\n".join(bubbles)
        self.assertIn(f"共 {total} 家", bubbles[0])
        self.assertIn(f"全部明细分 {expected_batches} 批逐条发出，不省略", bubbles[0])
        self.assertIn("主推公司0", bubbles[0])                    # 汇总含 Top 亮点
        self.assertNotIn("未逐条", joined)                        # 折叠口径已删除
        self.assertNotIn("其余", joined)

    def test_9_summary_threshold(self):
        """阈值：=10 不加汇总气泡；=11 加，且明细仍全发。"""
        for total, expect_summary in ((ONSITE_SUMMARY_THRESHOLD, False),
                                      (ONSITE_SUMMARY_THRESHOLD + 1, True)):
            main = _lines(total, "主推")
            bubbles = build_onsite_bubbles(HEADER, main, [])
            has_summary = "全部明细分" in bubbles[0]
            self.assertEqual(has_summary, expect_summary, total)
            self.assertEqual(_all_lines(bubbles), main)
            self.assertEqual(len(bubbles), total // ONSITE_BATCH_SIZE + (1 if total % ONSITE_BATCH_SIZE else 0)
                             + (1 if expect_summary else 0))

    def test_10_batch_size_must_be_positive(self):
        with self.assertRaises(ValueError):
            build_onsite_bubbles(HEADER, _lines(1, "主推"), [], batch_size=0)

    def test_11_single_side_only(self):
        """只有跟进（或只有主推）时也要切批列全。"""
        follow = _lines(12, "跟进")
        bubbles = build_onsite_bubbles(HEADER, [], follow)
        self.assertEqual(_all_lines(bubbles), follow)
        self.assertNotIn("【主推】", "\n".join(bubbles))


class TestOnsitePoolLink(unittest.TestCase):
    """本展会线索池入口：有汇总进汇总，无汇总挂末条明细气泡（入口不能丢）。"""

    POOL_URL = "https://versa-ai.feishu.cn/base/basetok1?table=tbl1"

    def test_12_pool_link_in_summary_when_over_threshold(self):
        main = _lines(ONSITE_SUMMARY_THRESHOLD + 1, "主推")
        bubbles = build_onsite_bubbles(HEADER, main, [], pool_url=self.POOL_URL)
        self.assertIn(self.POOL_URL, bubbles[0], ">阈值：入口在汇总气泡")
        self.assertNotIn(self.POOL_URL, "\n".join(bubbles[1:]))
        self.assertEqual(_all_lines(bubbles), main)

    def test_13_pool_link_on_last_bubble_when_under_threshold(self):
        main = _lines(3, "主推")
        bubbles = build_onsite_bubbles(HEADER, main, [], pool_url=self.POOL_URL)
        self.assertEqual(len(bubbles), 1)
        self.assertTrue(bubbles[-1].rstrip().endswith(self.POOL_URL), "≤阈值：入口挂末条")
        self.assertEqual(_all_lines(bubbles), main, "入口行不计入明细")

    def test_14_no_pool_no_link_line(self):
        bubbles = build_onsite_bubbles(HEADER, _lines(3, "主推"), [])
        self.assertNotIn("📊", "\n".join(bubbles))

    def test_15_pool_link_not_duplicated_across_bubbles(self):
        main = _lines(25, "主推")
        bubbles = build_onsite_bubbles(HEADER, main, [], pool_url=self.POOL_URL)
        joined = "\n".join(bubbles)
        self.assertEqual(joined.count(self.POOL_URL), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
