#!/usr/bin/env python3
"""dc_material_dedup — 物料去重（跨渠道同一张图/同一个文件只入一次）。

为什么需要：用户可能从飞书、微信、邮件、官网下载等**多个渠道**发同一张产品图
（不同压缩、不同尺寸、不同文件名）。按文件名或字节去重会漏。

两级指纹：
  ① sha256      —— 字节完全一致（精确重复）
  ② dHash(64bit) —— 感知哈希：缩放到 9x8 灰度比较相邻像素，抗压缩/缩放/轻微裁剪
判定：
  exact  = sha256 相同
  near   = dHash 汉明距离 ≤ threshold（默认 6）
索引：data/memory/<企业>/materials/_dedup_index.json（与物料同目录，随租户走）

用法：
    python3 dc_material_dedup.py --file x.png --enterprise <sid>
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import dc_kb_engine as kbe  # noqa: E402

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
DEFAULT_THRESHOLD = 6


def _key(enterprise: str) -> str:
    try:
        return KBEngine()._key(enterprise)
    except Exception:
        return enterprise


def index_path(enterprise: str) -> Path:
    return kbe.KB_DIR / _key(enterprise) / "materials" / "_dedup_index.json"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def dhash(path: Path, size: int = 8) -> str:
    """dHash：缩到 (size+1)x size 灰度，比较相邻像素；返回 16 位十六进制（64 bit）。空串=非图片/失败。"""
    try:
        from PIL import Image
    except Exception:
        return ""
    try:
        with Image.open(path) as im:
            g = im.convert("L").resize((size + 1, size), Image.LANCZOS)
            px = list(g.getdata())
    except Exception:
        return ""
    bits = 0
    for row in range(size):
        for col in range(size):
            left = px[row * (size + 1) + col]
            right = px[row * (size + 1) + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return f"{bits:016x}"


def hamming(h1: str, h2: str) -> int:
    """两个十六进制哈希的汉明距离；参数非法返回 64（视为不同）。"""
    if not h1 or not h2:
        return 64
    try:
        return bin(int(h1, 16) ^ int(h2, 16)).count("1")
    except ValueError:
        return 64


def fingerprint(path) -> dict:
    p = Path(path)
    fp = {"sha256": sha256_of(p), "phash": dhash(p) if p.suffix.lower() in IMAGE_EXT else "",
          "kind": "image" if p.suffix.lower() in IMAGE_EXT else "file",
          "name": p.name, "size": p.stat().st_size}
    return fp


def load_index(enterprise: str) -> list[dict]:
    p = index_path(enterprise)
    if p.exists():
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            return d if isinstance(d, list) else d.get("items") or []
        except Exception:
            return []
    return []


def save_index(enterprise: str, items: list[dict]) -> None:
    p = index_path(enterprise)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def find_duplicate(enterprise: str, fp: dict, threshold: int = DEFAULT_THRESHOLD) -> dict | None:
    """返回重复项（含 match=exact|near 与距离），无重复返回 None。"""
    for it in load_index(enterprise):
        if it.get("sha256") and it["sha256"] == fp.get("sha256"):
            return {"match": "exact", "distance": 0, "existing": it}
        if fp.get("phash") and it.get("phash"):
            d = hamming(fp["phash"], it["phash"])
            if d <= threshold:
                return {"match": "near", "distance": d, "existing": it}
    return None


def register(enterprise: str, fp: dict, *, file: str = "", mtype: str = "",
             source: str = "", channel: str = "") -> dict:
    items = load_index(enterprise)
    entry = {"sha256": fp.get("sha256"), "phash": fp.get("phash"), "kind": fp.get("kind"),
             "name": fp.get("name"), "size": fp.get("size"), "file": file, "type": mtype,
             "source": source, "channel": channel,
             "first_seen": datetime.now(timezone.utc).isoformat()}
    items.append(entry)
    save_index(enterprise, items)
    return entry


def check(enterprise: str, path, threshold: int = DEFAULT_THRESHOLD) -> dict:
    """一次调用：算指纹 + 查重（不写索引）。"""
    fp = fingerprint(path)
    dup = find_duplicate(enterprise, fp, threshold=threshold)
    return {"fingerprint": fp, "duplicate": dup}


def main(argv=None) -> int:  # pragma: no cover
    import argparse, os
    ap = argparse.ArgumentParser(description="物料去重检查")
    ap.add_argument("--file", required=True)
    ap.add_argument("--enterprise", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    r = check(args.enterprise, Path(args.file), threshold=args.threshold)
    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        dup = r["duplicate"]
        print(f"指纹 sha256={r['fingerprint']['sha256'][:12]}… phash={r['fingerprint']['phash']}")
        print("重复：" + (f"{dup['match']} (距离 {dup['distance']}, 原文件 {dup['existing'].get('name')})"
                        if dup else "无"))
    return 0 if not r["duplicate"] else 3


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
