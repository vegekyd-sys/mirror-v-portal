#!/usr/bin/env python3
"""test_dossier.py — 客户档案文档生成层测试（阶段⑤）。

覆盖：
  - build_dossier_content 纯函数：标题/优先级/下次动作/为什么优先/客户概况/时间线
  - 无互动 → 「暂无互动记录」
  - 时间线正文截断，不铺满
  - dossier_plan：优先跟进→generate/update，普通→skip（归档不删）
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_dossier import (  # noqa: E402
    build_dossier_content,
    dossier_plan,
    _timeline_line,
)

LEAD = {
    "company": "Casa Outdoor",
    "followup_priority": "优先跟进",
    "stage": "报价中",
    "next_action": "发送正式报价",
    "due": "2026-09-10",
    "priority_reason": "本届确认到展；明确询价，承诺今日发报价",
    "country": "墨西哥",
    "buyer_type": "经销商",
    "contact": "Maria Lopez",
    "position": "采购总监",
    "website": "www.casaoutdoor.mx",
}

INTERACTIONS = [
    {"channel": "meeting", "direction": "system", "occurred_at": "2026-09-08T10:00:00+00:00",
     "subject": "", "summary": "现场会谈，确认酒店项目需求"},
    {"channel": "email", "direction": "outbound", "occurred_at": "2026-09-09T09:00:00+00:00",
     "subject": "产品目录", "summary": "已发送产品目录"},
]


class TestBuildDossierContent(unittest.TestCase):
    def test_1_header_priority_stage(self):
        """标题 + 优先级·阶段头部。"""
        content = build_dossier_content(LEAD, INTERACTIONS)
        self.assertIn("# Casa Outdoor", content)
        self.assertIn("优先跟进 · 报价中", content)

    def test_2_next_action_and_due(self):
        """下次动作 + 截止时间。"""
        content = build_dossier_content(LEAD, INTERACTIONS)
        self.assertIn("发送正式报价", content)
        self.assertIn("2026-09-10", content)

    def test_3_priority_reason(self):
        """为什么优先（证据化理由）。"""
        content = build_dossier_content(LEAD, INTERACTIONS)
        self.assertIn("为什么优先", content)
        self.assertIn("本届确认到展", content)

    def test_4_customer_profile(self):
        """客户概况：国家/类型/联系人/职位/官网。"""
        content = build_dossier_content(LEAD, INTERACTIONS)
        self.assertIn("墨西哥 · 经销商", content)
        self.assertIn("Maria Lopez｜采购总监", content)
        self.assertIn("www.casaoutdoor.mx", content)

    def test_5_timeline(self):
        """沟通时间线，两行互动。"""
        content = build_dossier_content(LEAD, INTERACTIONS)
        self.assertIn("会议", content)
        self.assertIn("邮件", content)
        self.assertIn("现场会谈", content)

    def test_6_empty_interactions(self):
        """无互动 → 暂无互动记录。"""
        content = build_dossier_content(LEAD, [])
        self.assertIn("暂无互动记录", content)

    def test_7_summary_truncated(self):
        """时间线正文截断，不铺满。"""
        long_summary = "很长的会议纪要" * 100
        it = {"channel": "meeting", "occurred_at": "2026-09-08T10:00:00+00:00",
              "summary": long_summary}
        line = _timeline_line(it)
        self.assertLessEqual(len(line), 300)
        self.assertNotEqual(line.rstrip(), f"- 2026-09-08 · 会议\n  {long_summary}")


class TestDossierPlan(unittest.TestCase):
    def test_8_priority_generate(self):
        """优先跟进且无文档 → generate。"""
        plan = dossier_plan([dict(LEAD)])
        self.assertEqual(plan[0][1], "generate")

    def test_9_priority_with_doc_update(self):
        """优先跟进已有文档 → update。"""
        lead = dict(LEAD, dossier_url="https://xxx.feishu.cn/docx/doxcn123")
        plan = dossier_plan([lead])
        self.assertEqual(plan[0][1], "update")

    def test_10_normal_skip(self):
        """普通跟进 → skip（按需，不自动生成）。"""
        lead = dict(LEAD, followup_priority="普通跟进")
        plan = dossier_plan([lead])
        self.assertEqual(plan[0][1], "skip")

    def test_11_downgrade_archive_not_delete(self):
        """降级（有文档但优先级降为普通）→ skip，文档保留不删。"""
        lead = dict(LEAD, followup_priority="普通跟进",
                    dossier_url="https://xxx.feishu.cn/docx/doxcn123")
        plan = dossier_plan([lead])
        self.assertEqual(plan[0][1], "skip")
        self.assertTrue(lead.get("dossier_url"))  # 文档 URL 保留


if __name__ == "__main__":
    unittest.main(verbosity=2)
