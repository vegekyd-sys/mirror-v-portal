#!/usr/bin/env python3
"""去重测试：精确重复 / 缩放重压后的近似重复 / 不同图不误判。"""
from __future__ import annotations
import sys, tempfile, unittest
from pathlib import Path
MIO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIO))
import dc_kb_engine as kbe
import dc_material_dedup as dd


def make_png(path: Path, seed: int = 0, size=(240, 180)):
    from PIL import Image
    im = Image.new("RGB", size)
    px = im.load()
    for y in range(size[1]):
        for x in range(size[0]):
            px[x, y] = ((x * 3 + seed) % 256, (y * 5 + seed * 7) % 256, (x + y + seed) % 256)
    im.save(path)


class DedupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._d, self._sid = kbe.KB_DIR, kbe._resolve_supplier_id
        kbe.KB_DIR = Path(self.tmp.name) / "mem"
        kbe._resolve_supplier_id = lambda: ""

    def tearDown(self):
        kbe.KB_DIR, kbe._resolve_supplier_id = self._d, self._sid
        self.tmp.cleanup()

    def test_exact_duplicate_detected(self):
        a = Path(self.tmp.name) / "a.png"; make_png(a, seed=1)
        b = Path(self.tmp.name) / "b_same_bytes.png"; b.write_bytes(a.read_bytes())
        dd.register("e1", dd.fingerprint(a), file=str(a))
        r = dd.check("e1", b)
        self.assertEqual(r["duplicate"]["match"], "exact")

    def test_near_duplicate_after_resize_and_recompress(self):
        a = Path(self.tmp.name) / "orig.png"; make_png(a, seed=3)
        from PIL import Image
        b = Path(self.tmp.name) / "resized.jpg"          # 缩放 + 有损压缩 + 改扩展名
        with Image.open(a) as im:
            im.resize((120, 90)).convert("RGB").save(b, quality=60)
        dd.register("e1", dd.fingerprint(a), file=str(a))
        r = dd.check("e1", b)
        self.assertIsNotNone(r["duplicate"], "缩放重压后应判为近似重复")
        self.assertIn(r["duplicate"]["match"], ("exact", "near"))

    def test_different_images_not_flagged(self):
        a = Path(self.tmp.name) / "a.png"; make_png(a, seed=1)
        c = Path(self.tmp.name) / "c.png"; make_png(c, seed=99, size=(200, 300))
        dd.register("e1", dd.fingerprint(a), file=str(a))
        self.assertIsNone(dd.check("e1", c)["duplicate"])

    def test_hamming_utility(self):
        self.assertEqual(dd.hamming("0000000000000000", "0000000000000000"), 0)
        self.assertEqual(dd.hamming("0000000000000000", "0000000000000001"), 1)
        self.assertEqual(dd.hamming("", "ffff"), 64)

    def test_ingest_skips_duplicate(self):
        import dc_material_ingest as mi
        a = Path(self.tmp.name) / "p.png"; make_png(a, seed=5)
        b = Path(self.tmp.name) / "p_copy.png"; b.write_bytes(a.read_bytes())
        r1 = mi.ingest(enterprise="e1", file_path=a, auto_target=False)
        self.assertTrue(r1["verified_readable"])
        r2 = mi.ingest(enterprise="e1", file_path=b, auto_target=False)
        self.assertTrue(r2.get("skipped_write"))
        self.assertEqual(r2["duplicate_of"]["match"], "exact")
        r3 = mi.ingest(enterprise="e1", file_path=b, auto_target=False, allow_duplicate=True)
        self.assertFalse(r3.get("skipped_write"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
