#!/usr/bin/env python3
"""Librarian compile queue built straight from daily logs (replaces heartbeat proposals).

2026-10-03 the owner approved: the 21:00 compile no longer waits for heartbeat
"memory-promote" proposals. Heartbeat produced at most 3 per run (24/day),
oldest day first inside a 3-day window, so the queue ran ~2 days late and
sections that fell out of the window were never queued.

Queue:
  daily    - every section (`## ` heading) of memory/YYYY-MM-DD.md from
             state.since up to yesterday (Asia/Shanghai), not yet marked.
  backfill - sections of state.backfill_days that heartbeat never turned into a
             proposal (any status) and that are not yet marked. Empty by default;
             it only ever mattered for V's own 2026-09 logs.
  import   - 2026-10-20 added. Onboarding corpus: every pending entry of
             memory-archive/imports/MANIFEST.json, split into parts small enough
             for one compile turn. See below.

Why `import` exists
  The Librarian organises memory; it does not create any. Its only inputs used to
  be daily logs and reflections, so on a brand-new tenant the 21:00 run found an
  empty queue every single night — even with a whole company knowledge base
  already sitting in memory-archive/imports/ (measured: 81 documents, 199k chars,
  daily_pending 0). Onboarding is exactly the case where memory has to be built
  rather than tidied, so the imported corpus needs its own way into this queue.
  Once it is in, nothing else changes: the existing nightly loop does the work.

State: memory/librarian/daily-queue.json
  {"since": "YYYY-MM-DD", "backfill_days": [...], "done": {id: {status, note, at}}}
Section id: daily/backfill  "<date>#<heading>" (+ "#<n>" for a repeated heading)
            import          "import#<sha8>" (+ "#<n>" when the document is split)
Import ledger: the MANIFEST entry is the source of truth for an imported document.
  Marking the last outstanding part flips its `disposition`, so the two ledgers
  can never drift apart.

Usage:
  librarian-daily-queue.py list [--kind daily|backfill|import|all] [--limit N]
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
MANIFEST = ROOT / "memory-archive" / "imports" / "MANIFEST.json"
TZ = ZoneInfo("Asia/Shanghai")
SKIP_HEADINGS = ("Heartbeat Report",)
# One compile turn has roughly 8 minutes for up to 30 items, so an imported
# document bigger than this is handed over in parts instead of whole.
IMPORT_PART_CHARS = 3500


def first_log_day() -> str:
    """Earliest memory/YYYY-MM-DD.md, else today.

    The old default pinned `since` to 2026-10-02 and backfilled eight of V's own
    September days. On any other workspace those dates do not exist, and a tenant
    created later would make the queue walk months of missing files. Deriving it
    keeps a fresh workspace at zero and an inherited one at its real first day.
    """
    days = sorted(p.stem for p in MEMORY.glob("[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md"))
    return days[0] if days else dt.datetime.now(TZ).date().isoformat()


def default_state() -> dict:
    return {"since": first_log_day(), "backfill_days": [], "done": {}}


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return default_state()


def load_manifest() -> list[dict]:
    if not MANIFEST.exists():
        return []
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return data.get("items", []) if isinstance(data, dict) else data


def save_manifest(items: list[dict]) -> None:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data["items"] = items
    else:
        data = items
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def split_import(entry: dict) -> list[dict]:
    """One queue item per imported document, or several when it is too long.

    Splits on `## ` first, then `# `, then fixed line blocks, so each part is a
    self-contained read. `file`/`lines` point at the raw document; the compile
    step reads it there — the body never travels through the queue.
    """
    path = ROOT / entry["path"] if not Path(entry["path"]).is_absolute() else Path(entry["path"])
    if not path.exists():
        alt = MEMORY.parent / entry["path"]
        path = alt if alt.exists() else path
    if not path.exists():
        return [{"missing": entry["path"]}]
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    size = lambda a, b: sum(len(x) + 1 for x in lines[a:b])  # noqa: E731
    if size(0, len(lines)) <= IMPORT_PART_CHARS:
        return [{"start": 1, "end": len(lines)}]

    # Cut points: heading lines if the document has them, otherwise every line.
    cuts: list[int] = []
    for pattern in (r"^#{1,3}\s+\S", r"^#\s+\S"):
        found = [i for i, line in enumerate(lines) if re.match(pattern, line)]
        if len(found) >= 2:
            cuts = found
            break
    bounds = sorted({0, *cuts, len(lines)})
    spans = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]

    # 1) Explode any single section that is over budget on its own, by characters
    #    rather than by line count — a 43-line stretch of a dense table measured
    #    27k characters when the chop was line-based.
    atoms: list[tuple[int, int]] = []
    for a, b in spans:
        if size(a, b) <= IMPORT_PART_CHARS:
            atoms.append((a, b))
            continue
        i = a
        while i < b:
            j, acc = i, 0
            while j < b and (j == i or acc + len(lines[j]) + 1 <= IMPORT_PART_CHARS):
                acc += len(lines[j]) + 1
                j += 1
            atoms.append((i, j))
            i = j

    # 2) Pack neighbouring sections back together while they fit, so a document
    #    of many tiny headings does not become a part per heading.
    parts: list[dict] = []
    cur_a, cur_b = atoms[0]
    for a, b in atoms[1:]:
        if size(cur_a, b) <= IMPORT_PART_CHARS:
            cur_b = b
        else:
            parts.append({"start": cur_a + 1, "end": cur_b})
            cur_a, cur_b = a, b
    parts.append({"start": cur_a + 1, "end": cur_b})
    return parts


def import_items(state: dict) -> list[dict]:
    out = []
    for entry in load_manifest():
        if entry.get("disposition") != "pending":
            continue
        parts = split_import(entry)
        if parts and "missing" in parts[0]:
            continue
        for n, part in enumerate(parts, 1):
            sid = f"import#{entry['sha8']}" + (f"#{n}" if len(parts) > 1 else "")
            if sid in state["done"]:
                continue
            out.append({
                "id": sid, "kind": "import", "date": entry.get("fetched_at", "")[:10],
                "heading": entry["title"] + (f"（第 {n}/{len(parts)} 部分）" if len(parts) > 1 else ""),
                "file": entry["path"], "lines": f"{part['start']}-{part['end']}",
                "chars": entry.get("chars", 0), "source": entry.get("source"),
                "url": entry.get("url"), "sha8": entry["sha8"], "parts": len(parts),
            })
    return out


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
    if kind in ("import", "all"):
        items.extend(import_items(state))
    return items


def settle_manifest(marked: list[str], state: dict, status: str, note: str) -> int:
    """Flip a MANIFEST entry once every part of it has been marked.

    Keeps one ledger per imported document: the queue tracks parts, the MANIFEST
    tracks documents, and the document only counts as digested when no part of it
    is still outstanding.
    """
    shas = {i.split("#")[1] for i in marked if i.startswith("import#")}
    if not shas:
        return 0
    items, changed = load_manifest(), 0
    outstanding = {i["sha8"] for i in import_items(state) if i["sha8"] in shas}
    for entry in items:
        if entry["sha8"] in shas and entry["sha8"] not in outstanding and entry.get("disposition") == "pending":
            entry["disposition"] = status
            entry["note"] = note
            entry["marked_at"] = dt.datetime.now(TZ).isoformat(timespec="minutes")
            changed += 1
    if changed:
        save_manifest(items)
    return changed


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_list = sub.add_parser("list")
    p_list.add_argument("--kind", choices=["daily", "backfill", "import", "all"], default="all")
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
            it.pop("body", None)  # import items carry no inline body; the file is read at compile time
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
        settled = settle_manifest(args.ids, state, args.status, args.note)
        print(f"marked {len(args.ids)} {args.status}"
              + (f"; {settled} imported document(s) settled in MANIFEST" if settled else ""))
    else:
        daily = queue(state, "daily")
        backfill = queue(state, "backfill")
        imports = import_items(state)
        by_day: dict[str, int] = {}
        for it in daily + backfill:
            by_day[it["date"]] = by_day.get(it["date"], 0) + 1
        manifest = load_manifest()
        print(json.dumps({"daily_pending": len(daily), "backfill_pending": len(backfill),
                          "import_pending": len(imports),
                          "import_docs_pending": sum(1 for e in manifest if e.get("disposition") == "pending"),
                          "import_docs_total": len(manifest),
                          "done": len(state["done"]), "since": state["since"],
                          "pending_by_day": by_day},
                         ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
