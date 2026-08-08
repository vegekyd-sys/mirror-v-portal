#!/usr/bin/env python3
"""
knight-status.py — Comprehensive workspace health check.

Usage:
  python3 scripts/knight-status.py

Checks:
  - Workspace directory existence and key files
  - Reflections count and latest entry
  - MEMORY.md last update time
  - Logs directory size
  - Heartbeat configuration status
"""

import json
import os
import sys
from datetime import datetime, timezone
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


def check_workspace(workspace: Path) -> list:
    """Check workspace directory and key files."""
    results = []

    if not workspace.exists():
        results.append(("Workspace", "MISSING", str(workspace)))
        return results

    results.append(("Workspace", "OK", str(workspace)))

    key_files = [
        "AGENTS.md",
        "SOUL.md",
        "MEMORY.md",
        "HEARTBEAT.md",
        "REDLINES.md",
        "USER.md",
        "TOOLS.md",
        "memory/ai-patterns.md",
        "memory/user-patterns.md",
    ]

    present = 0
    for f in key_files:
        if (workspace / f).exists():
            present += 1

    results.append(("Core files", f"{present}/{len(key_files)}", "present"))
    return results


def check_reflections(workspace: Path, config: dict) -> list:
    """Check reflections directory."""
    results = []
    local_cfg = config.get("storage", {}).get("local", {})
    reflections_dir = workspace / local_cfg.get("reflections_dir", "memory/reflections")

    if not reflections_dir.exists():
        results.append(("Reflections", "NONE", "directory not found"))
        return results

    jsonl_files = list(reflections_dir.glob("*.jsonl"))
    total_entries = 0
    latest_date = None

    for f in sorted(jsonl_files):
        try:
            lines = [l for l in open(f, encoding="utf-8") if l.strip()]
            total_entries += len(lines)
            if lines:
                last = json.loads(lines[-1])
                ts = last.get("created_at", "")
                if ts and (latest_date is None or ts > latest_date):
                    latest_date = ts
        except (OSError, json.JSONDecodeError):
            pass

    if total_entries == 0:
        results.append(("Reflections", "EMPTY", f"{len(jsonl_files)} files, 0 entries"))
    else:
        latest_str = latest_date[:10] if latest_date else "unknown"
        results.append(("Reflections", "OK", f"{total_entries} entries across {len(jsonl_files)} files (latest: {latest_str})"))

    return results


def check_memory(workspace: Path, config: dict) -> list:
    """Check MEMORY.md freshness."""
    results = []
    local_cfg = config.get("storage", {}).get("local", {})
    memory_file = workspace / local_cfg.get("memory_file", "MEMORY.md")

    if not memory_file.exists():
        results.append(("MEMORY.md", "MISSING", "not found"))
        return results

    mtime = datetime.fromtimestamp(memory_file.stat().st_mtime, tz=timezone.utc)
    age_days = (datetime.now(timezone.utc) - mtime).days
    status = "OK" if age_days <= 7 else "STALE"
    results.append(("MEMORY.md", status, f"last modified {age_days} days ago"))
    return results


def check_logs(workspace: Path, config: dict) -> list:
    """Check logs directory size."""
    results = []
    local_cfg = config.get("storage", {}).get("local", {})
    logs_dir = workspace / local_cfg.get("logs_dir", "memory/logs")

    if not logs_dir.exists():
        results.append(("Logs", "NONE", "directory not found"))
        return results

    total_size = 0
    total_lines = 0
    file_count = 0

    for f in logs_dir.iterdir():
        if f.is_file() and f.suffix in (".md", ".log", ".jsonl", ".txt"):
            total_size += f.stat().st_size
            file_count += 1
            try:
                total_lines += sum(1 for _ in open(f, encoding="utf-8", errors="ignore"))
            except OSError:
                pass

    size_mb = total_size / (1024 * 1024)
    status = "OK" if total_lines <= 500 else "LARGE"
    results.append(("Logs", status, f"{file_count} files, {total_lines} lines, {size_mb:.2f} MB"))
    return results


def check_heartbeat(config: dict) -> list:
    """Check heartbeat configuration."""
    results = []
    heartbeat_cfg = config.get("heartbeat", {})

    if heartbeat_cfg.get("enabled"):
        interval = heartbeat_cfg.get("interval_hours", 6)
        tasks = heartbeat_cfg.get("tasks", [])
        results.append(("Heartbeat", "ENABLED", f"every {interval}h, tasks: {', '.join(tasks)}"))
    else:
        results.append(("Heartbeat", "DISABLED", "set heartbeat.enabled=true in config to activate"))

    return results


def check_notifications(config: dict) -> list:
    """Check notification configuration."""
    results = []
    notifications = config.get("notifications", {})
    backend = notifications.get("backend", "none")

    if backend == "none" and not notifications.get("telegram", {}).get("enabled"):
        results.append(("Notifications", "DISABLED", "output to terminal only"))
    elif notifications.get("telegram", {}).get("enabled"):
        results.append(("Notifications", "TELEGRAM", "configured"))
    else:
        results.append(("Notifications", backend.upper(), "configured"))

    return results


def main():
    config = load_config()
    workspace = resolve_workspace(config)
    ai_name = config.get("ai_name", "Knight")

    print(f"\n[knight] {ai_name} Workspace Health Report")
    print(f"{'=' * 50}")

    all_results = []
    all_results.extend(check_workspace(workspace))
    all_results.extend(check_reflections(workspace, config))
    all_results.extend(check_memory(workspace, config))
    all_results.extend(check_logs(workspace, config))
    all_results.extend(check_heartbeat(config))
    all_results.extend(check_notifications(config))

    max_label = max(len(r[0]) for r in all_results)
    max_status = max(len(r[1]) for r in all_results)

    for label, status, detail in all_results:
        icon = {
            "OK": "+", "ENABLED": "+", "TELEGRAM": "+",
            "MISSING": "!", "STALE": "!", "LARGE": "!",
            "NONE": "-", "EMPTY": "-", "DISABLED": "-",
        }.get(status, " ")
        print(f"  [{icon}] {label:<{max_label}}  {status:<{max_status}}  {detail}")

    print(f"\n{'=' * 50}")
    print(f"  Config sources: knight.config.json, ~/.knight/config.json")
    print(f"  Storage backend: {config.get('storage', {}).get('backend', 'local')}")
    print("")


if __name__ == "__main__":
    main()
