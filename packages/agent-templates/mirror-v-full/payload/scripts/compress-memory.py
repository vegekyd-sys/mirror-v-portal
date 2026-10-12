#!/usr/bin/env python3
"""
compress-memory.py — Archive and compress old log files.

Usage:
  python3 scripts/compress-memory.py             # Dry-run by default (report only)
  python3 scripts/compress-memory.py --dry-run   # Explicit dry-run
  python3 scripts/compress-memory.py --execute   # Actually move files to archive
  python3 scripts/compress-memory.py --days 14   # Keep only last 14 days (default: 30)
  python3 scripts/compress-memory.py --threshold 200  # Line threshold (default: 500)

Scans {workspace}/memory/logs/ and archives files older than --days into memory/logs/archive/.
"""

import json
import os
import sys
import argparse
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path


def load_config():
    config_paths = [
        Path.cwd() / "knight.config.json",
        Path.home() / ".knight" / "config.json",
    ]
    for p in config_paths:
        if p.exists():
            try:
                return json.loads(p.read_text())
            except (json.JSONDecodeError, OSError):
                pass
    return {}


def resolve_workspace(config):
    ws = config.get("workspace", "~/.openclaw/workspace")
    return Path(ws).expanduser()


def scan_logs(logs_dir: Path):
    """Scan log files and return stats."""
    files = []
    total_lines = 0
    total_size = 0

    for f in sorted(logs_dir.iterdir()):
        if f.is_file() and f.suffix in (".md", ".log", ".jsonl", ".txt"):
            size = f.stat().st_size
            mtime = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)
            try:
                lines = sum(1 for _ in open(f, encoding="utf-8", errors="ignore"))
            except OSError:
                lines = 0

            files.append({
                "path": f,
                "name": f.name,
                "size": size,
                "lines": lines,
                "mtime": mtime,
            })
            total_lines += lines
            total_size += size

    return files, total_lines, total_size


def main():
    parser = argparse.ArgumentParser(description="Archive and compress old log files.")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Report only (default)")
    parser.add_argument("--execute", action="store_true", help="Actually archive old files")
    parser.add_argument("--days", type=int, default=30, help="Keep files from last N days (default: 30)")
    parser.add_argument("--threshold", type=int, default=500, help="Line count threshold for warning (default: 500)")
    args = parser.parse_args()

    if args.execute:
        args.dry_run = False

    config = load_config()
    workspace = resolve_workspace(config)
    local_cfg = config.get("storage", {}).get("local", {})
    logs_dir = workspace / local_cfg.get("logs_dir", "memory/logs")

    print(f"[knight] Memory compression — scanning {logs_dir}")

    if not logs_dir.exists():
        print(f"  Logs directory does not exist: {logs_dir}")
        print("  Nothing to compress.")
        return

    files, total_lines, total_size = scan_logs(logs_dir)
    size_mb = total_size / (1024 * 1024)

    print(f"  Found {len(files)} log files")
    print(f"  Total: {total_lines} lines, {size_mb:.2f} MB")

    if total_lines <= args.threshold:
        print(f"  Below threshold ({args.threshold} lines) — no compression needed.")
        return

    print(f"  Above threshold ({args.threshold} lines) — compression recommended.")

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    to_archive = [f for f in files if f["mtime"] < cutoff]
    to_keep = [f for f in files if f["mtime"] >= cutoff]

    archive_lines = sum(f["lines"] for f in to_archive)
    archive_size = sum(f["size"] for f in to_archive)

    print(f"\n  Archive candidates (older than {args.days} days):")
    print(f"    {len(to_archive)} files, {archive_lines} lines, {archive_size / 1024:.1f} KB")
    print(f"  Keeping (recent {args.days} days):")
    print(f"    {len(to_keep)} files, {sum(f['lines'] for f in to_keep)} lines")

    if not to_archive:
        print("\n  No files old enough to archive.")
        return

    if args.dry_run:
        print("\n  [dry-run] Files that would be archived:")
        for f in to_archive[:10]:
            print(f"    {f['name']} ({f['lines']} lines, {f['mtime'].strftime('%Y-%m-%d')})")
        if len(to_archive) > 10:
            print(f"    ... and {len(to_archive) - 10} more")
        print("\n  Run with --execute to perform archival.")
        return

    archive_dir = logs_dir / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)

    moved = 0
    for f in to_archive:
        dest = archive_dir / f["name"]
        if dest.exists():
            dest = archive_dir / f"{f['path'].stem}_{f['mtime'].strftime('%Y%m%d')}{f['path'].suffix}"
        shutil.move(str(f["path"]), str(dest))
        moved += 1

    print(f"\n  Archived {moved} files to {archive_dir}")
    print(f"  Freed {archive_lines} lines, {archive_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
