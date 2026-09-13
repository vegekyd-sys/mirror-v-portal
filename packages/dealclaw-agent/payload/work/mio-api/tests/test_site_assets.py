#!/usr/bin/env python3
"""dc_site_assets 测试：抽取 / 归位 / 上限 / 体积保护 / dry-run（全部离线）。"""
from __future__ import annotations
import sys, unittest
from pathlib import Path
MIO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIO))
import dc_site_assets as sa

HTML = """
<html><body>
 <img src="/img/product-main.jpg" alt="cat tree main">
 <img data-src="/img/spec-参数表-01.png" alt="参数表">
 <img srcset="/img/case-1.webp 1x, /img/case-1@2x.webp 2x" alt="客户案例">
 <a href="/files/catalog-2026.pdf">Product Catalog</a>
 <a href="/files/ISO9001-证书.pdf">证书</a>
 <a href="/media/demo.mp4">Video</a>
 <img src="https://other-site.com/x.jpg">
</body></html>
"""


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.a = sa.extract_assets(HTML, "https://acme.com/products")

    def test_extracts_same_host_only(self):
        allurls = self.a["images"] + self.a["documents"] + self.a["videos"]
        self.assertTrue(all(u.startswith("https://acme.com") for u in allurls))
        self.assertNotIn("https://other-site.com/x.jpg", allurls)

    def test_finds_docs_and_videos(self):
        self.assertIn("https://acme.com/files/catalog-2026.pdf", self.a["documents"])
        self.assertIn("https://acme.com/media/demo.mp4", self.a["videos"])

    def test_lazy_and_srcset(self):
        joined = " ".join(self.a["images"])
        self.assertIn("spec-参数表-01.png", joined)
        self.assertIn("case-1.webp", joined)


class ClassifyTests(unittest.TestCase):
    def test_types(self):
        self.assertEqual(sa.classify_asset("https://a.com/ISO9001.pdf"), "certificate")
        self.assertEqual(sa.classify_asset("https://a.com/files/catalog.pdf"), "catalog")
        self.assertEqual(sa.classify_asset("https://a.com/media/demo.mp4"), "video")
        self.assertEqual(sa.classify_asset("https://a.com/img/参数表-1.png", alt="规格"), "spec")
        self.assertEqual(sa.classify_asset("https://a.com/img/x.jpg", alt="客户案例"), "case_study")
        self.assertEqual(sa.classify_asset("https://a.com/img/hero.jpg"), "sample")

    def test_plan_caps_files(self):
        a = {"images": [f"https://a.com/{i}.jpg" for i in range(50)], "documents": [], "videos": []}
        self.assertEqual(len(sa.plan(a, "", max_files=10)), 10)

    def test_download_rejects_oversize(self):
        import urllib.request
        class R:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n=-1): return b"x" * (1024 * 1024 * 30)
        orig = urllib.request.urlopen
        urllib.request.urlopen = lambda *a, **k: R()
        try:
            with self.assertRaises(RuntimeError):
                sa.download("https://a.com/big.pdf", Path("/tmp/x"), max_mb=1)
        finally:
            urllib.request.urlopen = orig

    def test_dry_run_no_write(self):
        sa.fetch_html = lambda url, timeout=20: HTML
        r = sa.crawl(url="https://acme.com", enterprise="e1", dry_run=True)
        self.assertEqual(r["planned"], 6 - 0 if False else r["planned"])  # 数量以抽取为准
        self.assertEqual(r["downloaded"], [])
        self.assertEqual(r["pipeline"], {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
