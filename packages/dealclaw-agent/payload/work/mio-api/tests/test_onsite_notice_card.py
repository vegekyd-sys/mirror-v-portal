#!/usr/bin/env python3
"""test_onsite_notice_card.py — 「邀约买家到场」卡片两个问题的回归测试（2026-09-14 田耕郡报）

问题：
  ① 输出提示信息中英文混杂 —— 简介优先取英文 `company_profile`；兜底把英文
     buyer_characteristics 与中文「行业：」拼在一起；标签还写了英文缩写 `电话/WA`
  ② 公司简介被截断 —— `fetch_company_intro` 里 `profile[:120]` 硬截

修复口径：
  · 中文字段优先（买家公司简介 / companyProfileCn / company_profile_cn），英文兜底
  · 纯英文简介在中文卡片里**标注为「公司介绍（英文原文）」**，不再裸混排
  · 简介不做 120 硬截；超 INTRO_MAX_LEN 才在句读处截断 + 省略号
  · 标签统一中文（电话/WhatsApp）

运行：cd work/mio-api && python3 -m unittest tests.test_onsite_notice_card -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import monitor_buyer_onsite as M  # noqa: E402


class CardTextTest(unittest.TestCase):
    def test_labels_are_chinese_only(self):
        """标签不再出现英文缩写 WA。"""
        n = {"company": "Acme", "content": "买家姓名：张三\n手机号码：#a+8613800138000#A\n到场时间（本地）：2026-09-14 10:00"}
        text = M.format_card_text(n)
        self.assertIn("电话/WhatsApp：+8613800138000", text)
        self.assertNotIn("电话/WA：", text)
        self.assertNotIn("#a", text)

    def test_content_aliases(self):
        """content 里的常见中文别名都要能解析。"""
        n = {"company": "Acme", "content": "联系人：李四\n电话：021-1234\n到场时间(本地)：2026-09-14 09:30"}
        text = M.format_card_text(n)
        self.assertIn("联系人：李四", text)
        self.assertIn("电话/WhatsApp：021-1234", text)
        self.assertIn("到场时间：2026-09-14 09:30", text)

    def test_chinese_intro_not_labelled_as_original(self):
        n = {"company": "Acme", "_intro": "上海某公司，主营叉车租赁。"}
        text = M.format_card_text(n)
        self.assertIn("公司介绍：上海某公司", text)
        self.assertNotIn("英文原文", text)

    def test_english_intro_is_labelled(self):
        """纯英文简介要标注原文，避免与中文标签混排成「中英混杂」。"""
        n = {"company": "Acme", "_intro": "We are a leading forklift dealer in Vietnam."}
        text = M.format_card_text(n)
        self.assertIn("公司介绍（英文原文）：We are a leading", text)

    def test_mixed_intro_with_cjk_not_labelled(self):
        n = {"company": "Acme", "_intro": "Vietnam 叉车经销商，主营租赁"}
        self.assertNotIn("英文原文", M.format_card_text(n))

    # ── 2026-09-15 截图实证：平台把邮箱塞进「联系人」字段 ──
    def test_contact_email_not_duplicated(self):
        """联系人=邮箱（截图里的 ALIMENTOS 卡）→ 不再重复显示为联系人。"""
        n = {"company": "ALIMENTOS", "contactName": "gcorral@colpac.com.mx",
             "email": "gcorral@colpac.com.mx"}
        text = M.format_card_text(n)
        self.assertNotIn("联系人：gcorral@", text)
        self.assertEqual(text.count("gcorral@colpac.com.mx"), 1)
        self.assertIn("邮箱：gcorral@colpac.com.mx", text)

    def test_contact_email_backfills_email_when_empty(self):
        """联系人形如邮箱、而邮箱为空 → 回填到邮箱行，不丢信息。"""
        n = {"company": "Acme", "contactName": "a@b.com"}
        text = M.format_card_text(n)
        self.assertNotIn("联系人：", text)
        self.assertIn("邮箱：a@b.com", text)

    def test_real_contact_name_still_shown(self):
        n = {"company": "Solarvolt", "contactName": "Paty Rico",
             "email": "sergio@example.com"}
        text = M.format_card_text(n)
        self.assertIn("联系人：Paty Rico", text)
        self.assertIn("邮箱：sergio@example.com", text)


class IntroFetchTest(unittest.TestCase):
    """fetch_company_intro：不硬截 + 中文字段优先 + 失败静默。"""

    def _patch(self, detail: dict, search_hit: bool = True):
        def fake(*args, **kwargs):
            if args[:2] == ("buyer", "onsite"):
                recs = [{"purchaserId": "P1", "companyName": "ACME", "companyCdpid": "CDP1"}] if search_hit else []
                return {"response": {"data": {"records": recs}}}
            # buyer detail
            return {"response": {"data": detail}}
        return mock.patch.object(M, "_run_xiaoyuan", side_effect=fake)

    def test_long_profile_not_cut_at_120(self):
        profile = "优质买家。" * 60          # 300 字，超过旧上限 120
        with self._patch({"buyerInfo": {"company_profile": profile}}):
            got = M.fetch_company_intro("ACME", "P1", "E1")
        self.assertEqual(len(got), len(profile), "300 字简介不应被 120 截断")

    def test_over_limit_clipped_with_ellipsis(self):
        profile = "A" * (M.INTRO_MAX_LEN + 200)
        with self._patch({"buyerInfo": {"company_profile": profile}}):
            got = M.fetch_company_intro("ACME", "P1", "E1")
        self.assertLessEqual(len(got), M.INTRO_MAX_LEN + 1)
        self.assertTrue(got.endswith("…"))

    def test_chinese_profile_field_wins(self):
        with self._patch({"buyerInfo": {"companyProfile": "English profile text",
                                        "买家公司简介": "中文简介：越南叉车经销商"}}):
            got = M.fetch_company_intro("ACME", "P1", "E1")
        self.assertEqual(got, "中文简介：越南叉车经销商")

    def test_fallback_puts_chinese_industry_first(self):
        with self._patch({"buyerInfo": {"purchase_big_industry_cns": "机械,五金",
                                        "buyer_characteristics": "strong buyer, big volume"}}):
            got = M.fetch_company_intro("ACME", "P1", "E1")
        self.assertTrue(got.startswith("行业：机械/五金"), got)
        self.assertIn("strong buyer", got)

    def test_silent_on_failure(self):
        with mock.patch.object(M, "_run_xiaoyuan", side_effect=RuntimeError("boom")):
            self.assertEqual(M.fetch_company_intro("ACME", "P1", "E1"), "")

    def test_no_cdp_id_returns_empty(self):
        with self._patch({"buyerInfo": {"company_profile": "x"}}, search_hit=False):
            self.assertEqual(M.fetch_company_intro("ACME", "P1", "E1"), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
