#!/usr/bin/env python3
"""Watch OpenClaw durable memory files and keep the builtin memory index fresh.

For the builtin memory backend, OpenClaw marks the SQLite search index dirty when
MEMORY.md or memory/**/*.md changes. This watcher debounces durable-memory file
changes and runs:

    openclaw memory status --index --agent <agent>

That command reindexes only when needed; it is intentionally safer than forcing a
full rebuild on every write.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class FileStamp:
    path: str
    mtime_ns: int
    size: int


STOP = False


def _handle_stop(signum, frame):  # noqa: ANN001 - signal handler signature
    global STOP
    STOP = True


def iter_memory_markdown_files(workspace: Path) -> Iterable[Path]:
    root_memory = workspace / "MEMORY.md"
    if root_memory.is_file():
        yield root_memory

    memory_dir = workspace / "memory"
    if memory_dir.is_dir():
        for path in memory_dir.rglob("*.md"):
            # Ignore symlinks; OpenClaw builtin scanner does not follow them.
            if path.is_file() and not path.is_symlink():
                yield path


def snapshot(workspace: Path) -> tuple[FileStamp, ...]:
    stamps: list[FileStamp] = []
    for path in iter_memory_markdown_files(workspace):
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        stamps.append(FileStamp(str(path.relative_to(workspace)), stat.st_mtime_ns, stat.st_size))
    stamps.sort(key=lambda item: item.path)
    return tuple(stamps)


def log(message: str, *, log_file: Path | None = None) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S %z')} {message}"
    print(line, flush=True)
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def run_incremental_index(workspace: Path, agent: str, openclaw_bin: str, log_file: Path | None) -> int:
    cmd = [openclaw_bin, "memory", "status", "--index", "--agent", agent]
    log(f"index start: {' '.join(cmd)}", log_file=log_file)
    started = time.monotonic()
    proc = subprocess.run(
        cmd,
        cwd=str(workspace),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    elapsed = time.monotonic() - started
    output = proc.stdout.strip()
    if output:
        for line in output.splitlines()[-80:]:
            log(f"index output: {line}", log_file=log_file)
    log(f"index done: exit={proc.returncode} elapsed={elapsed:.1f}s", log_file=log_file)
    return proc.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Auto-index OpenClaw durable memory after file writes.")
    parser.add_argument("--workspace", default=os.getcwd(), help="OpenClaw workspace path")
    parser.add_argument("--agent", default="makaron", help="OpenClaw agent id")
    parser.add_argument("--openclaw-bin", default="openclaw", help="openclaw executable")
    parser.add_argument("--poll-seconds", type=float, default=5.0, help="Filesystem polling interval")
    parser.add_argument("--debounce-seconds", type=float, default=15.0, help="Quiet period before indexing")
    parser.add_argument("--startup-index", action="store_true", help="Run one incremental index on startup")
    parser.add_argument("--once", action="store_true", help="Run one incremental index and exit")
    parser.add_argument("--log-file", default="/vercel/sandbox/agent-data/state/logs/memory-auto-index.log")
    args = parser.parse_args()

    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)

    workspace = Path(args.workspace).expanduser().resolve()
    log_file = Path(args.log_file).expanduser().resolve() if args.log_file else None

    if not workspace.is_dir():
        log(f"fatal: workspace does not exist: {workspace}", log_file=log_file)
        return 2

    if args.once:
        return run_incremental_index(workspace, args.agent, args.openclaw_bin, log_file)

    log(
        f"watch start: workspace={workspace} agent={args.agent} poll={args.poll_seconds}s debounce={args.debounce_seconds}s",
        log_file=log_file,
    )

    current = snapshot(workspace)
    if args.startup_index:
        run_incremental_index(workspace, args.agent, args.openclaw_bin, log_file)
        current = snapshot(workspace)

    pending_since: float | None = None
    pending_snapshot = current

    while not STOP:
        time.sleep(max(args.poll_seconds, 0.5))
        latest = snapshot(workspace)
        now = time.monotonic()

        if latest != current:
            changed_count = abs(len(latest) - len(current))
            # Count exact stamp differences for readable logs without expensive diffs.
            before = {item.path: item for item in current}
            after = {item.path: item for item in latest}
            changed = sorted(set(before) ^ set(after) | {p for p in set(before) & set(after) if before[p] != after[p]})
            changed_count = len(changed)
            sample = ", ".join(changed[:6]) + (" ..." if len(changed) > 6 else "")
            log(f"change detected: files={changed_count} sample={sample}", log_file=log_file)
            current = latest
            pending_snapshot = latest
            pending_since = now
            continue

        if pending_since is not None and now - pending_since >= args.debounce_seconds:
            rc = run_incremental_index(workspace, args.agent, args.openclaw_bin, log_file)
            # Refresh after indexing. If files changed during indexing, schedule another pass.
            after_index = snapshot(workspace)
            if after_index != pending_snapshot:
                log("change detected during index; scheduling another debounced pass", log_file=log_file)
                current = after_index
                pending_snapshot = after_index
                pending_since = time.monotonic()
            else:
                pending_since = None
                current = after_index
            if rc != 0:
                # Do not exit: a transient provider/network issue should retry on next write.
                log("index command failed; watcher remains active", log_file=log_file)

    log("watch stop", log_file=log_file)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
