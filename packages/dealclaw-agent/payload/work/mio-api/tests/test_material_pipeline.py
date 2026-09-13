#!/usr/bin/env python3
"""dc_material_pipeline 测试：归位分类 / 双写报告结构（离线）。"""
from __future__ import annotations
import sys, tempfile, unittest
from pathlib import Path
MIO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIO))
import dc_kb_engine as kbe
import dc_material_pipeline as mp


class PipelineTests(unittest.TestCase):
    def test_classify_and_group(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            for n in ("产品主图1.png", "技术参数表-01.png", "公司介绍.pptx", "ISO9001证书.pdf", "演示.mp4", "readme.exe"):
                (d / n).write_bytes(b"x")
            groups = mp.group_files(sorted(p for p in d.rglob("*") if p.is_file()))
            self.assertEqual(sorted(groups), ["catalog", "certificate", "sample", "spec", "video"])
            self.assertEqual(len(groups["sample"]), 1)
            self.assertEqual(len(groups["spec"]), 1)
            self.assertFalse(any("readme.exe" in f for fs in groups.values() for f in fs))

    def test_double_write_report_shape(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td); f = d / "产品主图1.png"; f.write_bytes(b"x")
            kbe.KB_DIR = d / "kb"; kbe._resolve_supplier_id = lambda: ""
            mp.append_doc_section = lambda *a, **k: {"ok": True, "url": "u", "appended_lines": 3}
            r = mp.run([f], enterprise="e1", company_name="测试", auto_target=False)
            dw = r["double_write"]
            self.assertEqual(r["ingested"], 1)
            self.assertTrue(dw["agent_kb"]["ok"])
            self.assertIn("human_table", dw)
            self.assertTrue(dw["human_doc"]["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
