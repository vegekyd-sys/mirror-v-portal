#!/usr/bin/env python3
"""List memory/ pages that other sessions wrote but never committed, for the Librarian to adopt.

2026-10-05 the owner approved: pages V writes in ordinary sessions were never
committed (writing and committing are separate steps, and the Librarian left
other sessions' work alone), so they sat outside git, the nightly compile and
the published wiki. The 21:00 compile now adopts them first.

2026-10-09 the owner extended it to tracked pages: other sessions edit existing
pages (ai-patterns.md, project main.md) and will never commit them. Leaving
those files alone made the Librarian park its own updates in side pages.
Now their uncommitted edits are committed first, and the Librarian updates
the page on top of them like any other page.

A file is adoptable when it is under memory/ and either
  - untracked (any type), or
  - tracked, modified but not committed, and a Markdown page (*.md);
and it has not been modified for --min-age-hours, and the content it would add
has no secret-looking value (whole file for new files, added lines for edits).
Flagged files are listed with line numbers only (never the value) and stay
uncommitted. Machine state (json/log/jsonl written by other jobs) and deleted
files are left to their owners.

Usage:
  librarian-adopt-untracked.py            # JSON report
  librarian-adopt-untracked.py --stage    # also `git add` the adoptable files
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRET = re.compile(
    r"sk-[A-Za-z0-9_-]{20,}|mk_live_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|xox[bpa]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{20,}"
    r"|(?i:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['\"]?[A-Za-z0-9/+_.-]{16,}"
    # user:password pairs such as AUTH="name:value" (2026-10-09: a rotated basic-auth value slipped past)
    r"|(?i:auth\w*|credentials?)\s*[:=]\s*['\"]?[^'\"\s:]+:[^'\"\s]{12,}"
)
# The Librarian's own state is committed by the compile itself.
OWN = ("memory/librarian/",)


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "-c", "core.quotepath=off", *args], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout


def candidates() -> list[tuple[str, str]]:
    """(kind, path) for untracked files and modified tracked *.md pages under memory/."""
    out = git("status", "--porcelain", "-z", "--untracked-files=all", "--", "memory")
    found = []
    for e in out.split("\0"):
        if len(e) < 4:
            continue
        code, rel = e[:2], e[3:]
        if rel.startswith(OWN):
            continue
        if code == "??":
            found.append(("new", rel))
        elif "M" in code and "D" not in code and rel.endswith(".md"):
            found.append(("modified", rel))
    return found


def secret_lines(kind: str, rel: str, path: Path) -> list[int]:
    if kind == "new":
        text = path.read_text(encoding="utf-8", errors="ignore")
        return [i + 1 for i, line in enumerate(text.splitlines()) if SECRET.search(line)]
    # Edited page: scan only what the uncommitted edit adds, reported as new-file line numbers.
    lines, lineno = [], 0
    for line in git("diff", "HEAD", "--unified=0", "--", rel).splitlines():
        m = re.match(r"@@ -\S+ \+(\d+)", line)
        if m:
            lineno = int(m.group(1))
        elif line.startswith("+") and not line.startswith("+++"):
            if SECRET.search(line):
                lines.append(lineno)
            lineno += 1
    return lines


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-age-hours", type=float, default=2)
    ap.add_argument("--stage", action="store_true")
    args = ap.parse_args()

    report = {"adoptable": [], "adoptable_modified": [], "recent": [], "flagged": []}
    for kind, rel in candidates():
        path = ROOT / rel
        if path.is_dir() or path.is_symlink() or not path.exists():
            continue
        age_h = (time.time() - path.stat().st_mtime) / 3600
        if age_h < args.min_age_hours:
            report["recent"].append({"file": rel, "kind": kind, "age_hours": round(age_h, 1)})
            continue
        lines = secret_lines(kind, rel, path)
        if lines:
            report["flagged"].append({"file": rel, "kind": kind, "lines": lines})
        else:
            report["adoptable" if kind == "new" else "adoptable_modified"].append(rel)

    staged = report["adoptable"] + report["adoptable_modified"]
    if args.stage and staged:
        subprocess.run(["git", "add", "--", *staged], cwd=ROOT, check=True)
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
