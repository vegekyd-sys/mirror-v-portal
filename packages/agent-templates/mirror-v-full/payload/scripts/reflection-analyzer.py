#!/usr/bin/env python3
"""
reflection-analyzer.py — Analyze reflections for repeated failure patterns.

Usage:
  python3 scripts/reflection-analyzer.py             # Incremental analysis
  python3 scripts/reflection-analyzer.py --dry-run   # Print only, no side effects
  python3 scripts/reflection-analyzer.py --all       # Full analysis (ignore cursor)
  python3 scripts/reflection-analyzer.py --min-count 3  # Adjust threshold (default: 2)

Backends:
  - local (default): reads from {workspace}/memory/reflections/*.jsonl
  - supabase: queries Supabase REST API (requires config)
"""

import json
import os
import sys
import argparse
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict
from typing import Optional


# Classification determines how the downstream daily-review pipeline handles the pattern.
# - "skill_candidate": repeated workflow with clear trigger + reusable steps → propose as skill
# - "memory": behavior rule, principle, or preference → promote to ai-patterns.md or project memory
# - "system_rule": rule that should be enforced at runtime (guard, pre-check, REDLINES) → propose system rule
PATTERN_MAP = [
    {
        "id": "db-schema-assumption",
        "label": "Database field assumption",
        "keywords": ["column", "schema", "field", "table", "mapping"],
        "rule": "Verify schema before any DB operation: `SELECT column_name FROM information_schema.columns WHERE table_name='xxx'`",
        "classification": "memory",
        "classification_reason": "A principle to check before DB operations, not a standalone reusable tool workflow.",
    },
    {
        "id": "task-status-not-updated",
        "label": "Task status not updated after completion",
        "keywords": ["PATCH", "status", "not updated", "backlog", "task status"],
        "rule": "After task completion, always: write-reflection + update status — both steps must complete together",
        "classification": "memory",
        "classification_reason": "A behavioral rule (complete → update → reflect). Best enforced as ai-patterns / pre-completion checklist, not a standalone skill.",
    },
    {
        "id": "missing-reflection",
        "label": "Forgot to write reflection",
        "keywords": ["reflection", "forgot", "missing", "not written"],
        "rule": "No reflection = task not complete. Always call write-reflection.py immediately after finishing a task",
        "classification": "system_rule",
        "classification_reason": "Reflection is the only self-improvement store. Missing it breaks the learning loop. Deserves system-level enforcement (heartbeat stale detection already exists as guard).",
    },
    {
        "id": "heartbeat-gap",
        "label": "Heartbeat gap/interruption",
        "keywords": ["gap", "interrupted", "blank", "no record", "heartbeat"],
        "rule": "After a heartbeat gap, explain the reason on next execution. 2+ consecutive gaps require user notification",
        "classification": "skill_candidate",
        "classification_reason": "Concrete monitor/recovery workflow: detect gap → diagnose → notify → recover. Already has a generated skill proposal.",
    },
    {
        "id": "silent-tool-switch",
        "label": "Silent tool switch after failure",
        "keywords": ["silent", "tool failed", "unreported", "switch"],
        "rule": "When a tool fails, always report: 'X failed, switching to Y' — silence is a violation",
        "classification": "memory",
        "classification_reason": "A communication/transparency rule. Best in ai-patterns as a behavioral expectation, not a separate tool workflow.",
    },
    {
        "id": "read-before-exec",
        "label": "Modify without reading first",
        "keywords": ["read", "file", "confirm", "structure", "before modify"],
        "rule": "Before modifying any file: read first, understand structure, then execute",
        "classification": "system_rule",
        "classification_reason": "Fundamental safety rule. Should be enforced as a pre-modification guard, not just documented as a preference.",
    },
    {
        "id": "rule-exists-not-executed",
        "label": "Rule exists but not followed",
        "keywords": ["rule exists", "known but", "not executed", "upgrade"],
        "rule": "When a rule exists but wasn't followed, escalate its priority to mandatory trigger",
        "classification": "memory",
        "classification_reason": "A meta-rule about rule enforcement itself. Best as ai-patterns with an escalation ladder, not a standalone skill.",
    },
    {
        "id": "blocked-task-not-surfaced",
        "label": "Blocked task not surfaced",
        "keywords": ["blocked", "waiting", "needs confirmation", "cannot close"],
        "rule": "Blocked tasks must be surfaced every heartbeat — never let them accumulate silently",
        "classification": "memory",
        "classification_reason": "A task management principle. Enforced through heartbeat reporting, not a separate tool workflow.",
    },
]


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


def get_cursor_path(config):
    workspace = resolve_workspace(config)
    return workspace / ".knight-reflection-cursor"


def read_cursor(config) -> Optional[str]:
    cursor_file = get_cursor_path(config)
    if cursor_file.exists():
        return cursor_file.read_text().strip() or None
    return None


def write_cursor(config, ts: str):
    cursor_file = get_cursor_path(config)
    cursor_file.write_text(ts)


def fetch_local(config, since: Optional[str]) -> list:
    """Read reflections from local .jsonl files."""
    workspace = resolve_workspace(config)
    local_cfg = config.get("storage", {}).get("local", {})
    reflections_dir = workspace / local_cfg.get("reflections_dir", "memory/reflections")

    if not reflections_dir.exists():
        return []

    rows = []
    for jsonl_file in sorted(reflections_dir.glob("*.jsonl")):
        with open(jsonl_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                    if since and row.get("created_at", "") <= since:
                        continue
                    rows.append(row)
                except json.JSONDecodeError:
                    continue
    return rows


def reflection_freshness(config) -> dict:
    """Return last reflection metadata regardless of the incremental cursor."""
    storage_cfg = config.get("storage", {})
    backend = storage_cfg.get("backend", "local")
    if backend == "supabase" or storage_cfg.get("supabase", {}).get("enabled"):
        rows = fetch_supabase(config, None)
    else:
        rows = fetch_local(config, None)
    rows.sort(key=lambda r: r.get("created_at", ""))
    if not rows:
        return {"count": 0}
    last = rows[-1]
    age_hours = None
    try:
        ts = datetime.fromisoformat(last.get("created_at", "").replace("Z", "+00:00"))
        age_hours = (datetime.now(timezone.utc) - ts.astimezone(timezone.utc)).total_seconds() / 3600
    except Exception:
        pass
    return {
        "count": len(rows),
        "last_created_at": last.get("created_at"),
        "last_context": (last.get("context") or "")[:120],
        "age_hours": age_hours,
    }


def fetch_supabase(config, since: Optional[str]) -> list:
    """Fetch reflections from Supabase REST API."""
    supabase_cfg = config.get("storage", {}).get("supabase", {})
    url = supabase_cfg.get("url", "")
    key = supabase_cfg.get("service_key", "") or os.environ.get("SUPABASE_SERVICE_KEY", "")

    if not url or not key:
        print("Error: Supabase URL or key not configured.", file=sys.stderr)
        sys.exit(1)

    params = "select=id,created_at,context,what_failed,next_time,confidence&order=created_at.asc&limit=200"
    if since:
        ts = since.replace("+", "%2B").replace(":", "%3A")
        params += f"&created_at=gt.{ts}"

    req = urllib.request.Request(
        f"{url}/rest/v1/reflections?{params}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except Exception as e:
        print(f"Error: Supabase query failed: {e}", file=sys.stderr)
        sys.exit(1)


def analyze(rows: list, min_count: int) -> list:
    hits = defaultdict(list)

    for row in rows:
        text = " ".join([
            row.get("what_failed") or "",
            row.get("next_time") or "",
            row.get("context") or "",
        ]).lower()

        for p in PATTERN_MAP:
            for kw in p["keywords"]:
                if re.search(kw.lower(), text):
                    hits[p["id"]].append(row)
                    break

    candidates = []
    for p in PATTERN_MAP:
        matched = hits[p["id"]]
        if len(matched) >= min_count:
            candidates.append({
                "pattern": p,
                "count": len(matched),
                "examples": matched[:2],
            })

    candidates.sort(key=lambda x: -x["count"])
    return candidates


def write_candidates_json(candidates: list, rows: list, since: Optional[str], path: str) -> dict:
    """Write structured candidates JSON for downstream consumption (heartbeat dispatch).

    Returns the dict that was written.
    """
    scope = f"since {since[:10]}" if since else "all data"
    skill_candidates = []
    memory_candidates = []
    system_rule_candidates = []

    for c in candidates:
        entry = {
            "pattern_id": c["pattern"]["id"],
            "label": c["pattern"]["label"],
            "classification": c["pattern"]["classification"],
            "classification_reason": c["pattern"]["classification_reason"],
            "count": c["count"],
            "rule": c["pattern"]["rule"],
            "examples": [
                {
                    "created_at": ex.get("created_at", ""),
                    "context": (ex.get("context") or "")[:200],
                    "what_failed": (ex.get("what_failed") or "")[:200],
                    "next_time": (ex.get("next_time") or "")[:200],
                }
                for ex in c["examples"]
            ],
        }
        cls = c["pattern"]["classification"]
        if cls == "skill_candidate":
            skill_candidates.append(entry)
        elif cls == "memory":
            memory_candidates.append(entry)
        elif cls == "system_rule":
            system_rule_candidates.append(entry)

    output = {
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "scope": scope,
        "total_reflections": len(rows),
        "skill_candidates": skill_candidates,
        "memory_candidates": memory_candidates,
        "system_rule_candidates": system_rule_candidates,
    }
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return output


def format_console(candidates: list, rows: list, since: Optional[str]) -> str:
    scope = f"since {since[:10]}" if since else "all data"
    lines = [f"\n[knight] Reflection Analyzer | {scope} | {len(rows)} entries"]

    if not candidates:
        lines.append("  No repeated failure patterns found — system stable")
    else:
        lines.append(f"  Found {len(candidates)} candidate rules:\n")
        for i, c in enumerate(candidates, 1):
            p = c["pattern"]
            lines.append(f"  [{i}] {p['label']} x {c['count']} times")
            lines.append(f"      Rule: {p['rule']}")
            for ex in c["examples"]:
                snippet = (ex.get("what_failed") or "")[:60]
                lines.append(f"      Example: \"{snippet}...\"")
            lines.append("")

    return "\n".join(lines)


def format_notification(candidates: list, rows: list, since: Optional[str], config: dict) -> Optional[str]:
    if not candidates:
        return None

    user_name = config.get("user_name", "User")
    scope = f"since {since[:10]}" if since else "all data"
    lines = [
        f"[knight] Reflection Analysis | {scope} | {len(rows)} entries",
        f"Found {len(candidates)} repeated failure patterns — suggest writing to ai-patterns.md\n",
    ]

    for i, c in enumerate(candidates, 1):
        p = c["pattern"]
        lines.append(f"{i}. {p['label']} x {c['count']} times")
        lines.append(f"   Rule: {p['rule']}")
        ex = c["examples"][0]
        snippet = (ex.get("what_failed") or "")[:50]
        lines.append(f"   Recent: \"{snippet}\"\n")

    lines.append(f"Reply 'write' to add to ai-patterns.md / 'skip' to ignore")
    return "\n".join(lines)


def send_telegram(text: str, config: dict):
    telegram_cfg = config.get("notifications", {}).get("telegram", {})
    bot_token = telegram_cfg.get("bot_token", "") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = telegram_cfg.get("chat_id", "") or os.environ.get("TELEGRAM_CHAT_ID", "")

    if not bot_token or not chat_id:
        print("  Warning: Telegram not configured, skipping notification", file=sys.stderr)
        return

    payload = {"chat_id": chat_id, "text": text}
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{bot_token}/sendMessage",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.load(r)
            if resp.get("ok"):
                print("  Telegram notification sent")
            else:
                print(f"  Telegram failed: {resp}", file=sys.stderr)
    except Exception as e:
        print(f"  Telegram error: {e}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Analyze reflections for repeated failure patterns.")
    parser.add_argument("--dry-run", action="store_true", help="Print only, no side effects")
    parser.add_argument("--all", action="store_true", help="Analyze all data (ignore cursor)")
    parser.add_argument("--min-count", type=int, default=2, help="Trigger threshold (default: 2)")
    parser.add_argument("--output-candidates", type=str, default=None, help="Write structured candidates JSON to this file for downstream dispatch")
    args = parser.parse_args()

    config = load_config()
    min_count = config.get("reflection", {}).get("min_pattern_count", args.min_count)
    if args.min_count != 2:
        min_count = args.min_count

    since = None if args.all else read_cursor(config)
    scope_desc = "all data" if not since else f"since {since[:10]}"
    print(f"[knight] Analysis scope: {scope_desc}")

    fresh = reflection_freshness(config)
    if fresh.get("count"):
        age = fresh.get("age_hours")
        age_desc = f", {age:.1f}h ago" if age is not None else ""
        print(f"  Last reflection: {fresh.get('last_created_at', '')[:16]}{age_desc} — {fresh.get('last_context', '')}")
    else:
        print("  Last reflection: none")

    storage_cfg = config.get("storage", {})
    backend = storage_cfg.get("backend", "local")

    if backend == "supabase" or storage_cfg.get("supabase", {}).get("enabled"):
        rows = fetch_supabase(config, since)
    else:
        rows = fetch_local(config, since)

    print(f"  Read {len(rows)} reflections")

    if not rows:
        print("  No new data, skipping analysis")
        if args.output_candidates:
            write_candidates_json([], rows, since, args.output_candidates)
            print(f"  Wrote empty candidates JSON → {args.output_candidates}")
        return

    candidates = analyze(rows, min_count)
    print(format_console(candidates, rows, since))

    # Always write fresh JSON when requested to prevent stale reads by heartbeat.
    # If no candidates found, write empty arrays — this is intentional: heartbeat
    # should see "no new candidates" rather than stale data from a previous run.
    if args.output_candidates:
        out = write_candidates_json(candidates, rows, since, args.output_candidates)
        skill_n = len(out.get("skill_candidates", []))
        mem_n = len(out.get("memory_candidates", []))
        sys_n = len(out.get("system_rule_candidates", []))
        print(f"  Wrote candidates JSON ({skill_n} skill / {mem_n} memory / {sys_n} system_rule) → {args.output_candidates}")

    latest_ts = rows[-1].get("created_at", datetime.now(timezone.utc).isoformat())
    if not args.dry_run:
        write_cursor(config, latest_ts)
        print(f"  Cursor updated to {latest_ts[:16]}")

    if candidates and not args.dry_run:
        notifications_cfg = config.get("notifications", {})
        if notifications_cfg.get("telegram", {}).get("enabled"):
            msg = format_notification(candidates, rows, since, config)
            if msg:
                send_telegram(msg, config)
    elif args.dry_run:
        print("\n  [dry-run: no cursor update, no notifications]")


if __name__ == "__main__":
    main()
