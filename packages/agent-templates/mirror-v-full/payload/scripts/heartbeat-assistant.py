#!/usr/bin/env python3
"""Proactive heartbeat ("主动推进") helper: the bookkeeping, not the judgement.

The running V decides what is worth telling the owner (skills/proactive-heartbeat).
This script only gathers the material, remembers what was already said, records
the owner's feedback, and applies the few rules that must not depend on a
model's mood: one story is one story, quiet hours, the owner's frequency
setting, and matters the owner said to leave alone.

  context                    gather this round's material into memory/heartbeat/runs/<id>/context.json
  check --story KEY [--urgent]
                             may a notice about this story go out now? (exit 0 yes, 3 hold)
  record --story KEY --title T --text-file F [--run ID]
                             after the notice is final: log it (call it right before the final reply)
  record --silent --reason R [--run ID]
                             log a round that sent nothing, and why
  feedback --story KEY --kind K --quote Q [--note N]
                             the owner's reaction; K in useful|not_useful|handled|paused|corrected|wrong
  review [--hours 24]        notices and feedback for the daily review

State lives under memory/heartbeat/ (notices.jsonl, feedback.jsonl, runs/). It is
the owner's memory like any other page: plain text, in git, no secrets.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

WS = Path(os.environ.get("V_WORKSPACE") or Path(__file__).resolve().parent.parent)
HB = WS / "memory" / "heartbeat"
NOTICES = HB / "notices.jsonl"
FEEDBACK = HB / "feedback.jsonl"
RUNS = HB / "runs"
REPEAT_WINDOW_H = 24          # one story gets one slot per day unless it is urgent and changed
WEEKLY_WINDOW_D = 7
KINDS = {"useful", "not_useful", "handled", "paused", "corrected", "wrong"}
STORY = re.compile(r"^[a-z0-9][a-z0-9._-]{1,79}$")


def tz():
    name = os.environ.get("V_TIMEZONE") or "Asia/Shanghai"
    if ZoneInfo and not name.startswith("@@"):
        try:
            return ZoneInfo(name)
        except Exception:
            pass
    return timezone(timedelta(hours=8))


def now() -> datetime:
    override = os.environ.get("HEARTBEAT_NOW")  # tests
    return datetime.fromisoformat(override) if override else datetime.now(tz())


def read_jsonl(p: Path) -> list[dict]:
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def append_jsonl(p: Path, row: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def at(row: dict) -> datetime:
    return datetime.fromisoformat(row["at"])


def say(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=1))
    sys.exit(code)


# ------------------------------------------------------------------ owner settings (USER.md)

def user_settings() -> dict:
    """Frequency and quiet hours, as the onboarding wrote them into USER.md."""
    text = (WS / "USER.md").read_text(encoding="utf-8") if (WS / "USER.md").exists() else ""
    freq = "daily"
    m = re.search(r"主动触达频率\*\*[:：]\s*([^\n]*)", text)
    if m:
        # The template line lists the options ("daily | weekly | off"); only a single chosen value counts.
        chosen = re.match(r"(daily|weekly|off)\b(?!\s*\|)", m.group(1).strip().lower())
        if chosen:
            freq = chosen.group(1)
    quiet = None
    m = re.search(r"静默时段\*\*[:：]\s*([0-2]?\d)[:：]?(\d{2})?\s*[-–~至到]\s*([0-2]?\d)[:：]?(\d{2})?", text)
    if m:
        quiet = (int(m.group(1)) * 60 + int(m.group(2) or 0), int(m.group(3)) * 60 + int(m.group(4) or 0))
    else:
        quiet = (23 * 60, 8 * 60)  # default: no pushes 23:00–08:00 until the owner says otherwise
    return {"frequency": freq, "quiet": quiet}


def in_quiet(t: datetime, quiet) -> bool:
    if not quiet:
        return False
    m = t.hour * 60 + t.minute
    a, b = quiet
    return a <= m < b if a < b else (m >= a or m < b)


# ------------------------------------------------------------------ material

def recent_files(pattern: str, days: int, limit: int) -> list[dict]:
    cutoff = now().timestamp() - days * 86400
    rows = []
    for p in WS.glob(pattern):
        try:
            st = p.stat()
        except OSError:
            continue
        if st.st_mtime >= cutoff and p.is_file():
            rows.append({"path": str(p.relative_to(WS)), "modified": datetime.fromtimestamp(st.st_mtime, tz()).isoformat(timespec="minutes"),
                         "bytes": st.st_size})
    return sorted(rows, key=lambda r: r["modified"], reverse=True)[:limit]


def open_todos(limit: int = 40) -> list[dict]:
    out = []
    for p in sorted((WS / "memory" / "projects").glob("*/TODO.md")):
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            if re.match(r"\s*[-*]\s*\[ \]", line):
                out.append({"file": str(p.relative_to(WS)), "line": i, "text": line.strip()[:200]})
    return out[:limit]


def dispatch_queue() -> list | str:
    script = WS / "scripts" / "heartbeat-dispatch.py"
    if not script.exists():
        return []
    try:
        r = subprocess.run([sys.executable, str(script), "list", "--limit", "5"], cwd=WS, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable"
    return r.stdout.strip()[-3000:] if r.returncode == 0 else "unavailable"


def story_state() -> dict:
    """Per story: last notice, how many in the window, and the owner's latest word on it."""
    stories: dict[str, dict] = {}
    for n in read_jsonl(NOTICES):
        if n.get("silent"):
            continue
        s = stories.setdefault(n["story"], {"story": n["story"], "notices": 0})
        s["notices"] += 1
        s["last_at"], s["last_title"] = n["at"], n.get("title", "")
    for f in read_jsonl(FEEDBACK):
        s = stories.setdefault(f["story"], {"story": f["story"], "notices": 0})
        s["owner_said"], s["owner_said_at"], s["owner_quote"] = f["kind"], f["at"], f.get("quote", "")
    return stories


def cmd_context(a) -> None:
    run = now().strftime("%Y%m%d-%H%M") + "-" + uuid.uuid4().hex[:6]
    settings = user_settings()
    t = now()
    stories = story_state()
    window = t - timedelta(hours=REPEAT_WINDOW_H)
    recent = [n for n in read_jsonl(NOTICES) if not n.get("silent") and at(n) >= t - timedelta(days=3)]
    ctx = {
        "run": run,
        "now": t.isoformat(timespec="minutes"),
        "owner": {"frequency": settings["frequency"], "quiet_hours": settings["quiet"],
                  "in_quiet_hours": in_quiet(t, settings["quiet"])},
        "recent_attention": [{"at": n["at"], "story": n["story"], "title": n.get("title", "")} for n in recent],
        "notices_last_24h": sum(1 for n in recent if at(n) >= window),
        "leave_alone": sorted(s["story"] for s in stories.values() if s.get("owner_said") in {"handled", "paused", "not_useful"}),
        "stories": sorted(stories.values(), key=lambda s: s.get("last_at", ""), reverse=True)[:30],
        "material": {
            "daily_logs": recent_files("memory/20??-??-??.md", 3, 3),
            "changed_projects": recent_files("memory/projects/*/main.md", 7, 15),
            "decisions": recent_files("memory/decisions/*.md", 14, 10),
            "open_todos": open_todos(),
            "dispatch_queue": dispatch_queue(),
            "librarian_question": (WS / "memory" / "librarian" / "ask.json").exists(),
            "user_profile": "USER.md",
        },
        "rules": "skills/proactive-heartbeat/SKILL.md",
    }
    d = RUNS / run
    d.mkdir(parents=True, exist_ok=True)
    (d / "context.json").write_text(json.dumps(ctx, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    say({"ok": True, "run": run, "context_path": str((d / "context.json").relative_to(WS)),
         "in_quiet_hours": ctx["owner"]["in_quiet_hours"], "frequency": settings["frequency"],
         "notices_last_24h": ctx["notices_last_24h"], "leave_alone": ctx["leave_alone"]})


def decide(story: str, urgent: bool) -> tuple[bool, str]:
    settings = user_settings()
    t = now()
    if settings["frequency"] == "off":
        return False, "owner turned proactive messages off; prepare only"
    if in_quiet(t, settings["quiet"]) and not urgent:
        return False, "quiet hours; hold it for the next round outside them"
    s = story_state().get(story, {})
    if s.get("owner_said") in {"handled", "paused", "not_useful"}:
        return False, f"owner said '{s['owner_said']}' about this story ({s.get('owner_said_at', '')}); leave it unless they bring it up"
    sent = [n for n in read_jsonl(NOTICES) if not n.get("silent")]
    if settings["frequency"] == "weekly" and any(at(n) >= t - timedelta(days=WEEKLY_WINDOW_D) for n in sent) and not urgent:
        return False, "owner wants at most one proactive message a week"
    same = [n for n in sent if n["story"] == story and at(n) >= t - timedelta(hours=REPEAT_WINDOW_H)]
    if same and not urgent:
        return False, "this story already had its slot in the last 24 hours; fold new facts into the original thread or pick another matter"
    return True, "ok"


def cmd_check(a) -> None:
    if not STORY.match(a.story):
        say({"ok": False, "error": "story key: lowercase words joined by - (e.g. contract-renewal-acme)"}, 2)
    allowed, why = decide(a.story, a.urgent)
    say({"ok": True, "story": a.story, "allowed": allowed, "reason": why}, 0 if allowed else 3)


def cmd_record(a) -> None:
    row = {"at": now().isoformat(timespec="seconds"), "run": a.run}
    if a.silent:
        row.update(silent=True, story="-", reason=a.reason or "")
    else:
        if not (a.story and a.title and a.text_file):
            say({"ok": False, "error": "record needs --story, --title and --text-file (or --silent --reason)"}, 2)
        if not STORY.match(a.story):
            say({"ok": False, "error": "bad story key"}, 2)
        allowed, why = decide(a.story, a.urgent)
        if not allowed:
            say({"ok": False, "story": a.story, "error": f"not allowed now: {why}"}, 3)
        text = Path(a.text_file).read_text(encoding="utf-8").strip()
        if not text or text in {"NO_REPLY", "HEARTBEAT_OK"}:
            say({"ok": False, "error": "empty notice"}, 2)
        row.update(story=a.story, title=a.title[:120], chars=len(text), urgent=bool(a.urgent))
        if a.run:
            (RUNS / a.run).mkdir(parents=True, exist_ok=True)
            (RUNS / a.run / "notice.txt").write_text(text + "\n", encoding="utf-8")
    append_jsonl(NOTICES, row)
    say({"ok": True, **row})


def cmd_feedback(a) -> None:
    if a.kind not in KINDS:
        say({"ok": False, "error": f"kind must be one of {sorted(KINDS)}"}, 2)
    if len(a.quote.strip()) < 2:
        say({"ok": False, "error": "quote the owner's actual words"}, 2)
    row = {"at": now().isoformat(timespec="seconds"), "story": a.story, "kind": a.kind, "quote": a.quote.strip()[:300],
           "note": (a.note or "")[:300]}
    append_jsonl(FEEDBACK, row)
    say({"ok": True, **row})


def cmd_review(a) -> None:
    since = now() - timedelta(hours=a.hours)
    notices = [n for n in read_jsonl(NOTICES) if at(n) >= since]
    feedback = [f for f in read_jsonl(FEEDBACK) if at(f) >= since]
    by_story: dict[str, int] = {}
    for n in notices:
        if not n.get("silent"):
            by_story[n["story"]] = by_story.get(n["story"], 0) + 1
    say({"ok": True, "since": since.isoformat(timespec="minutes"),
         "sent": [n for n in notices if not n.get("silent")],
         "silent_rounds": [n for n in notices if n.get("silent")],
         "repeated_stories": {k: v for k, v in by_story.items() if v > 1},
         "feedback": feedback})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("context").set_defaults(fn=cmd_context)
    c = sub.add_parser("check"); c.add_argument("--story", required=True); c.add_argument("--urgent", action="store_true"); c.set_defaults(fn=cmd_check)
    r = sub.add_parser("record")
    r.add_argument("--story"); r.add_argument("--title"); r.add_argument("--text-file"); r.add_argument("--run")
    r.add_argument("--urgent", action="store_true"); r.add_argument("--silent", action="store_true"); r.add_argument("--reason")
    r.set_defaults(fn=cmd_record)
    f = sub.add_parser("feedback")
    f.add_argument("--story", required=True); f.add_argument("--kind", required=True); f.add_argument("--quote", required=True); f.add_argument("--note")
    f.set_defaults(fn=cmd_feedback)
    v = sub.add_parser("review"); v.add_argument("--hours", type=int, default=24); v.set_defaults(fn=cmd_review)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
