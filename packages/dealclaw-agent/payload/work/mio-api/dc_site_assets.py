#!/usr/bin/env python3
"""dc_site_assets — 官网素材抓取器 → 喂进物料「双写」管线。

流程：官网 URL → 抓页面 → 抽资产（产品图 / 文档 / 案例 / 证书 / 视频）+ 文本参数
      → 归位分类 → 下载到本地 → dc_material_pipeline.run()（agent KB + 物料表 + 文档 三侧写）

边界（安全）：
  · 只抓**同域**链接，不跨站爬；不做登录态、不提交表单；
  · 数量/体积上限（--max-files / --max-mb），超限跳过并如实报告；
  · 抓不到就报抓不到，绝不编造素材。

用法：
    python3 dc_site_assets.py --url https://example.com --enterprise <sid> --json
    python3 dc_site_assets.py --url https://x.com --dry-run     # 只抽取不下载/不写
"""
from __future__ import annotations

import argparse
import html as htmllib
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

UA = "Mozilla/5.0 (compatible; DealClawAssetBot/1.0)"
DOC_EXT = (".pdf", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx")
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
VID_EXT = (".mp4", ".mov", ".avi", ".mkv")

CERT_HINT = re.compile(r"cert|证书|认证|资质|iso|ce\b|rohs|reach", re.I)
SPEC_HINT = re.compile(r"spec|参数|规格|datasheet|技术|dimension", re.I)
CASE_HINT = re.compile(r"case|案例|项目|project|solution|客户故事", re.I)
CATALOG_HINT = re.compile(r"catalog|画册|brochure|宣传|手册|介绍|company.?profile", re.I)
VIDEO_HINT = re.compile(r"video|视频|演示|demo", re.I)


def fetch_html(url: str, timeout: int = 20) -> str:
    """抓页面 HTML（urllib，无 JS 渲染）。失败抛异常。"""
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    charset = "utf-8"
    m = re.search(rb'charset=["\']?([\w-]+)', raw[:2048], re.I)
    if m:
        charset = m.group(1).decode("ascii", "ignore")
    try:
        return raw.decode(charset, "ignore")
    except LookupError:
        return raw.decode("utf-8", "ignore")


def text_of(html: str) -> str:
    html = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html or "")
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", html))).strip()


def extract_assets(html: str, base_url: str) -> dict:
    """从 HTML 抽出资产：images / documents / videos（绝对 URL，去重，同域过滤）。"""
    host = urlparse(base_url).netloc
    out = {"images": [], "documents": [], "videos": []}
    seen = set()

    def _add(bucket, raw):
        if not raw:
            return
        u = urljoin(base_url, htmllib.unescape(str(raw).strip()))
        if not u.startswith(("http://", "https://")) or urlparse(u).netloc != host:
            return
        if u in seen:
            return
        seen.add(u)
        out[bucket].append(u)

    # <img src> / srcset / 常见懒加载属性
    for tag in re.findall(r"(?is)<img\b[^>]*>", html or ""):
        for attr in ("data-src", "data-original", "data-lazy-src", "src"):
            m = re.search(rf'{attr}=["\']([^"\']+)["\']', tag, re.I)
            if m:
                _add("images", m.group(1))
                break
        m = re.search(r'srcset=["\']([^"\']+)["\']', tag, re.I)
        if m:
            _add("images", m.group(1).split(",")[0].strip().split(" ")[0])

    # <a href> 指向文档 / 视频
    for tag in re.findall(r"(?is)<a\b[^>]*>", html or ""):
        m = re.search(r'href=["\']([^"\']+)["\']', tag, re.I)
        if not m:
            continue
        href = m.group(1).lower()
        if href.endswith(DOC_EXT):
            _add("documents", m.group(1))
        elif href.endswith(VID_EXT):
            _add("videos", m.group(1))
    for u in re.findall(r'https?://[^\s"\'<>]+\.(?:mp4|mov|avi|mkv)', html or "", re.I):
        _add("videos", u)
    return out


def classify_asset(url: str, *, alt: str = "", page_text: str = "") -> str:
    """资产 → 物料键（certificate/spec/case_study/catalog/video/sample）。"""
    low = f"{url} {alt}".lower()
    if url.lower().endswith(VID_EXT) or VIDEO_HINT.search(low):
        return "video"
    if CERT_HINT.search(low) or CERT_HINT.search(page_text[:2000] or ""):
        if CERT_HINT.search(low):
            return "certificate"
    if SPEC_HINT.search(low):
        return "spec"
    if CASE_HINT.search(low):
        return "case_study"
    if CATALOG_HINT.search(low):
        return "catalog"
    if url.lower().endswith(DOC_EXT):
        return "catalog"          # 未明语义的文档默认归产品目录
    return "sample"               # 图片默认归样品实拍


def plan(assets: dict, page_text: str, *, max_files: int = 30) -> list[dict]:
    """把抽取结果排成入库计划（同域、去重、按上限截断）。"""
    items: list[dict] = []
    for bucket in ("images", "documents", "videos"):
        for u in assets.get(bucket, []):
            items.append({"url": u, "type": classify_asset(u, page_text=page_text)})
    return items[:max_files]


def download(url: str, out_dir: Path, *, max_mb: float = 20.0, timeout: int = 30) -> Path:
    """下载单个素材到本地；超体积/失败抛异常（调用方如实记录）。"""
    import urllib.request
    out_dir.mkdir(parents=True, exist_ok=True)
    name = os.path.basename(urlparse(url).path) or "asset"
    name = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "_", name)[:120]
    dest = out_dir / name
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(int(max_mb * 1024 * 1024) + 1)
    if len(data) > max_mb * 1024 * 1024:
        raise RuntimeError(f"超过体积上限 {max_mb}MB")
    dest.write_bytes(data)
    return dest


def crawl(*, url: str, enterprise: str, company_name: str = "", out_dir: Path | None = None,
          max_files: int = 30, max_mb: float = 20.0, dry_run: bool = False,
          auto_target: bool = True) -> dict:
    """官网 → 抽取 → 下载 → 双写。返回完整报告（含逐条状态与失败原因）。"""
    html = fetch_html(url)
    page_text = text_of(html)
    assets = extract_assets(html, url)
    items = plan(assets, page_text, max_files=max_files)
    report = {"url": url, "enterprise": enterprise,
              "found": {k: len(v) for k, v in assets.items()},
              "planned": len(items), "downloaded": [], "failed": [],
              "dry_run": dry_run, "pipeline": {}}
    if dry_run or not items:
        report["items"] = items
        return report

    out_dir = Path(out_dir) if out_dir else (HERE.parent.parent / "data" / "memory"
                                             / (company_name or enterprise) / "site_assets")
    local: list[Path] = []
    for it in items:
        try:
            p = download(it["url"], out_dir, max_mb=max_mb)
            report["downloaded"].append({"url": it["url"], "type": it["type"], "file": str(p)})
            local.append(p)
        except Exception as e:
            report["failed"].append({"url": it["url"], "error": str(e)[:140]})

    if local:
        from dc_material_pipeline import run as dw_run
        report["pipeline"] = dw_run(local, enterprise=enterprise,
                                    company_name=company_name, auto_target=auto_target)
    return report


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="官网素材抓取 → 物料双写管线")
    ap.add_argument("--url", required=True)
    ap.add_argument("--enterprise", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--company-name", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--max-files", type=int, default=30)
    ap.add_argument("--max-mb", type=float, default=20.0)
    ap.add_argument("--no-auto-target", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="只抽取不下载不写")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if not args.enterprise:
        print("缺少 enterprise", file=sys.stderr)
        return 2
    try:
        r = crawl(url=args.url, enterprise=args.enterprise, company_name=args.company_name,
                  out_dir=Path(args.out_dir) if args.out_dir else None,
                  max_files=args.max_files, max_mb=args.max_mb, dry_run=args.dry_run,
                  auto_target=not args.no_auto_target)
    except Exception as e:
        print(f"抓取失败: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print(f"找到：图 {r['found']['images']} / 文档 {r['found']['documents']} / 视频 {r['found']['videos']}")
        print(f"计划入库 {r['planned']}，成功 {len(r['downloaded'])}，失败 {len(r['failed'])}")
        if r.get("pipeline"):
            dw = r["pipeline"]["double_write"]
            print(f"  agent KB {'✅' if dw['agent_kb']['ok'] else '❌'} | "
                  f"物料表 {'✅' if dw['human_table']['ok'] else '❌'} | "
                  f"文档 {'✅' if dw['human_doc'].get('ok') else '❌'}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
