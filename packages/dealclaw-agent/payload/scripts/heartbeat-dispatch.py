#!/usr/bin/env python3
"""Manage Knight heartbeat dispatch tasks.

This helper is intentionally filesystem-only. The OpenClaw agent still owns
sub-agent spawning, but this script makes the queue durable and lets the agent
claim/complete tasks without hand-editing TODO files.

Usage:
  python3 scripts/heartbeat-dispatch.py list [--limit 5]
  python3 scripts/heartbeat-dispatch.py claim <task_id> [--session-key KEY] [--run-id ID]
  python3 scripts/heartbeat-dispatch.py complete <task_id> [--note TEXT]
  python3 scripts/heartbeat-dispatch.py fail <task_id> [--note TEXT] [--blocked]
  python3 scripts/heartbeat-dispatch.py skip [<task_id>] --reason TEXT
"""

from __future__ import annotations

import argparse
import json
import hashlib
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DISPATCH_PATH = ROOT / "memory" / "heartbeat-dispatch.json"
LOG_PATH = ROOT / "memory" / "heartbeat-dispatch-log.jsonl"
CONFIG_PATH = ROOT / "knight.config.json"
DEFAULT_REPORT_CHAT_ID = "oc_ff5076a27ba5aef6700721b8c7d69f10"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_dispatch() -> dict:
    if not DISPATCH_PATH.exists():
        raise SystemExit(f"Dispatch file not found: {DISPATCH_PATH}. Run scripts/heartbeat.py first.")
    return json.loads(DISPATCH_PATH.read_text(encoding="utf-8"))


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def report_config(config: dict | None = None) -> dict:
    config = config if isinstance(config, dict) else load_config()
    heartbeat = config.get("heartbeat", {}) if isinstance(config, dict) else {}
    cfg = heartbeat.get("dispatch_report", {}) if isinstance(heartbeat, dict) else {}
    if not isinstance(cfg, dict):
        cfg = {}
    return cfg


def latest_marker_info(task_id: str, todo_path: Path | None = None) -> dict:
    paths = [todo_path] if todo_path else sorted((ROOT / "memory" / "projects").glob("*/TODO.md"))
    marker_re = re.compile(r"<!--\s*heartbeat:\s*(.*?)\s*-->")
    out: dict = {}
    for path in paths:
        if not path or not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if f"task_id={task_id}" not in line or "heartbeat:" not in line:
                continue
            m = marker_re.search(line)
            if not m:
                continue
            fields = {}
            for key, value in re.findall(r"([a-zA-Z_][a-zA-Z0-9_]*)=([^\s>]+)", m.group(1)):
                fields[key] = value
            out = fields
    return out


def short_task_text(task: dict, limit: int = 220) -> str:
    text = str(task.get("task") or task.get("raw") or task.get("task_id") or "").strip()
    text = re.sub(r"^[-*] \[.\]\s*", "", text)
    text = re.sub(r"\s*\(status:\s*[^)]+\)", "", text, flags=re.I).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def format_dispatch_report(event: str, task: dict, note: str = "", blocked: bool = False, marker: dict | None = None) -> str:
    marker = marker or {}
    status = "完成" if event == "complete" else ("阻塞" if blocked else "失败/待重试")
    icon = "✅" if event == "complete" else ("⛔" if blocked else "⚠️")
    lines = [
        f"{icon} Heartbeat swarm 任务{status}",
        f"项目：{task.get('project') or '-'}",
        f"任务：{short_task_text(task)}",
        f"Task ID：{task.get('task_id') or '-'}",
    ]
    if marker.get("session_key"):
        lines.append(f"Session：{marker['session_key']}")
    if marker.get("run_id"):
        lines.append(f"Run：{marker['run_id']}")
    if note:
        lines.append(f"说明：{note}")
    return "\n".join(lines)


def feishu_uuid(value: str, limit: int = 40) -> str:
    # Feishu message uuid is stricter than our task/session ids; underscores and long values
    # can trigger field validation errors. Use a short deterministic alnum/hyphen token.
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:24]
    return f"hb-{digest}"[:limit]


def send_dispatch_report(event: str, task: dict, note: str = "", blocked: bool = False, todo_path: Path | None = None, no_report: bool = False) -> dict:
    cfg = report_config()
    if no_report or cfg.get("enabled", True) is False:
        return {"sent": False, "reason": "disabled" if not no_report else "no_report"}
    events = cfg.get("events", ["complete", "fail"])
    if event not in events:
        return {"sent": False, "reason": "event_not_enabled"}
    chat_id = os.environ.get("HEARTBEAT_DISPATCH_REPORT_CHAT_ID") or cfg.get("target_chat") or DEFAULT_REPORT_CHAT_ID
    user_id = os.environ.get("HEARTBEAT_DISPATCH_REPORT_USER_ID") or cfg.get("target_user") or None
    if not chat_id and not user_id:
        return {"sent": False, "reason": "missing_target"}
    openclaw_bin = os.environ.get("OPENCLAW_BIN") or cfg.get("openclaw_bin") or "/usr/local/bin/openclaw"
    lark_bin = os.environ.get("LARK_CLI_BIN") or cfg.get("lark_cli") or "/usr/local/bin/lark-cli"
    transport = os.environ.get("HEARTBEAT_DISPATCH_REPORT_TRANSPORT") or cfg.get("transport") or "openclaw_message"
    as_identity = cfg.get("as", "bot")
    marker = latest_marker_info(str(task.get("task_id") or ""), todo_path)
    text = format_dispatch_report(event, task, note=note, blocked=blocked, marker=marker)
    dedupe = marker.get("run_id") or marker.get("claimed_at") or "no-claim"
    idempotency_key = feishu_uuid(f"heartbeat-dispatch-{event}-{task.get('task_id')}-{dedupe}")
    if os.environ.get("HEARTBEAT_DISPATCH_REPORT_DRY_RUN") == "1" or cfg.get("dry_run") is True:
        return {"sent": False, "dry_run": True, "target_chat": chat_id, "target_user": user_id, "transport": transport, "text": text, "idempotency_key": idempotency_key}
    if transport == "openclaw_message":
        # Use the OpenClaw Gateway delivery path instead of lark-cli. Heartbeat
        # sub-agents often run in restricted sandboxes where outbound DNS/socket
        # access for lark-cli is blocked, while the Gateway already owns the
        # logged-in Feishu channel and can deliver via local RPC.
        target_value = f"chat:{chat_id}" if chat_id and not str(chat_id).startswith("chat:") else (chat_id or f"user:{user_id}")
        cmd = [
            openclaw_bin, "message", "send",
            "--channel", "feishu",
            "--target", str(target_value),
            "--message", text,
            "--json",
        ]
    else:
        target_flag = "--chat-id" if chat_id else "--user-id"
        target_value = chat_id or user_id
        cmd = [
            lark_bin, "im", "+messages-send",
            "--as", str(as_identity),
            target_flag, str(target_value),
            "--text", text,
            "--idempotency-key", idempotency_key,
            "--format", "json",
        ]
    try:
        result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=int(cfg.get("timeout_seconds", 30)))
        if result.returncode != 0:
            return {"sent": False, "error": (result.stderr or result.stdout or f"exit {result.returncode}").strip()[:800]}
        return {"sent": True, "target_chat": chat_id, "target_user": user_id, "transport": transport, "idempotency_key": idempotency_key}
    except Exception as e:
        return {"sent": False, "error": str(e)[:800]}


def log_event(event: dict) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    event.setdefault("ts", now_iso())
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def find_task(dispatch: dict, task_id: str) -> dict:
    for task in dispatch.get("ready_tasks", []):
        if task.get("task_id") == task_id:
            return task
    for task in dispatch.get("recommended_dispatch", []):
        if task.get("task_id") == task_id:
            return task

    # Claimed tasks disappear from the next dispatch because they are in_progress.
    # Recover them from the heartbeat marker in TODO files so completion/failure
    # can still be recorded after a later heartbeat run.
    projects_dir = ROOT / "memory" / "projects"
    marker = f"task_id={task_id}"
    for todo_path in sorted(projects_dir.glob("*/TODO.md")):
        lines = todo_path.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            if marker in line and "heartbeat:" in line and i > 0:
                return {
                    "task_id": task_id,
                    "project": todo_path.parent.name,
                    "task": lines[i - 1].strip()[6:].strip() if lines[i - 1].strip().startswith("- [") else lines[i - 1].strip(),
                    "todo_path": str(todo_path.relative_to(ROOT)),
                    "line_no": i,
                    "raw": lines[i - 1].strip(),
                }
    raise SystemExit(f"Task id not found in dispatch file or TODO markers: {task_id}")


def read_todo(task: dict) -> tuple[Path, list[str], int]:
    todo_path = ROOT / task["todo_path"]
    if not todo_path.exists():
        raise SystemExit(f"TODO not found: {todo_path}")
    lines = todo_path.read_text(encoding="utf-8").splitlines()
    line_no = int(task["line_no"])
    idx = line_no - 1
    if idx < 0 or idx >= len(lines):
        raise SystemExit(f"Line {line_no} outside file: {todo_path}")
    if task.get("raw") and lines[idx].strip() != task["raw"].strip():
        # Fallback 1: find exact raw line once, in case earlier edits shifted line numbers.
        # Prefer this over marker recovery because old heartbeat notes may sit between
        # the task line and a stale marker.
        matches = [i for i, line in enumerate(lines) if line.strip() == task["raw"].strip()]
        if len(matches) == 1:
            idx = matches[0]
        else:
            # Fallback 2: claimed tasks have a heartbeat marker near the task line.
            marker = f"task_id={task['task_id']}"
            marker_matches = [i for i, line in enumerate(lines) if marker in line and "heartbeat:" in line]
            marker_candidates = []
            for marker_idx in marker_matches:
                j = marker_idx - 1
                while j >= 0 and not lines[j].lstrip().startswith("- ["):
                    j -= 1
                if j >= 0:
                    marker_candidates.append((marker_idx, j))
            # A task can have multiple heartbeat markers after fail/retry. Use
            # the newest marker if they all resolve to the same TODO line. This
            # lets complete/fail recover an in_progress retry even when the
            # latest dispatch snapshot still contains the pre-claim ready line.
            candidate_lines = {j for _, j in marker_candidates}
            if len(candidate_lines) == 1:
                idx = marker_candidates[-1][1]
            elif task.get("task"):
                task_text = task["task"].strip()
                matching = [j for _, j in marker_candidates if task_text in lines[j]]
                if len(set(matching)) == 1:
                    idx = matching[-1]
                else:
                    raise SystemExit(f"TODO line mismatch for {task['task_id']} in {todo_path}")
            else:
                raise SystemExit(f"TODO line mismatch for {task['task_id']} in {todo_path}")
    return todo_path, lines, idx


def replace_status(line: str, status: str) -> str:
    if re.search(r"\(status:\s*[^)]+\)", line, flags=re.I):
        return re.sub(r"\(status:\s*[^)]+\)", f"(status: {status})", line, count=1, flags=re.I)
    return line.rstrip() + f" (status: {status})"


def write_todo(todo_path: Path, lines: list[str]) -> None:
    todo_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def cmd_list(args: argparse.Namespace) -> int:
    dispatch = load_dispatch()
    tasks = dispatch.get("recommended_dispatch") or dispatch.get("ready_tasks", [])
    if args.limit:
        tasks = tasks[: args.limit]
    print(json.dumps({
        "generated_at": dispatch.get("generated_at"),
        "ready_count": dispatch.get("ready_count"),
        "recommended": tasks,
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_claim(args: argparse.Namespace) -> int:
    dispatch = load_dispatch()
    task = find_task(dispatch, args.task_id)
    todo_path, lines, idx = read_todo(task)
    if "[ ]" not in lines[idx]:
        raise SystemExit(f"Task is not open: {todo_path}:{idx+1}")
    lines[idx] = replace_status(lines[idx], "in_progress")
    marker = f"<!-- heartbeat: task_id={args.task_id} claimed_at={now_iso()}"
    if args.session_key:
        marker += f" session_key={args.session_key}"
    if args.run_id:
        marker += f" run_id={args.run_id}"
    marker += " -->"
    lines.insert(idx + 1, marker)
    write_todo(todo_path, lines)
    log_event({"event": "claim", "task_id": args.task_id, "project": task.get("project"), "session_key": args.session_key, "run_id": args.run_id})
    print(f"claimed {args.task_id} -> {todo_path}:{idx+1}")
    return 0


def cmd_complete(args: argparse.Namespace) -> int:
    dispatch = load_dispatch()
    task = find_task(dispatch, args.task_id)
    todo_path, lines, idx = read_todo(task)
    already_done = "[x]" in lines[idx] and bool(re.search(r"\(status:\s*done\)", lines[idx], flags=re.I))
    if not already_done:
        lines[idx] = lines[idx].replace("- [ ]", "- [x]", 1)
        lines[idx] = replace_status(lines[idx], "done")
        if args.note and f"✅ {args.note}" not in lines[idx]:
            lines[idx] = lines[idx].rstrip() + f" ✅ {args.note}"
        write_todo(todo_path, lines)
    elif args.note and args.update_done_note and f"✅ {args.note}" not in lines[idx]:
        lines[idx] = lines[idx].rstrip() + f" ✅ {args.note}"
        write_todo(todo_path, lines)
    # Recovery runs often discover tasks that a sub-agent has already marked
    # done directly in TODO.md. Reporting those again creates noisy duplicate
    # pushes, so suppress already-done reports unless explicitly forced.
    effective_no_report = args.no_report or (already_done and not args.force_report)
    report = send_dispatch_report("complete", task, note=args.note, todo_path=todo_path, no_report=effective_no_report)
    if already_done and not args.no_report and not args.force_report:
        report = {"sent": False, "reason": "already_done_no_report"}
    log_event({"event": "complete", "task_id": args.task_id, "project": task.get("project"), "note": args.note, "already_done": already_done, "report": report})
    print(f"completed {args.task_id} -> {todo_path}:{idx+1}" + (" (already done)" if already_done else ""))
    if report.get("sent"):
        print("reported completion to configured heartbeat target")
    elif report.get("error"):
        print(f"report failed: {report['error']}", file=sys.stderr)
    return 0


def cmd_fail(args: argparse.Namespace) -> int:
    dispatch = load_dispatch()
    task = find_task(dispatch, args.task_id)
    todo_path, lines, idx = read_todo(task)
    status = "blocked" if args.blocked else "ready"
    lines[idx] = replace_status(lines[idx], status)
    if args.note:
        lines.insert(idx + 1, f"  - heartbeat note {now_iso()}: {args.note}")
    write_todo(todo_path, lines)
    report = send_dispatch_report("fail", task, note=args.note, blocked=args.blocked, todo_path=todo_path, no_report=args.no_report)
    log_event({"event": "fail", "task_id": args.task_id, "project": task.get("project"), "blocked": args.blocked, "note": args.note, "report": report})
    print(f"marked {args.task_id} as {status} -> {todo_path}:{idx+1}")
    if report.get("sent"):
        print("reported failure/blocker to configured heartbeat target")
    elif report.get("error"):
        print(f"report failed: {report['error']}", file=sys.stderr)
    return 0


def cmd_skip(args: argparse.Namespace) -> int:
    dispatch = load_dispatch()
    task = find_task(dispatch, args.task_id) if args.task_id else {}
    event = {
        "event": "skip",
        "reason": args.reason,
        "ready_count": dispatch.get("ready_count"),
        "recommended_count": len(dispatch.get("recommended_dispatch") or []),
    }
    if args.task_id:
        event.update({"task_id": args.task_id, "project": task.get("project")})
    log_event(event)
    target = args.task_id or "dispatch-cycle"
    print(f"skipped {target}: {args.reason}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list")
    p_list.add_argument("--limit", type=int, default=5)
    p_list.set_defaults(func=cmd_list)

    p_claim = sub.add_parser("claim")
    p_claim.add_argument("task_id")
    p_claim.add_argument("--session-key", default="")
    p_claim.add_argument("--run-id", default="")
    p_claim.set_defaults(func=cmd_claim)

    p_complete = sub.add_parser("complete")
    p_complete.add_argument("task_id")
    p_complete.add_argument("--note", default="")
    p_complete.add_argument("--no-report", action="store_true", help="do not send completion report")
    p_complete.add_argument("--force-report", action="store_true", help="send report even when the TODO is already done")
    p_complete.add_argument("--update-done-note", action="store_true", help="append note even if task is already marked done")
    p_complete.set_defaults(func=cmd_complete)

    p_fail = sub.add_parser("fail")
    p_fail.add_argument("task_id")
    p_fail.add_argument("--note", default="")
    p_fail.add_argument("--blocked", action="store_true")
    p_fail.add_argument("--no-report", action="store_true", help="do not send failure/blocker report")
    p_fail.set_defaults(func=cmd_fail)

    p_skip = sub.add_parser("skip")
    p_skip.add_argument("task_id", nargs="?")
    p_skip.add_argument("--reason", required=True)
    p_skip.set_defaults(func=cmd_skip)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
