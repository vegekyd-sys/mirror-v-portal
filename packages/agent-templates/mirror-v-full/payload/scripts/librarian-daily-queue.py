#!/usr/bin/env python3
"""Librarian compile queue built straight from daily logs (replaces heartbeat proposals).

2026-10-03 the owner approved: the 21:00 compile no longer waits for heartbeat
"memory-promote" proposals. Heartbeat produced at most 3 per run (24/day),
oldest day first inside a 3-day window, so the queue ran ~2 days late and
sections that fell out of the window were never queued.

Queue:
  daily    - every section (`## ` heading) of memory/YYYY-MM-DD.md from
             state.since up to yesterday (Asia/Shanghai), not yet marked.
  backfill - sections of 2026-09-24..2026-10-01 logs that heartbeat never
             turned into a proposal (any status) and that are not yet marked.
             No keyword filter (2026-10-03 trial run): heartbeat's keyword filter
             also hid sections appended to an older log later, e.g. family notes
             added to 09-30 on 10-01..10-03.

State: memory/librarian/daily-queue.json
  {"since": "YYYY-MM-DD", "backfill_days": [...], "done": {id: {status, note, at}}}
Section id: "<date>#<heading>" plus "#<n>" for the n-th repeat of a heading.

Usage:
  librarian-daily-queue.py list [--kind daily|backfill|all] [--limit N]
  librarian-daily-queue.py mark <id> [<id> ...] --status compiled|skipped --note TEXT
  librarian-daily-queue.py stats
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
MEMORY = ROOT / "memory"
STATE = MEMORY / "librarian" / "daily-queue.json"
PROPOSALS = ROOT / "memory-archive" / "proposals"
TZ = ZoneInfo("Asia/Shanghai")
SKIP_HEADINGS = ("Heartbeat Report",)
DEFAULT_STATE = {
    "since": "2026-10-02",
    "backfill_days": [
        "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27",
        "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01",
    ],
    "done": {},
}


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return json.loads(json.dumps(DEFAULT_STATE))


def save_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def slugify(text: str) -> str:
    # Mirrors scripts/wiki-maintenance.py so proposal file names can be matched.
    text = text.strip().lower()
    text = re.sub(r"[#:`*_\[\]()]+", "", text)
    text = re.sub(r"[^a-z0-9一-鿿]+", "-", text)
    return text.strip("-")[:80] or "promotion"


def sections(day: str) -> list[dict]:
    path = MEMORY / f"{day}.md"
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    heads = [i for i, line in enumerate(lines) if re.match(r"^##\s+\S", line)]
    out, seen = [], {}
    for n, start in enumerate(heads):
        end = heads[n + 1] if n + 1 < len(heads) else len(lines)
        heading = re.sub(r"^##\s+", "", lines[start]).strip()
        body = "\n".join(lines[start + 1:end]).strip()
        seen[heading] = seen.get(heading, 0) + 1
        sid = f"{day}#{heading}" + (f"#{seen[heading]}" if seen[heading] > 1 else "")
        out.append({
            "id": sid, "date": day, "heading": heading,
            "file": f"memory/{day}.md", "lines": f"{start + 1}-{end}",
            "chars": len(body), "body": body,
        })
    return out


def proposal_slugs() -> str:
    if not PROPOSALS.exists():
        return ""
    return "\n".join(p.name for p in PROPOSALS.rglob("*memory-promote-*.md"))


def queue(state: dict, kind: str) -> list[dict]:
    done = state["done"]
    yesterday = (dt.datetime.now(TZ).date() - dt.timedelta(days=1)).isoformat()
    items: list[dict] = []
    if kind in ("daily", "all"):
        day = dt.date.fromisoformat(state["since"])
        while day.isoformat() <= yesterday:
            for s in sections(day.isoformat()):
                if s["id"] in done or not s["body"] or any(k in s["heading"] for k in SKIP_HEADINGS):
                    continue
                items.append({**s, "kind": "daily"})
            day += dt.timedelta(days=1)
    if kind in ("backfill", "all"):
        names = proposal_slugs()
        for day in state["backfill_days"]:
            for s in sections(day):
                if s["id"] in done or not s["body"] or any(k in s["heading"] for k in SKIP_HEADINGS):
                    continue
                if f"memory-promote-{slugify(day + '-' + s['heading'])}" in names:
                    continue
                items.append({**s, "kind": "backfill"})
    return items


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_list = sub.add_parser("list")
    p_list.add_argument("--kind", choices=["daily", "backfill", "all"], default="all")
    p_list.add_argument("--limit", type=int, default=0)
    p_mark = sub.add_parser("mark")
    p_mark.add_argument("ids", nargs="+")
    p_mark.add_argument("--status", choices=["compiled", "skipped"], required=True)
    p_mark.add_argument("--note", required=True, help="target page, or skip reason")
    sub.add_parser("stats")
    args = ap.parse_args()

    state = load_state()
    if args.cmd == "list":
        items = queue(state, args.kind)
        if args.limit:
            items = items[: args.limit]
        for it in items:
            it.pop("body")
        print(json.dumps(items, ensure_ascii=False, indent=1))
    elif args.cmd == "mark":
        known = {s["id"] for s in queue(state, "all")}
        unknown = [i for i in args.ids if i not in known and i not in state["done"]]
        if unknown:
            sys.exit(f"unknown section id(s): {unknown}")
        now = dt.datetime.now(TZ).isoformat(timespec="minutes")
        for i in args.ids:
            state["done"][i] = {"status": args.status, "note": args.note, "at": now}
        save_state(state)
        print(f"marked {len(args.ids)} {args.status}")
    else:
        daily = queue(state, "daily")
        backfill = queue(state, "backfill")
        by_day: dict[str, int] = {}
        for it in daily + backfill:
            by_day[it["date"]] = by_day.get(it["date"], 0) + 1
        print(json.dumps({"daily_pending": len(daily), "backfill_pending": len(backfill),
                          "done": len(state["done"]), "pending_by_day": by_day},
                         ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
