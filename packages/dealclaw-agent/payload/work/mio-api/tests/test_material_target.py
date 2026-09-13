#!/usr/bin/env python3
"""dc_material_target 测试：缓存命中 / 发现已有表 / 兜底创建（全部离线）。"""
from __future__ import annotations
import sys, tempfile, unittest
from pathlib import Path
MIO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIO))
import dc_kb_engine as kbe
import dc_material_target as dmt


class TargetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._d, self._sid = kbe.KB_DIR, kbe._resolve_supplier_id
        kbe.KB_DIR = Path(self.tmp.name); kbe._resolve_supplier_id = lambda: ""
        self.calls = []
        self._lark = dmt._lark
        def fake(*args, **kw):
            self.calls.append(args[:3])
            if "+table-list" in args: return {"data": {"items": []}}
            if "+base-create" in args: return {"data": {"app_token": "base_new"}}
            if "+table-create" in args: return {"data": {"table_id": "tbl_new"}}
            if "+field-list" in args: return {"data": {"items": [{"field_name": "附件", "field_id": "fld_att"}]}}
            return {}
        dmt._lark = fake

    def tearDown(self):
        dmt._lark = self._lark
        kbe.KB_DIR, kbe._resolve_supplier_id = self._d, self._sid
        self.tmp.cleanup()

    def test_creates_when_missing_and_caches(self):
        t = dmt.resolve_target("e1", company_name="卓立家具")
        self.assertTrue(t["created"])
        self.assertEqual((t["base_token"], t["table_id"], t["attachment_field_id"]),
                         ("base_new", "tbl_new", "fld_att"))
        t2 = dmt.resolve_target("e1")
        self.assertEqual(t2["source"], "cache")
        self.assertEqual([c for c in self.calls if "+base-create" in c].__len__(), 1)

    def test_discovers_existing_table(self):
        dmt._lark = lambda *a, **k: ({"data": {"items": [{"name": "物料表", "table_id": "tbl_old"}]}}
                                     if "+table-list" in a else
                                     {"data": {"items": [{"field_name": "附件", "field_id": "fld_x"}]}})
        t = dmt.resolve_target("e2", known_base_token="base_old")
        self.assertFalse(t["created"])
        self.assertEqual(t["table_id"], "tbl_old")
        self.assertEqual(t["source"], "discovered")

    def test_no_create_raises(self):
        with self.assertRaises(RuntimeError):
            dmt.resolve_target("e3", create_if_missing=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
