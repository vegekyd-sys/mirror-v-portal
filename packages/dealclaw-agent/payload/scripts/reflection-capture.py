#!/usr/bin/env python3
"""reflection-capture.py — trigger reflection from observable activity.

This is NOT a second memory system. It writes to the existing
`memory/reflections/YYYY-MM-DD.jsonl` store via the same schema as
write-reflection.py.

Why this exists: the old reflection system depended on the agent remembering
"write reflection at end of task". In practice that did not trigger often.
This script gives heartbeat a concrete trigger: if there has been workspace
activity and no recent reflection, capture a short factual reflection seed.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "knight.config.json"
EXCLUDE_PARTS = {
    ".git", "node_modules", ".next", "dist", "build", ".turbo", "__pycache__",
}
EXCLUDE_PREFIXES = (
    "memory/reflections/",
    "memory/logs/",
    ".knight-",
)


def load_config() -> dict:
    if CONFIG.exists():
        return json.loads(CONFIG.read_text())
    return {}


def reflections_dir(config: dict) -> Path:
    local = config.get("storage", {}).get("local", {})
    return ROOT / local.get("reflections_dir", "memory/reflections")


def iter_reflections(config: dict):
    rd = reflections_dir(config)
    if not rd.exists():
        return
    for path in sorted(rd.glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            row["_file"] = str(path.relative_to(ROOT))
            yield row


def parse_ts(ts: str | None):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def last_reflection(config: dict):
    rows = list(iter_reflections(config) or [])
    rows.sort(key=lambda r: r.get("created_at", ""))
    return rows[-1] if rows else None


def local_today(config: dict) -> str:
    tz_name = config.get("timezone", "Asia/Shanghai")
    return datetime.now(ZoneInfo(tz_name)).date().isoformat()


def has_auto_today(config: dict) -> bool:
    today = local_today(config)
    rd = reflections_dir(config)
    f = rd / f"{today}.jsonl"
    if not f.exists():
        return False
    text = f.read_text(encoding="utf-8", errors="ignore")
    return '"session_type": "auto_heartbeat"' in text


def recent_files(since: datetime | None, limit: int = 12) -> list[str]:
    cutoff = since.timestamp() if since else (datetime.now(timezone.utc) - timedelta(hours=24)).timestamp()
    items: list[tuple[float, str]] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        rel_dir = Path(dirpath).relative_to(ROOT)
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_PARTS]
        if any(part in EXCLUDE_PARTS for part in rel_dir.parts):
            continue
        for name in filenames:
            p = Path(dirpath) / name
            rel = str(p.relative_to(ROOT))
            if rel.startswith(EXCLUDE_PREFIXES):
                continue
            try:
                mt = p.stat().st_mtime
            except OSError:
                continue
            if mt > cutoff:
                items.append((mt, rel))
    items.sort(reverse=True)
    return [rel for _, rel in items[:limit]]


def git_changes(limit: int = 12) -> list[str]:
    try:
        out = subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True, timeout=10)
    except Exception:
        return []
    files = []
    for line in out.splitlines():
        rel = line[3:].strip()
        if rel.startswith(EXCLUDE_PREFIXES):
            continue
        if any(part in EXCLUDE_PARTS for part in Path(rel).parts):
            continue
        files.append(line.strip())
    return files[:limit]


def today_daily_headings(config: dict, limit: int = 8) -> list[str]:
    f = ROOT / "memory" / f"{local_today(config)}.md"
    if not f.exists():
        return []
    headings = []
    for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("## "):
            headings.append(line.strip("# ").strip())
    return headings[-limit:]


def write_reflection(context: str, what_worked: str, what_failed: str, next_time: str, tags: list[str]) -> None:
    cmd = [
        sys.executable, str(ROOT / "scripts" / "write-reflection.py"),
        "--context", context,
        "--what_worked", what_worked,
        "--what_failed", what_failed,
        "--next_time", next_time,
        "--session_type", "auto_heartbeat",
        "--confidence", "2",
        "--tags", ",".join(tags),
    ]
    subprocess.run(cmd, cwd=ROOT, check=True, text=True, timeout=30)


def capture(force: bool = False, stale_hours: int = 24) -> dict:
    config = load_config()
    last = last_reflection(config)
    last_ts = parse_ts(last.get("created_at")) if last else None
    now = datetime.now(timezone.utc)
    age_hours = None if not last_ts else (now - last_ts.astimezone(timezone.utc)).total_seconds() / 3600

    headings = today_daily_headings(config)
    changed = git_changes()
    recent = recent_files(last_ts)
    activity = bool(headings or changed or recent)

    if not force:
        if has_auto_today(config):
            return {"captured": False, "reason": "auto reflection already written today", "last_created_at": last.get("created_at") if last else None}
        if age_hours is not None and age_hours < stale_hours:
            return {"captured": False, "reason": f"last reflection is fresh ({age_hours:.1f}h old)", "last_created_at": last.get("created_at") if last else None}
        if not activity:
            return {"captured": False, "reason": "no observable workspace activity", "last_created_at": last.get("created_at") if last else None}

    context_parts = ["Heartbeat auto-captured reflection because normal end-of-task reflection did not trigger recently."]
    if headings:
        context_parts.append("Today's daily-note topics: " + "; ".join(headings[:6]))
    if changed:
        context_parts.append("Current git changes: " + "; ".join(changed[:8]))
    elif recent:
        context_parts.append("Recent files: " + "; ".join(recent[:8]))

    what_worked = "Heartbeat can now detect reflection staleness and create a minimal factual reflection seed instead of silently reporting no new data."
    what_failed = "Reflection depended on manual task-end behavior, so important corrections/work could happen without any reflection entry."
    next_time = "Keep reflection as the only self-improvement store; trigger it from heartbeat when stale, and write richer manual reflections after substantial tasks or user corrections."

    write_reflection("\n".join(context_parts), what_worked, what_failed, next_time, ["reflection-trigger", "heartbeat", "auto"])
    return {
        "captured": True,
        "reason": "stale reflection with observable activity",
        "last_created_at": last.get("created_at") if last else None,
        "age_hours": age_hours,
        "headings": headings[:6],
        "changed": changed[:8],
        "recent": recent[:8],
    }


def status() -> dict:
    config = load_config()
    last = last_reflection(config)
    last_ts = parse_ts(last.get("created_at")) if last else None
    age_hours = None
    if last_ts:
        age_hours = (datetime.now(timezone.utc) - last_ts.astimezone(timezone.utc)).total_seconds() / 3600
    return {
        "last_created_at": last.get("created_at") if last else None,
        "last_context": (last.get("context") or "")[:180] if last else None,
        "age_hours": age_hours,
        "has_auto_today": has_auto_today(config),
        "today_headings": today_daily_headings(config),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_cap = sub.add_parser("capture")
    p_cap.add_argument("--force", action="store_true")
    p_cap.add_argument("--stale-hours", type=int, default=24)
    sub.add_parser("status")
    args = ap.parse_args()
    data = capture(force=args.force, stale_hours=args.stale_hours) if args.cmd == "capture" else status()
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
