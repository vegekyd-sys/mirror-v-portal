#!/usr/bin/env python3
"""Download a WeChat Channels (视频号) /sph/ share link.

Primary practical path: public parser endpoint from ltaoo/wx_channels_download, then direct MP4 download.
This intentionally avoids printing signed video URLs/tokens.

Usage:
  python3 scripts/weixin-sph-download.py 'https://weixin.qq.com/sph/AiLfqUUATr' --out work/weixin-sph
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

import requests

DEFAULT_ENDPOINT = "https://sph.litao.workers.dev/api/fetch_video_profile"


def sanitize_filename(text: str, fallback: str = "weixin_sph_video") -> str:
    text = (text or "").splitlines()[0].strip()[:80]
    text = re.sub(r'[\\/:*?"<>|\s]+', "_", text).strip("._ ")
    return text or fallback


def parse_share(url: str, endpoint: str = DEFAULT_ENDPOINT, timeout: int = 120) -> dict:
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Origin": endpoint.split("/api/")[0],
        "Referer": endpoint.split("/api/")[0] + "/",
        "Content-Type": "application/json",
    }
    resp = requests.post(endpoint, json={"url": url}, headers=headers, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    if data.get("errCode") not in (0, None):
        raise RuntimeError(f"parse failed: errCode={data.get('errCode')} errMsg={data.get('errMsg')}")
    return data


def best_video_url(feed: dict) -> str:
    fi = feed.get("data", {}).get("feedInfo", {})
    candidates = [
        (fi.get("h264VideoInfo") or {}).get("videoUrl"),
        fi.get("videoUrl"),
        (fi.get("h265VideoInfo") or {}).get("videoUrl"),
    ]
    for u in candidates:
        if u:
            return u
    raise RuntimeError("no videoUrl in parser response")


def safe_metadata(feed: dict, source: str, file_path: Path) -> dict:
    fi = feed.get("data", {}).get("feedInfo", {})
    ai = feed.get("data", {}).get("authorInfo", {})
    return {
        "source": source,
        "author": ai.get("nickname"),
        "description": fi.get("description"),
        "stats": {k: fi.get(k) for k in ["likeCountFmt", "favCountFmt", "forwardCountFmt", "commentCountFmt"]},
        "createtime": fi.get("createtime"),
        "mediaType": fi.get("mediaType"),
        "file": str(file_path),
        "bytes": file_path.stat().st_size if file_path.exists() else None,
    }


def download(url: str, path: Path, timeout: int = 180) -> None:
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://channels.weixin.qq.com/"}
    with requests.get(url, headers=headers, stream=True, timeout=timeout) as resp:
        resp.raise_for_status()
        tmp = path.with_suffix(path.suffix + ".part")
        with tmp.open("wb") as f:
            for chunk in resp.iter_content(1024 * 1024):
                if chunk:
                    f.write(chunk)
        tmp.replace(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url", help="WeChat Channels share URL, e.g. https://weixin.qq.com/sph/xxx")
    ap.add_argument("--out", default="work/weixin-sph", help="output directory")
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="parser endpoint")
    ap.add_argument("--name", default="", help="optional output basename without extension")
    ap.add_argument("--debug-save-response", action="store_true", help="save full parser response; may contain short-lived signed URLs")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    feed = parse_share(args.url, args.endpoint)
    fi = feed.get("data", {}).get("feedInfo", {})
    basename = sanitize_filename(args.name or fi.get("description", ""), "weixin_sph_video")
    video_path = out / f"{basename}.mp4"

    video_url = best_video_url(feed)
    download(video_url, video_path)

    if args.debug_save_response:
        (out / "feed_profile.json").write_text(json.dumps(feed, ensure_ascii=False, indent=2), encoding="utf-8")
    meta = safe_metadata(feed, args.url, video_path)
    (out / "metadata.safe.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        raise SystemExit(1)
