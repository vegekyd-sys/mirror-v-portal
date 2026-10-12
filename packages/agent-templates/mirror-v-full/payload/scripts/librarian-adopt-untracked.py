#!/usr/bin/env python3
"""List memory/ files that other sessions created but never committed, for the Librarian to adopt.

2026-10-05 the owner approved: pages V writes in ordinary sessions were never
committed (writing and committing are separate steps, and the Librarian left
other sessions' work alone), so they sat outside git, the nightly compile and
the published wiki. The 21:00 compile now adopts them first.

A file is adoptable when it is untracked under memory/, has not been modified
for --min-age-hours, and has no secret-looking value. Flagged files are listed
with line numbers only (never the value) and stay uncommitted.

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
)


def untracked() -> list[str]:
    out = subprocess.run(
        ["git", "-c", "core.quotepath=off", "status", "--porcelain", "-z", "--untracked-files=all", "--", "memory"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return [e[3:] for e in out.split("\0") if e.startswith("?? ")]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-age-hours", type=float, default=2)
    ap.add_argument("--stage", action="store_true")
    args = ap.parse_args()

    report = {"adoptable": [], "recent": [], "flagged": []}
    for rel in untracked():
        path = ROOT / rel
        if path.is_dir() or path.is_symlink():
            continue
        age_h = (time.time() - path.stat().st_mtime) / 3600
        if age_h < args.min_age_hours:
            report["recent"].append({"file": rel, "age_hours": round(age_h, 1)})
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        lines = [i + 1 for i, line in enumerate(text.splitlines()) if SECRET.search(line)]
        if lines:
            report["flagged"].append({"file": rel, "lines": lines})
        else:
            report["adoptable"].append(rel)

    if args.stage and report["adoptable"]:
        subprocess.run(["git", "add", "--", *report["adoptable"]], cwd=ROOT, check=True)
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
