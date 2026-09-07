#!/usr/bin/env python3
"""test_frontend_convergence.py — 前台收敛测试（阶段⑥）。

覆盖「前台只重点展示「跟进优先级 + 下一步」，匹配度/阶段收起不铺满」的收敛口径：
  - LEAD_POOL_FIELDS / LEAD_POOL_FIELDS_JSON：冷热退役，followup_priority 在场
  - format_lead_pool_dashboard：≤5 逐条（优先级排序 + 下一步）、>5 分布、error、空
  - _website_link：官网值统一 https（纯域名 / http / markdown 链接三种形态）
  - _followup_table_url：优先沟通明细子表（interaction_table_id）→ 兑底 followup_table_id → bitable_url
  - company_display_name：显式映射 > 绑定 > 画像 kb.json > registry > company_id 的优先级链
"""

import sys
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import json  # noqa: E402
import dc_growth_dashboard as gd  # noqa: E402
import dc_company_registry as cr  # noqa: E402
import dc_daily_report as dr  # noqa: E402


class TestFieldConvergence(unittest.TestCase):
    """字段清单收敛：冷热退役、followup_priority 为主锚。"""

    def test_1_lead_pool_fields_no_hotcold(self):
        """growth dashboard LEAD_POOL_FIELDS 无冷热，有跟进优先级 + 下一步。"""
        names = [f[0] for f in gd.LEAD_POOL_FIELDS]
        self.assertNotIn("hot_cold", names)
        self.assertNotIn("冷热", names)
        self.assertIn("followup_priority", names)
        self.assertIn("priority_reason", names)
        self.assertIn("next_action", names)

    def test_2_registry_fields_converged(self):
        """registry 线索池字段 JSON：冷热已删，跟进优先级/优先级理由/下一步在场。"""
        names = [f["name"] for f in json.loads(cr.LEAD_POOL_FIELDS_JSON)]
        self.assertNotIn("冷热", names)
        self.assertIn("跟进优先级", names)
        self.assertIn("优先级理由", names)
        self.assertIn("下一步动作", names)

    def test_3_expected_field_names_converged(self):
        """EXPECTED_FIELD_NAMES 同步收敛（无冷热，有 6 项优先级字段）。"""
        self.assertNotIn("冷热", cr.EXPECTED_FIELD_NAMES)
        for name in ("跟进优先级", "优先级理由", "下一步动作", "截止时间",
                     "联系策略", "商机状态", "优先级规则版本", "优先级更新时间"):
            self.assertIn(name, cr.EXPECTED_FIELD_NAMES)


class TestFormatLeadPoolDashboard(unittest.TestCase):
    """前台展示收敛：重点展示优先级 + 下一步。"""

    def _d(self, rows, **kw):
        d = {"company_name": "测试企业", "total": len(rows),
             "bitable_url": "", "rows": rows}
        d.update(kw)
        return d

    def test_4_le5_sorted_by_priority(self):
        """≤5 逐条，按优先级排序，优先跟进在前。"""
        rows = [
            {"company": "B公司", "followup_priority": "普通跟进", "next_action": "发第二封",
             "due": "2026-09-08", "country": "德国", "buyer_type": "经销商"},
            {"company": "A公司", "followup_priority": "优先跟进", "next_action": "发报价",
             "due": "2026-09-07", "country": "墨西哥", "buyer_type": "品牌商"},
            {"company": "C公司", "followup_priority": "长期培育", "next_action": "",
             "due": "", "country": "", "buyer_type": ""},
        ]
        out = gd.format_lead_pool_dashboard(self._d(rows))
        self.assertIn("A公司", out)
        self.assertIn("优先跟进", out)
        self.assertIn("发报价｜2026-09-07", out)
        self.assertLess(out.index("A公司"), out.index("B公司"))
        self.assertLess(out.index("B公司"), out.index("C公司"))

    def test_5_gt5_distribution(self):
        """>5 条：优先级分布 + 优先跟进列表（不逐条铺满）。"""
        rows = []
        for i in range(6):
            rows.append({"company": f"公司{i}",
                         "followup_priority": "优先跟进" if i < 2 else ("普通跟进" if i < 5 else "长期培育"),
                         "next_action": "发邮件", "due": "", "country": "", "buyer_type": ""})
        out = gd.format_lead_pool_dashboard(self._d(rows))
        self.assertIn("优先级：普通跟进 3、优先跟进 2、长期培育 1", out)
        self.assertIn("优先跟进：", out)
        self.assertIn("公司0", out)
        # 逐条公司名（如 公司5）不应出现，收敛为分布
        self.assertNotIn("公司5", out)

    def test_6_error(self):
        """error 时只给提示，不编造。"""
        out = gd.format_lead_pool_dashboard(self._d([], error="memory 无线索数据"))
        self.assertIn("memory 无线索数据", out)

    def test_7_empty(self):
        """无数据 → 暂无数据。"""
        out = gd.format_lead_pool_dashboard(self._d([]))
        self.assertIn("暂无数据", out)

    def test_8_bitable_url_present(self):
        """有飞书表格链接时带跳转。"""
        d = self._d([{"company": "A", "followup_priority": "优先跟进",
                      "next_action": "发报价", "due": "", "country": "", "buyer_type": ""}],
                    bitable_url="https://versa-ai.feishu.cn/base/abc")
        out = gd.format_lead_pool_dashboard(d)
        self.assertIn("https://versa-ai.feishu.cn/base/abc", out)


class TestWebsiteLink(unittest.TestCase):
    def test_9_plain_domain(self):
        self.assertEqual(gd._website_link("cafecalupoh.mx"),
                         "[cafecalupoh.mx](https://cafecalupoh.mx)")

    def test_10_http_upgraded(self):
        self.assertEqual(gd._website_link("http://foo.com"), "[http://foo.com](https://foo.com)")

    def test_11_markdown_link(self):
        self.assertEqual(gd._website_link("[域名](http://foo.com)"), "[域名](https://foo.com)")

    def test_12_empty(self):
        self.assertEqual(gd._website_link(""), "—")


class TestFollowupTableUrl(unittest.TestCase):
    def test_13_interaction_table_preferred(self):
        """有 interaction_table_id 时优先指向沟通明细子表。"""
        entry = {"app_token": "tok", "interaction_table_id": "tbl_inter",
                 "followup_table_id": "tbl_old", "bitable_url": "https://x"}
        with unittest.mock.patch.object(cr.CompanyRegistry, "get", return_value=entry):
            url = dr._followup_table_url("testco")
        self.assertIn("table=tbl_inter", url)

    def test_14_fallback_followup_table(self):
        """无 interaction_table_id 兑底旧 followup_table_id。"""
        entry = {"app_token": "tok", "followup_table_id": "tbl_old", "bitable_url": "https://x"}
        with unittest.mock.patch.object(cr.CompanyRegistry, "get", return_value=entry):
            url = dr._followup_table_url("testco")
        self.assertIn("table=tbl_old", url)

    def test_15_fallback_bitable_url(self):
        """无表 id 兑底 bitable_url。"""
        entry = {"app_token": "", "bitable_url": "https://x/base/abc"}
        with unittest.mock.patch.object(cr.CompanyRegistry, "get", return_value=entry):
            url = dr._followup_table_url("testco")
        self.assertEqual(url, "https://x/base/abc")

    def test_16_no_entry_empty(self):
        with unittest.mock.patch.object(cr.CompanyRegistry, "get", return_value=None):
            self.assertEqual(dr._followup_table_url("testco"), "")


class TestCompanyDisplayName(unittest.TestCase):
    def test_17_explicit_map_priority(self):
        """显式映射覆盖一切（含 CDP/kb.json 因 supplier id 复用产生的混乱）。"""
        self.assertEqual(dr.company_display_name("151897148668"),
                         "中亿丰罗普斯金材料科技股份有限公司")

    def test_18_unknown_falls_back_to_id(self):
        with unittest.mock.patch.object(cr.CompanyRegistry, "get", return_value=None):
            self.assertEqual(dr.company_display_name("nope_123"), "nope_123")


if __name__ == "__main__":
    unittest.main(verbosity=2)
