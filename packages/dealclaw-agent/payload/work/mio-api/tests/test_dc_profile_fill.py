#!/usr/bin/env python3
"""dc_profile_fill 测试：类目对齐、合并/diff、只读默认与批量隔离（全部离线）。"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

MIO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIO))

import dc_profile_fill as pf  # noqa: E402

TREE = [{"id": "114", "name": "宠物", "children": [
    {"id": "114001", "name": "宠物用品", "children": [
        {"id": "114001009", "name": "宠物玩具", "children": [
            {"id": "13573", "name": "猫爬架"},
            {"id": "13574", "name": "猫抓板"},
        ]},
        {"id": "13324", "name": "猫窝"},
    ]},
    {"id": "114002", "name": "宠物医疗及保健"},
]}]


class CategoryTests(unittest.TestCase):
    def setUp(self):
        self.flat = pf.flatten_categories(TREE)

    def test_flatten_keeps_paths_and_levels(self):
        cat = [n for n in self.flat if n["name"] == "猫爬架"][0]
        self.assertEqual(cat["path"], ["宠物", "宠物用品", "宠物玩具", "猫爬架"])
        self.assertEqual(cat["ids"], ["114", "114001", "114001009", "13573"])
        self.assertEqual(cat["level"], 4)

    def test_match_prefers_usable_level(self):
        hits = pf.match_categories(["宠物玩具"], self.flat)
        self.assertTrue(hits)
        self.assertEqual(hits[0]["name"], "宠物玩具")
        self.assertGreaterEqual(hits[0]["level"], 2)

    def test_match_cat_tree_hits_leaf(self):
        hits = pf.match_categories(["cat tree", "猫爬架"], self.flat)
        names = [h["name"] for h in hits]
        self.assertIn("猫爬架", names)

    def test_no_match_returns_empty(self):
        self.assertEqual(pf.match_categories(["forklift"], self.flat), [])


class MergeTests(unittest.TestCase):
    def test_only_changed_fields_are_sent(self):
        cur = {"product_tags": "旧标签", "advantage": "保持不动"}
        prop = {"product_tags": ["猫爬架", "宠物家具"], "advantage": "保持不动", "ad_products": ["猫爬架"]}
        payload = pf.merge_edit(cur, prop)
        self.assertEqual(payload["--product-tags"], "猫爬架, 宠物家具")
        self.assertEqual(payload["--ad-products"], "猫爬架")
        self.assertNotIn("--advantage", payload)      # 未变化不写

    def test_empty_proposed_is_skipped(self):
        self.assertEqual(pf.merge_edit({}, {"product_tags": [], "advantage": ""}), {})

    def test_same_value_is_noop(self):
        self.assertEqual(pf.merge_edit({"product_tags": "猫爬架"}, {"product_tags": "猫爬架"}), {})


class DiffTests(unittest.TestCase):
    def test_diff_marks_pending_fields(self):
        cur = {"product_tags": ""}
        prop = {"product_tags": ["猫爬架"], "ad_products": ["猫爬架"], "advantage": "自有工厂"}
        payload = pf.merge_edit(cur, prop)
        text = pf.render_diff(cur, prop, payload, [])
        self.assertIn("（空）", text)
        self.assertIn("猫爬架", text)
        self.assertIn("✱待写", text)

    def test_current_profile_reads_aliases(self):
        self.assertEqual(pf.current_profile({"productTags": "A", "advantage": "B"}),
                         {"product_tags": "A", "advantage": "B"})


class ReadOnlyAndApplyTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self._orig_info = pf.company_info
        self._orig_apply = pf.apply_edit
        pf.company_info = lambda oid, sid: {"companyName": "杭州卓立家具有限公司",
                                           "productTags": "", "advantage": ""}
        def fake_apply(payload, *, open_id, supplier_id):
            self.calls.append((payload, supplier_id))
            return {"code": 200}
        pf.apply_edit = fake_apply

    def tearDown(self):
        pf.company_info = self._orig_info
        pf.apply_edit = self._orig_apply

    def test_default_is_read_only(self):
        r = pf.fill_one(open_id="o", supplier_id="s",
                        extract={"product_tags": ["猫爬架"], "ad_products": ["猫爬架"], "advantage": "自有工厂"},
                        flat_cats=pf.flatten_categories(TREE), apply=False)
        self.assertEqual(self.calls, [])                      # 没写
        self.assertIn("--product-tags", r["edit_payload"])     # 但给出了待写 payload
        self.assertEqual(r["company"], "杭州卓立家具有限公司")

    def test_apply_writes_only_changed(self):
        r = pf.fill_one(open_id="o", supplier_id="s",
                        extract={"product_tags": ["猫爬架"], "ad_products": ["猫爬架"], "advantage": ""},
                        flat_cats=pf.flatten_categories(TREE), apply=True)
        self.assertEqual(len(self.calls), 1)
        payload, sid = self.calls[0]
        self.assertEqual(sid, "s")
        self.assertEqual(set(payload), {"--product-tags", "--ad-products"})
        self.assertIn("apply_result", r)

    def test_no_changes_no_write(self):
        r = pf.fill_one(open_id="o", supplier_id="s",
                        extract={"product_tags": [], "ad_products": [], "advantage": ""},
                        flat_cats=[], apply=True)
        self.assertEqual(self.calls, [])
        self.assertEqual(r["edit_payload"], {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
