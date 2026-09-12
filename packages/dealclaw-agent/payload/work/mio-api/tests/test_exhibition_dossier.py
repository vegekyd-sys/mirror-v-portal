#!/usr/bin/env python3
"""test_exhibition_dossier.py — 展会一客一案生成 单元测试。

覆盖：load_buyers（读 memory 聚合）/ 一览表（空 + 有数据）/ 单客档案（复用 dc_dossier + 邀约补充）/ 完整报告。
全部用临时目录，不触真实数据。
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_exhibition_dossier import (  # noqa: E402
    load_buyers,
    build_index_markdown,
    build_buyer_markdown,
    build_report_markdown,
)


def _write(root, cid, name, data):
    p = Path(root) / "data" / "memory" / cid / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _fixture(td, with_interactions=True):
    _write(td, "sid", "leads.json", [
        {"company": "Casa Outdoor", "company_cdp_id": "cdp_1", "country": "墨西哥",
         "buyer_type": "进口商", "match_grade": "A", "stage": "需求明确",
         "followup_priority": "优先跟进", "next_action": "发报价单", "last_contact_at": "2026-09-08T00:00:00Z"},
    ])
    _write(td, "sid", "interactions.json", [
        {"interaction_id": "i1", "customer_id": "cdp_1", "channel": "email",
         "direction": "inbound", "occurred_at": "2026-09-08T22:10:00Z",
         "subject": "Re: quote", "summary": "要样品"},
    ] if with_interactions else [])
    _write(td, "sid", "exhibition-invitations.json", {"invitations": [
        {"companyCdpId": "cdp_1", "exhibitionName": "Mexico Expo 2026",
         "sendTime": "2026-08-28T09:00:00Z"}]})


class TestLoad(unittest.TestCase):
    def test_load_buyers_aggregates(self):
        with tempfile.TemporaryDirectory() as td:
            _fixture(td)
            buyers = load_buyers("sid", workspace_root=td)
            self.assertEqual(len(buyers), 1)
            b = buyers[0]
            self.assertEqual(b["key"], "cdp_1")
            self.assertEqual(len(b["interactions"]), 1)
            self.assertIsNotNone(b["invitation"])
            self.assertEqual(b["last_interaction_at"], "2026-09-08T22:10:00Z")

    def test_empty_memory(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(load_buyers("sid", workspace_root=td), [])


class TestIndex(unittest.TestCase):
    def test_index_rows(self):
        with tempfile.TemporaryDirectory() as td:
            _fixture(td)
            md = build_index_markdown(load_buyers("sid", workspace_root=td))
            self.assertIn("Casa Outdoor", md)
            self.assertIn("已邀约", md)
            self.assertIn("优先跟进", md)
            self.assertIn("需求明确", md)

    def test_index_empty(self):
        md = build_index_markdown([])
        self.assertIn("共 **0** 家", md)
        self.assertIn("暂无买家记录", md)


class TestBuyerDossier(unittest.TestCase):
    def test_dossier_reuses_dc_dossier_and_adds_invitation(self):
        with tempfile.TemporaryDirectory() as td:
            _fixture(td)
            b = load_buyers("sid", workspace_root=td)[0]
            md = build_buyer_markdown(b)
            self.assertIn("# Casa Outdoor", md)          # dc_dossier 生成
            self.assertIn("沟通时间线", md)
            self.assertIn("要样品", md)
            self.assertIn("展会邀约", md)                 # 展会补充
            self.assertIn("Mexico Expo 2026", md)

    def test_dossier_without_invitation(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [{"company": "X", "company_cdp_id": "c1"}])
            _write(td, "sid", "interactions.json", [])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
            b = load_buyers("sid", workspace_root=td)[0]
            md = build_buyer_markdown(b)
            self.assertNotIn("展会邀约", md)


class TestReport(unittest.TestCase):
    def test_report_has_index_and_dossier(self):
        with tempfile.TemporaryDirectory() as td:
            _fixture(td)
            md = build_report_markdown("sid", workspace_root=td)
            self.assertIn("一览", md)
            self.assertIn("# Casa Outdoor", md)


if __name__ == "__main__":
    unittest.main(verbosity=2)
