#!/usr/bin/env python3
"""Show what changed in the production rule sources since the Librarian last looked.

2026-10-13 the owner: he cancelled the third-party-marks restriction on 10-10 by
editing skills (ai-video-brief, remix-video-brief) and the Night Shift D brief
stage, not memory. Memory still held the old rule, so the nightly compile wrote
it back into a concept page and briefs enforced it again. Skills and published
workflows are the source of truth for production rules; memory must follow.

Sources: workspace skills/**/*.md and the latest published release of every
Night Shift workflow (read-only from the Night Shift SQLite). A snapshot of the
previous state lives in .librarian-cache/rule-sources/ (outside memory/, never
indexed).

Usage:
  librarian-rule-sources.py diff     # unified diffs of sources changed since the snapshot
  librarian-rule-sources.py commit   # store the current state as the new snapshot
"""
from __future__ import annotations

import difflib
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".librarian-cache" / "rule-sources"
NS_DB = Path.home() / ".openclaw" / "nightshift" / "nightshift.sqlite"


def current() -> dict[str, str]:
    out: dict[str, str] = {}
    for p in sorted((ROOT / "skills").rglob("*.md")):
        if "/original/" in str(p) or "node_modules" in p.parts:
            continue
        try:
            out[str(p.relative_to(ROOT))] = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
    if NS_DB.exists():
        con = sqlite3.connect(f"file:{NS_DB}?mode=ro", uri=True, timeout=5)
        rows = con.execute(
            "select workflow_id, version, published_at, source_yaml from workflow_releases r "
            "where published_at = (select max(published_at) from workflow_releases where workflow_id = r.workflow_id)"
        ).fetchall()
        con.close()
        for wid, ver, ts, src in rows:
            out[f"nightshift-workflow/{wid}.md"] = f"<!-- {wid} {ver} published {ts} -->\n{src or ''}"
    return out


def key(rel: str) -> str:
    return hashlib.sha1(rel.encode()).hexdigest()


def load_snapshot() -> dict[str, str]:
    idx = CACHE / "index.json"
    if not idx.exists():
        return {}
    names = json.loads(idx.read_text())
    return {rel: (CACHE / key(rel)).read_text(encoding="utf-8") for rel in names if (CACHE / key(rel)).exists()}


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "diff"
    now = current()
    if cmd == "commit":
        CACHE.mkdir(parents=True, exist_ok=True)
        for rel, text in now.items():
            (CACHE / key(rel)).write_text(text, encoding="utf-8")
        (CACHE / "index.json").write_text(json.dumps(sorted(now), ensure_ascii=False, indent=0))
        print(f"snapshot stored: {len(now)} sources")
        return 0
    before = load_snapshot()
    if not before:
        print("no snapshot yet; run `commit` once to set the baseline")
        return 0
    changed = 0
    for rel in sorted(set(now) | set(before)):
        a, b = before.get(rel), now.get(rel)
        if a == b:
            continue
        changed += 1
        if a is None:
            print(f"=== NEW {rel}")
            continue
        if b is None:
            print(f"=== REMOVED {rel}")
            continue
        print(f"=== CHANGED {rel}")
        for line in difflib.unified_diff(a.splitlines(), b.splitlines(), lineterm="", n=1):
            if not line.startswith(("---", "+++")):
                print(line)
    print(f"\n{changed} source(s) changed since the snapshot")
    return 0


if __name__ == "__main__":
    sys.exit(main())
