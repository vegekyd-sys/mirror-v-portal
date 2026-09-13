#!/usr/bin/env python3
"""dc_material_ingest 测试：上传物料 → 落库 → 可被下游读接口取到（离线）。"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

MIO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIO))

import dc_kb_engine as kbe  # noqa: E402
import dc_material_ingest as mi  # noqa: E402


class IngestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._orig_dir = kbe.KB_DIR
        kbe.KB_DIR = Path(self.tmp.name) / "memory"
        kbe.KB_DIR.mkdir(parents=True, exist_ok=True)
        # 环境隔离：运行时 .env 里有真实 supplier id，会把 _key() 顶掉 → 测试内固定为空
        self._orig_sid = kbe._resolve_supplier_id
        kbe._resolve_supplier_id = lambda: ""
        self.src = Path(self.tmp.name) / "产品目录 2026.pdf"
        self.src.write_bytes(b"%PDF-1.4 fake catalog bytes")

    def tearDown(self):
        kbe._resolve_supplier_id = self._orig_sid
        kbe.KB_DIR = self._orig_dir
        self.tmp.cleanup()

    def test_ingest_writes_and_is_readable_downstream(self):
        r = mi.ingest(enterprise="100000834234", file_path=self.src, mtype="catalog",
                      description="2026 版产品目录", text="猫爬架 产品目录 正文")
        self.assertTrue(r["verified_readable"])
        self.assertEqual(r["type"], "catalog")
        # 文件本体归档
        self.assertTrue(Path(r["file"]).exists())
        # 解析文本留存
        self.assertTrue(Path(r["content_file"]).exists())
        self.assertIn("猫爬架", Path(r["content_file"]).read_text(encoding="utf-8"))
        # 下游读接口能取到（这就是"后续调用得到"的判据）
        links = {m["type"]: m for m in kbe.KBEngine().get_material_links("100000834234")}
        self.assertIn("catalog", links)
        self.assertEqual(links["catalog"]["name"], "产品目录 2026")
        # kb.json 落盘校验
        kb = json.loads((kbe.KB_DIR / "100000834234" / "kb.json").read_text(encoding="utf-8"))
        self.assertEqual(kb["materials"]["catalog"]["status"], "ready")
        self.assertEqual(kb["materials"]["catalog"]["sha256"], r["sha256"])

    def test_idempotent_reingest(self):
        mi.ingest(enterprise="e1", file_path=self.src, mtype="catalog")
        r2 = mi.ingest(enterprise="e1", file_path=self.src, mtype="catalog")
        self.assertTrue(r2["idempotent_update"])
        kb = json.loads((kbe.KB_DIR / "e1" / "kb.json").read_text(encoding="utf-8"))
        ready = [k for k, v in kb["materials"].items() if v.get("status") == "ready"]
        self.assertEqual(ready, ["catalog"])          # 只置 ready 该类型，不重复建条目

    def test_bitable_skipped_without_params_not_faked(self):
        r = mi.ingest(enterprise="e1", file_path=self.src, mtype="catalog")
        self.assertTrue(r["bitable"]["skipped"])                  # 不谎报已同步文档

    def test_type_inference(self):
        self.assertEqual(mi.infer_type("产品报价单.xlsx"), "price")
        self.assertEqual(mi.infer_type("ISO证书.pdf"), "certificate")
        self.assertEqual(mi.infer_type("random.pdf"), "catalog")
        self.assertEqual(mi.infer_type("x.mp4"), "video")

    def test_errors(self):
        with self.assertRaises(FileNotFoundError):
            mi.ingest(enterprise="e1", file_path=Path(self.tmp.name) / "nope.pdf")
        with self.assertRaises(ValueError):
            mi.ingest(enterprise="e1", file_path=self.src, mtype="不存在的类型")


if __name__ == "__main__":
    unittest.main(verbosity=2)
