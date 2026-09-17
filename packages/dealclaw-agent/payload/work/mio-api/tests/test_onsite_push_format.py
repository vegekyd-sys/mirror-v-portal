"""现场推荐推送改版测试（2026-09-17 田耕郡口径）。

要求（原话）：「这推送太傻了，光给人家一个名字…限制一下每个定时最多推十家吧，
公司名+到场联系人+一句话简介。直接发到展位的邀约，如果用户需要直接打电话联系，
也能看到联系方式」

覆盖：
  · 展示行 = 公司名｜到场联系人（电话）｜一句话简介；缺字段如实标「未提供」，不编
  · 每个定时最多 10 家（主推优先入选；超出部分顺延，不丢）
  · 简介去标签 + 限长

跑法：cd <mio-api> && python3 -m unittest tests.test_onsite_push_format
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[1]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

import dc_onsite_recommend as dr  # noqa: E402


def buyer(**kw):
    base = {"companyName": "Electromart SA", "countryCnName": "墨西哥",
            "companyAttributes": [1], "contactName": "Roman Masso",
            "phone": "+52 55 5917 6746", "companyProfile": "<p>33 年老牌家电分销商</p>"}
    base.update(kw)
    return base


class DisplayLine(unittest.TestCase):
    def test_line_has_company_contact_phone_intro(self):
        tier, line = dr.classify(buyer(), ["furniture"])
        self.assertEqual(tier, "主推")
        self.assertIn("Electromart SA", line)
        self.assertIn("到场联系人 Roman Masso", line)
        self.assertIn("+52 55 5917 6746", line)      # 能直接拨号
        self.assertIn("33 年老牌家电分销商", line)     # 一句话简介（去标签）
        self.assertNotIn("<p>", line)

    def test_missing_contact_is_stated_not_invented(self):
        _, line = dr.classify(buyer(contactName="", phone=""), ["furniture"])
        self.assertIn("到场联系人未提供", line)

    def test_phone_only(self):
        _, line = dr.classify(buyer(contactName=""), ["furniture"])
        self.assertIn("电话/WA +52 55 5917 6746", line)

    def test_alternate_field_names_are_supported(self):
        b = {"companyName": "X Co", "linkman": "Li Wei", "mobile": "+86 13800000000",
             "companyProfileCn": "做家电进口"}
        _, line = dr.classify(b, [])
        self.assertIn("Li Wei", line)
        self.assertIn("+86 13800000000", line)
        self.assertIn("做家电进口", line)

    def test_one_liner_truncates_long_text(self):
        long_text = "这是一段很长的公司简介" * 20
        out = dr._one_liner(long_text, limit=20)
        self.assertLessEqual(len(out), 21)
        self.assertTrue(out.endswith("…"))


class PerRunCap(unittest.TestCase):
    def test_cap_keeps_main_first_and_defers_rest(self):
        main = [f"主推{i}" for i in range(8)]
        follow = [f"跟进{i}" for i in range(7)]
        m, f, deferred = dr.cap_per_run(main, follow, limit=10)
        self.assertEqual(len(m) + len(f), 10)
        self.assertEqual(len(m), 8, "主推优先入选")
        self.assertEqual(len(f), 2)
        self.assertEqual(deferred, 5, "超出部分顺延，不丢")

    def test_under_limit_unchanged(self):
        m, f, deferred = dr.cap_per_run(["A"], ["B"], limit=10)
        self.assertEqual((m, f, deferred), (["A"], ["B"], 0))

    def test_invalid_limit_rejected(self):
        with self.assertRaises(ValueError):
            dr.cap_per_run([], [], limit=0)


class Dedupe(unittest.TestCase):
    """截图实证（2026-09-17）：同一家公司被推十几条（XTRANSFER），公司名还带 <em> 标签。"""

    def test_company_name_html_is_stripped(self):
        self.assertEqual(dr.strip_tags("东莞市惠惠<em>高</em>电器有限公司"), "东莞市惠惠高电器有限公司")
        _, line = dr.classify(buyer(companyName="东莞市惠惠<em>高</em>电器有限公司", contactName="", phone=""), [])
        self.assertNotIn("<em>", line)
        self.assertIn("东莞市惠惠高电器有限公司", line)

    def test_same_company_collapses_to_one_row(self):
        many = [{"companyName": "XTRANSFER", "contactName": "A", "phone": "+55 11 1111"},
                {"companyName": "XTRANSFER", "contactName": "B", "phone": "+55 22 2222"},
                {"companyName": "XTRANSFER"}]
        merged = dr.dedupe_buyers(many)
        self.assertEqual(len(merged), 1, "同一公司只能留一条")
        _, line = dr.classify(merged[0], [])
        self.assertIn("A、B", line, "多个联系人并列，不丢人")
        self.assertIn("+55 11 1111", line)
        self.assertIn("+55 22 2222", line)
        self.assertEqual(line.count("XTRANSFER"), 1)

    def test_different_companies_kept_in_order(self):
        merged = dr.dedupe_buyers([{"companyName": "A Co"}, {"companyName": "B Co"},
                                  {"companyName": "a co"}])
        self.assertEqual([m["companyName"] for m in merged], ["A Co", "B Co"], "大小写归一，顺序不变")


if __name__ == "__main__":
    unittest.main()
