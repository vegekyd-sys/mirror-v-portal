#!/usr/bin/env python3
"""dc_profile_learn 测试：非破坏合并、幂等、provenance、抽取（全部离线）。"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dc_profile_learn as pl  # noqa: E402


class ProfileLearnTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["OPENCLAW_WORKSPACE_DIR"] = self.tmp.name
        self.cid = "t1"

    def tearDown(self):
        os.environ.pop("OPENCLAW_WORKSPACE_DIR", None)
        self.tmp.cleanup()

    def profile(self):
        return pl.load_kb(self.cid).get("profile", {})


class TestMerge(ProfileLearnTestCase):
    def test_1_first_write_fills(self):
        r = pl.learn(self.cid, {"products": ["bag"], "usp": "20 年工厂"}, source="chat", dry_run=False)
        self.assertTrue(r["wrote"])
        self.assertEqual(self.profile()["products"], ["bag"])
        self.assertEqual(self.profile()["usp"], "20 年工厂")

    def test_2_lists_append_not_replace(self):
        pl.learn(self.cid, {"products": ["bag"]}, dry_run=False)
        r = pl.learn(self.cid, {"products": ["pouch"]}, dry_run=False)
        self.assertEqual(r["changed"]["products"], ["pouch"])
        self.assertEqual(self.profile()["products"], ["bag", "pouch"], "列表只能追加")

    def test_3_scalar_never_overwritten(self):
        pl.learn(self.cid, {"usp": "正版描述"}, dry_run=False)
        r = pl.learn(self.cid, {"usp": "矛盾说法"}, dry_run=False)
        self.assertNotIn("usp", r["changed"])
        self.assertEqual(self.profile()["usp"], "正版描述", "标量首次写入即锁定")
        self.assertEqual(self.profile()["_skipped_updates"]["usp"], "矛盾说法", "被拒值要留痕")

    def test_4_idempotent(self):
        pl.learn(self.cid, {"products": ["bag"]}, dry_run=False)
        r = pl.learn(self.cid, {"products": ["bag"]}, dry_run=False)
        self.assertFalse(r["wrote"], "同输入重复跑不应再写")

    def test_5_empty_input_writes_nothing(self):
        r = pl.learn(self.cid, {}, dry_run=False)
        self.assertFalse(r["ok"])
        self.assertFalse(pl.kb_path(self.cid).exists(), "空输入不得创建文件")

    def test_6_dry_run_default(self):
        r = pl.learn(self.cid, {"products": ["bag"]})
        self.assertTrue(r["dry_run"])
        self.assertFalse(pl.kb_path(self.cid).exists())

    def test_7_replace_fields_only_when_named(self):
        pl.learn(self.cid, {"usp": "旧"}, dry_run=False)
        r = pl.learn(self.cid, {"usp": "新"}, replace_fields=["usp"], dry_run=False)
        self.assertEqual(self.profile()["usp"], "新")

    def test_8_alias_normalization(self):
        pl.learn(self.cid, {"公司名": "ACME", "主营产品": "bag, pouch"}, dry_run=False)
        p = self.profile()
        self.assertEqual(p["name"], "ACME")
        self.assertEqual(p["products"], ["bag", "pouch"])

    def test_9_provenance_recorded(self):
        pl.learn(self.cid, {"products": ["bag"]}, source="chat", dry_run=False)
        pl.learn(self.cid, {"target_markets": ["BR"]}, source="task", dry_run=False)
        kb = pl.load_kb(self.cid)
        hist = kb["_learned"]["history"]
        self.assertEqual([h["source"] for h in hist], ["chat", "task"])
        self.assertEqual(kb["_learned"]["last_source"], "task")

    def test_10_no_blank_shell(self):
        """空字符串 / 空列表不得把字段写成空壳。"""
        pl.learn(self.cid, {"products": [], "usp": "", "name": "  "}, dry_run=False)
        self.assertFalse(pl.kb_path(self.cid).exists())


class TestExtract(ProfileLearnTestCase):
    def test_11_extract_countries_certs(self):
        f = pl.extract_facts("主营: packaging bag。通过 CE / ISO9001，成立 2005 年，市场 Brazil, Mexico。")
        self.assertEqual(f["certifications"], ["CE", "ISO9001"])
        self.assertEqual(f["founded"], "2005")
        self.assertEqual(f["target_markets"], ["BR", "MX"])
        self.assertIn("packaging bag", f["products"])

    def test_12_extract_nothing_on_noise(self):
        self.assertEqual(pl.extract_facts("今天天气不错"), {})


class TestCanonicalize(ProfileLearnTestCase):
    def test_13_dict_tags_take_name(self):
        f = pl.canonicalize({"products": [{"name": "Packaging Bag"}]})
        self.assertEqual(f["products"], ["Packaging Bag"])

    def test_14_unknown_field_kept_but_not_overwritten(self):
        pl.learn(self.cid, {"custom_field": "v1"}, dry_run=False)
        r = pl.learn(self.cid, {"custom_field": "v2"}, dry_run=False)
        self.assertNotIn("custom_field", r["changed"])


if __name__ == "__main__":
    unittest.main()
