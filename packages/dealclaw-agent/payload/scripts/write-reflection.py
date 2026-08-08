#!/usr/bin/env python3
"""
write-reflection.py — Write a reflection after task completion.

Usage:
  python3 scripts/write-reflection.py \
    --context "Task title" \
    --what_worked "What went well" \
    --what_failed "What did not work" \
    --next_time "How to improve" \
    --tags "execution,memory" \
    --session_type "heartbeat" \
    --confidence 3

Storage backends:
  - local (default): appends JSON to {workspace}/memory/reflections/YYYY-MM-DD.jsonl
  - supabase: POST to Supabase REST API (requires storage.supabase.enabled=true in config)
"""

import json
import os
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path


def load_config():
    """Load knight config from project or global path."""
    config_paths = [
        Path.cwd() / "knight.config.json",
        Path.home() / ".knight" / "config.json",
    ]
    for p in config_paths:
        if p.exists():
            try:
                return json.loads(p.read_text())
            except (json.JSONDecodeError, OSError) as e:
                print(f"Warning: failed to read {p}: {e}", file=sys.stderr)
    return {}


def resolve_workspace(config):
    ws = config.get("workspace", "~/.openclaw/workspace")
    return Path(ws).expanduser()


def write_local(payload, config):
    """Write reflection as a JSON line to local file."""
    workspace = resolve_workspace(config)
    local_cfg = config.get("storage", {}).get("local", {})
    reflections_dir = workspace / local_cfg.get("reflections_dir", "memory/reflections")
    reflections_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    filepath = reflections_dir / f"{today}.jsonl"

    with open(filepath, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    print(f"[knight] reflection written to {filepath}")


def write_supabase(payload, config):
    """Write reflection to Supabase REST API."""
    import urllib.request

    supabase_cfg = config.get("storage", {}).get("supabase", {})
    url = supabase_cfg.get("url", "")
    key = supabase_cfg.get("service_key", "") or os.environ.get("SUPABASE_SERVICE_KEY", "")

    if not url or not key:
        print("Error: Supabase URL or service key not configured.", file=sys.stderr)
        sys.exit(1)

    req = urllib.request.Request(
        f"{url}/rest/v1/reflections",
        data=json.dumps(payload).encode(),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.load(r)
            print(f"[knight] reflection written to Supabase: {d[0]['id'][:8]}...")
    except Exception as e:
        print(f"Error: Supabase write failed: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Write a reflection after task completion.")
    parser.add_argument("--context", required=True, help="Task context or title")
    parser.add_argument("--what_worked", default="", help="What went well")
    parser.add_argument("--what_failed", default="", help="What did not work")
    parser.add_argument("--next_time", default="", help="Improvement for next time")
    parser.add_argument("--tags", default="execution", help="Comma-separated tags")
    parser.add_argument("--session_type", default="heartbeat", help="Session type")
    parser.add_argument("--confidence", type=int, default=3, help="Confidence 1-5")
    parser.add_argument("--task_type", default="", help="Task type")
    args = parser.parse_args()

    config = load_config()

    payload = {
        "context": args.context,
        "what_worked": args.what_worked,
        "what_failed": args.what_failed,
        "next_time": args.next_time,
        "tags": [t.strip() for t in args.tags.split(",") if t.strip()],
        "session_type": args.session_type,
        "confidence": args.confidence,
        "task_type": args.task_type,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    storage_cfg = config.get("storage", {})
    backend = storage_cfg.get("backend", "local")

    if backend == "supabase" or storage_cfg.get("supabase", {}).get("enabled"):
        write_supabase(payload, config)
    else:
        write_local(payload, config)


if __name__ == "__main__":
    main()
