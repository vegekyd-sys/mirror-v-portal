#!/usr/bin/env python3
"""test_onsite_recommend.py — 现场推荐简讯卡收敛测试（红线五.10）。

真实展示路径在 dc_onsite_recommend.run()（此前全量逐条 extend，15/20 家也刷屏）。
覆盖 format_onsite_card 收敛：
  - ≤5 家：主推 + 跟进逐条列出（不变）
  - >5 家：收敛为「主推 N · 跟进 M（共 X）」+ 主推前 3 + 跟进前 2 + 其余数量
  - 单侧为空（只有主推 / 只有跟进）
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_onsite_recommend import format_onsite_card, ONSITE_LIST_LIMIT  # noqa: E402

HEADER = "📥 现场未邀约匹配买家（某展会）"


def _lines(n, prefix):
    return [f"{prefix}公司{i}｜国家｜产品对路" for i in range(n)]


class TestOnsiteCardConvergence(unittest.TestCase):
    def test_1_le5_all_listed(self):
        """≤5 家：主推 + 跟进全部逐条列出。"""
        main = _lines(2, "主推")
        follow = _lines(2, "跟进")
        out = format_onsite_card(HEADER, main, follow)
        self.assertIn(HEADER, out)
        self.assertIn("【主推】", out)
        self.assertIn("【跟进】", out)
        for i in range(2):
            self.assertIn(f"主推公司{i}", out)
            self.assertIn(f"跟进公司{i}", out)
        self.assertNotIn("共", out.split("\n")[1] if "\n" in out else "")

    def test_2_gt5_converges(self):
        """>5 家：收敛为总结 + 主推前 3 + 跟进前 2，不逐条刷屏。"""
        main = _lines(8, "主推")
        follow = _lines(7, "跟进")
        out = format_onsite_card(HEADER, main, follow)
        self.assertIn("主推 8 家 · 跟进 7 家（共 15 家）", out)
        self.assertIn("主推公司0", out)
        self.assertIn("主推公司2", out)
        self.assertNotIn("主推公司3", out)  # 主推第 4 条起不列
        self.assertIn("跟进公司0", out)
        self.assertNotIn("跟进公司2", out)  # 跟进第 3 条起不列
        self.assertIn("其余 10 家未逐条列出", out)

    def test_3_gt5_only_main(self):
        """>5 家且只有主推：主推前 3 + 其余数量。"""
        main = _lines(12, "主推")
        out = format_onsite_card(HEADER, main, [])
        self.assertIn("主推 12 家 · 跟进 0 家（共 12 家）", out)
        self.assertIn("主推公司2", out)
        self.assertNotIn("主推公司3", out)
        self.assertIn("其余 9 家未逐条列出", out)
        self.assertNotIn("【跟进】", out)

    def test_4_gt5_only_follow(self):
        """>5 家且只有跟进：跟进前 2 + 其余数量。"""
        follow = _lines(6, "跟进")
        out = format_onsite_card(HEADER, [], follow)
        self.assertIn("主推 0 家 · 跟进 6 家（共 6 家）", out)
        self.assertIn("跟进公司1", out)
        self.assertNotIn("跟进公司2", out)
        self.assertIn("其余 4 家未逐条列出", out)
        self.assertNotIn("【主推】", out)

    def test_5_limit_boundary(self):
        """刚好 = limit 时仍逐条（不触发收敛）。"""
        main = _lines(3, "主推")
        follow = _lines(2, "跟进")
        out = format_onsite_card(HEADER, main, follow)
        self.assertNotIn("共", out.split("\n")[1] if "\n" in out else "")
        self.assertIn("主推公司2", out)
        self.assertIn("跟进公司1", out)

    def test_6_empty_no_card(self):
        """空输入不应产出收敛文案（调用方在 run 里已判空）。"""
        out = format_onsite_card(HEADER, [], [])
        self.assertEqual(out, HEADER)


if __name__ == "__main__":
    unittest.main(verbosity=2)
