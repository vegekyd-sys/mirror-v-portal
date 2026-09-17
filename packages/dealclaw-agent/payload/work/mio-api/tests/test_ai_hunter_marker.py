#!/usr/bin/env python3
"""AI Hunter 买家标记展示回归（2026-09-15 田耕郡要求）。

平台 searchAIV2 新字段：hunterBuyerFlag=1、hunterBuyerTypes=[]。
要求：找买家结果必须显示 🤖 AI猎客，批量摘要给出标记家数；
该字段是买家画像标记，不是 Hunter.io 数据源调用。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

MIO = Path(__file__).resolve().parents[1]
WORKSPACE = MIO.parents[1]
SKILL_SCRIPTS = WORKSPACE / "skills" / "dealclaw-find-buyers" / "scripts"
sys.path.insert(0, str(MIO))
sys.path.insert(0, str(SKILL_SCRIPTS))

import dc_buyer_adapter as adapter  # noqa: E402
import search_aiv2  # noqa: E402
from find_buyers_v2 import model_summary, normalize_record  # noqa: E402


class AdapterMarkerTest(unittest.TestCase):
    def test_flag_one_has_label_and_types(self):
        row = adapter.format_record({
            "companyName": "ACME", "hunterBuyerFlag": 1,
            "hunterBuyerTypes": ["AI对话（意图概要）"],
        })
        self.assertTrue(row["aiHunterMarked"])
        self.assertEqual(row["aiHunterTypes"], ["AI对话（意图概要）"])
        self.assertEqual(row["aiHunterLabel"], "🤖 AI猎客｜AI对话（意图概要）")

    def test_flag_zero_is_not_marked(self):
        row = adapter.format_record({"companyName": "NORMAL", "hunterBuyerFlag": 0})
        self.assertFalse(row["aiHunterMarked"])
        self.assertEqual(row["aiHunterLabel"], "")

    def test_summary_counts_hunter_marked_buyers(self):
        result = adapter.format_results({"page": {"records": [
            {"companyName": "A", "hunterBuyerFlag": 1},
            {"companyName": "B", "hunterBuyerFlag": "0"},
            {"companyName": "C", "hunterBuyerFlag": "1", "hunterBuyerTypes": "AI对话（意图概要）"},
        ], "total": 3}}, "forklift", ["VN"])
        self.assertEqual(result["aiHunterCount"], 2)
        self.assertIn("🤖 AI猎客标记 2 家", result["summary"])


class V2MarkerTest(unittest.TestCase):
    def test_normalized_and_model_summary_keep_marker(self):
        norm = normalize_record({
            "companyName": "ACME", "companyWebsite": "acme.example",
            "hunterBuyerFlag": "1", "hunterBuyerTypes": "AI对话（意图概要）,采购意图",
        })
        self.assertTrue(norm["ai_hunter_marked"])
        self.assertEqual(norm["ai_hunter_types"], ["AI对话（意图概要）", "采购意图"])
        self.assertEqual(norm["ai_hunter_label"], "🤖 AI猎客｜AI对话（意图概要）、采购意图")
        row = model_summary([norm])[0]
        self.assertTrue(row["ai_hunter_marked"])
        self.assertEqual(row["ai_hunter_types"], ["AI对话（意图概要）", "采购意图"])


class SearchScriptMarkerTest(unittest.TestCase):
    def test_raw_search_output_is_annotated(self):
        raw = {"response": {"data": {"page": {"records": [
            {"companyName": "A", "hunterBuyerFlag": 1, "hunterBuyerTypes": ["AI对话（意图概要）"]},
            {"companyName": "B", "hunterBuyerFlag": 0},
        ]}}}}
        out = search_aiv2._annotate_ai_hunter(raw)
        data = out["response"]["data"]
        a, b = data["page"]["records"]
        self.assertEqual(data["aiHunterCount"], 1)
        self.assertTrue(a["aiHunterMarked"])
        self.assertEqual(a["aiHunterLabel"], "🤖 AI猎客｜AI对话（意图概要）")
        self.assertFalse(b["aiHunterMarked"])
        self.assertEqual(b["aiHunterLabel"], "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
