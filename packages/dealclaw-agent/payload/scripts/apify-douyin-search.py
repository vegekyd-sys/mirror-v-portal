#!/usr/bin/env python3
"""Apify Douyin search + optional video download.

Verified actor: zen-studio/douyin-search-scraper

Examples:
  python3 scripts/apify-douyin-search.py "AI生成视频" --limit 10 --download --out work/douyin-ai
  python3 scripts/apify-douyin-search.py "AI生成视频" "AI视频" AIGC --limit 5 --sort most_liked --publish half_year

Env: APIFY_TOKEN or APIFY_API_KEY. Falls back to ~/.openclaw/.env.
"""
import argparse
import csv
import json
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://api.apify.com/v2"
ACTOR = "zen-studio~douyin-search-scraper"


def load_token() -> str:
    for key in ("APIFY_TOKEN", "APIFY_API_KEY"):
        if os.environ.get(key):
            return os.environ[key]
    env_path = Path.home() / ".openclaw/.env"
    if env_path.exists():
        text = env_path.read_text()
        for key in ("APIFY_TOKEN", "APIFY_API_KEY"):
            match = re.search(rf"^{key}=(\S+)", text, re.M)
            if match:
                return match.group(1)
    raise SystemExit("APIFY_TOKEN/APIFY_API_KEY not found")


def api_json(url: str, method: str = "GET", body=None, timeout: int = 90):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "User-Agent": "OpenClaw/ApifyDouyin"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def get_path(obj, path):
    for part in path.split("."):
        if isinstance(obj, dict) and part in obj:
            obj = obj[part]
        else:
            return None
    return obj


def row(item, rank):
    author = item.get("authorMeta") or {}
    stats = item.get("statistics") or {}
    video = item.get("videoMeta") or {}
    video_file = item.get("videoFile") or {}
    cover_file = item.get("coverFile") or {}
    return {
        "rank": rank,
        "searchKeyword": item.get("searchKeyword") or item.get("inputKeyword"),
        "videoId": item.get("id"),
        "douyinUrl": item.get("url"),
        "shareUrl": item.get("shareUrl") or get_path(item, "share.shareUrl"),
        "caption": item.get("caption") or item.get("text") or item.get("itemTitle"),
        "authorName": author.get("name"),
        "authorUsername": author.get("customUsername") or author.get("username"),
        "authorFollowers": author.get("followersCount"),
        "likes": stats.get("diggCount"),
        "comments": stats.get("commentCount"),
        "shares": stats.get("shareCount"),
        "collects": stats.get("collectCount"),
        "plays": stats.get("playCount"),
        "durationMs": video.get("duration"),
        "width": video.get("width"),
        "height": video.get("height"),
        "mediaType": item.get("mediaTypeLabel") or item.get("mediaType"),
        "createDate": item.get("createDate"),
        "videoKvUrl": video_file.get("kvUrl"),
        "videoSizeBytes": video_file.get("sizeBytes"),
        "videoSourceUrl": video_file.get("sourceUrl") or video.get("downloadUrl"),
        "coverKvUrl": cover_file.get("kvUrl"),
        "coverSizeBytes": cover_file.get("sizeBytes"),
    }


def download_file(url, dest: Path, token: str):
    final_url = url
    if "api.apify.com/v2/key-value-stores/" in url and "token=" not in url:
        sep = "&" if "?" in url else "?"
        final_url = f"{url}{sep}token={urllib.parse.quote(token)}"
    req = urllib.request.Request(final_url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=240) as resp:
        dest.write_bytes(resp.read())


def run(args):
    token = load_token()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    payload = {
        "keywords": args.keywords,
        "maxResultsPerQuery": args.limit,
        "sort": args.sort,
        "publishTime": args.publish,
        "duration": args.duration,
        "shouldDownloadVideos": args.download,
        "shouldDownloadCovers": args.download_covers,
        "shouldDownloadSlideshowImages": args.download_slideshow,
    }
    if args.kv_store:
        payload["videoKvStoreName"] = args.kv_store

    (out / "input.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Starting {ACTOR}: keywords={args.keywords}, limit={args.limit}, download={args.download}", flush=True)

    run_data = api_json(f"{BASE}/acts/{ACTOR}/runs?token={urllib.parse.quote(token)}", "POST", payload)["data"]
    run_id = run_data["id"]
    dataset_id = run_data["defaultDatasetId"]
    (out / "run.json").write_text(json.dumps(run_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"run_id={run_id} dataset_id={dataset_id}", flush=True)

    deadline = time.time() + args.timeout
    last_status = None
    while time.time() < deadline:
        status_data = api_json(f"{BASE}/actor-runs/{run_id}?token={urllib.parse.quote(token)}")["data"]
        status = status_data.get("status")
        if status != last_status:
            print(f"status={status} usage=${status_data.get('usageTotalUsd')} message={status_data.get('statusMessage')}", flush=True)
            last_status = status
        if status in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
            (out / "run-final.json").write_text(json.dumps(status_data, ensure_ascii=False, indent=2), encoding="utf-8")
            if status != "SUCCEEDED":
                raise SystemExit(f"Actor ended with {status}: {status_data.get('statusMessage')}")
            break
        time.sleep(args.poll_interval)
    else:
        try:
            api_json(f"{BASE}/actor-runs/{run_id}/abort?token={urllib.parse.quote(token)}", "POST")
        finally:
            raise SystemExit(f"Timed out after {args.timeout}s; aborted run {run_id}")

    items = api_json(f"{BASE}/datasets/{dataset_id}/items?token={urllib.parse.quote(token)}&clean=true&format=json", timeout=180)
    rows = [row(item, i) for i, item in enumerate(items, 1)]
    (out / "raw_items.json").write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    if rows:
        with open(out / "results.csv", "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)

    if args.download:
        video_dir = out / "videos"
        video_dir.mkdir(exist_ok=True)
        for r in rows:
            if r.get("videoKvUrl"):
                suffix = ".mp4"
                dest = video_dir / f"{r['videoId']}{suffix}"
                download_file(r["videoKvUrl"], dest, token)
                r["localVideoPath"] = str(dest)
                r["localVideoBytes"] = dest.stat().st_size
            if args.download_covers and r.get("coverKvUrl"):
                dest = video_dir / f"{r['videoId']}.jpg"
                download_file(r["coverKvUrl"], dest, token)
                r["localCoverPath"] = str(dest)
                r["localCoverBytes"] = dest.stat().st_size
        (out / "results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({"count": len(rows), "out": str(out), "results": str(out / "results.json"), "csv": str(out / "results.csv")}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Search Douyin on Apify and optionally download MP4 videos")
    parser.add_argument("keywords", nargs="+", help="Douyin search keywords / hashtags")
    parser.add_argument("--limit", type=int, default=10, help="max results per keyword")
    parser.add_argument("--download", action="store_true", help="download MP4s to Apify KV and local out/videos")
    parser.add_argument("--download-covers", action="store_true", help="download covers to Apify KV and local out/videos")
    parser.add_argument("--download-slideshow", action="store_true", help="download slideshow images for image-text posts")
    parser.add_argument("--sort", choices=["general", "most_liked", "latest"], default="most_liked")
    parser.add_argument("--publish", choices=["unlimited", "one_day", "one_week", "half_year"], default="half_year")
    parser.add_argument("--duration", choices=["unlimited", "under_1m", "one_to_five", "over_5m"], default="unlimited")
    parser.add_argument("--kv-store", default="openclaw-douyin-search", help="persistent Apify KV store name for downloaded media")
    parser.add_argument("--out", default="work/douyin-apify-search", help="output directory")
    parser.add_argument("--timeout", type=int, default=420)
    parser.add_argument("--poll-interval", type=int, default=8)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
