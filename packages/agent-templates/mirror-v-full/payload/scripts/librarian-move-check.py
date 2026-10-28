#!/usr/bin/env python3
"""Check that compressing a memory page did not drop identifiers.

2026-10-12 the owner: "压缩为什么会丢信息，这是不好的". Rolling review "moves" old
content into history.md, but the model rewrites while moving (translates,
summarises, merges), and one-line facts such as a backup path or a release
commit were silently dropped twice (issues 19, 20). Nothing checked it.

For every memory/**/*.md page that loses lines, this collects the identifiers
in the removed lines (backtick spans, paths, URLs, commit hashes, Feishu ids)
and requires each one to still appear somewhere in the same project directory
(new main.md, history.md or any sibling page) or in another file touched by
the same change. Missing identifiers are printed with the removed line; the
exit code is 1 so the compile run must restore them (append the removed lines
verbatim to history.md) before committing.

2026-10-13 the owner: an expired rule (third-party marks in footage, cancelled
10-10) was copied into a concept page without its expiry marker and briefs
started enforcing it again. Two more checks, against
memory/librarian/expired-rules.json:
  - an added line matching a registered expired rule must carry the marker
    「已过期、不执行」 (or the older 「已过时」);
  - a removed line that carried a marker must not reappear elsewhere without it.

Usage:
  librarian-move-check.py              # staged changes vs HEAD (run before commit)
  librarian-move-check.py --commit SHA # a past commit vs its parent
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IDENT = re.compile(
    r"`([^`\n]{3,})`"                                   # backtick spans
    r"|(https?://[^\s)>\]]+)"                           # URLs
    r"|\b((?:o[cun]|om)_[0-9a-zA-Z]{12,})"              # Feishu ids
    r"|\b([0-9a-f]{7,40})\b"                            # commit hashes
    r"|((?:[\w.-]+/){1,}[\w.-]+\.(?:md|json|py|sh|cjs|mjs|js|ts|txt|yaml|yml))"  # file paths
    r"|((?:[\w.-]+/){2,}[\w.-]*/?)"                     # dir paths
)


def git(*args: str) -> str:
    return subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=ROOT,
                          capture_output=True, text=True).stdout


def idents(line: str) -> set[str]:
    out = set()
    for m in IDENT.finditer(line):
        tok = next(g for g in m.groups() if g)
        tok = tok.strip().rstrip(".,;:，。；")
        if len(tok) >= 4 and not tok.isdigit():
            out.add(tok)
    return out


def anywhere(tok: str, rev: str | None) -> bool:
    """Content legitimately moved to another page (e.g. ai-patterns -> a project page)."""
    target = [rev] if rev else ["--cached"]
    r = subprocess.run(["git", "grep", "-F", "-q", "-e", tok, *target, "--", "memory", "MEMORY.md", "USER.md"],
                       cwd=ROOT, capture_output=True)
    return r.returncode == 0


MARK = re.compile(r"已过期、不执行|已过时")


def _core(line: str) -> str:
    s = MARK.sub("", line)
    s = re.sub(r"[*`#>\-|【】〔〕·\s]|20\d\d-\d\d-\d\d|the owner|取消", "", s)
    return s[:24]


def expired_check(removed: dict[str, list[str]], added: list[tuple[str, str]]) -> int:
    reg = ROOT / "memory" / "librarian" / "expired-rules.json"
    rules = []
    if reg.exists():
        import json
        for r in json.loads(reg.read_text(encoding="utf-8")).get("rules", []):
            rules.append((r["id"], [re.compile(x, re.I) for x in r.get("patterns", [])],
                          [re.compile(x, re.I) for x in r.get("allow_patterns", [])]))
    bad = 0
    for path, line in added:
        if MARK.search(line) or path.startswith("memory/librarian/") or re.search(r"memory/20\d\d-\d\d-\d\d", path):
            continue
        for rid, pats, allow in rules:
            if any(pt.search(line) for pt in pats) and not any(a.search(line) for a in allow):
                bad += 1
                print(f"{path}: expired rule `{rid}` written without its expiry marker\n    added line: {line.strip()[:200]}")
                break
    marked_cores = {_core(l) for ls in removed.values() for l in ls if MARK.search(l) and len(_core(l)) >= 12}
    for path, line in added:
        if not MARK.search(line) and len(_core(line)) >= 12 and _core(line) in marked_cores:
            bad += 1
            print(f"{path}: moved line lost its expiry marker\n    added line: {line.strip()[:200]}")
    return bad


def scope_of(path: str) -> str:
    parts = path.split("/")
    if len(parts) > 3 and parts[1] == "projects":
        return "/".join(parts[:3]) + "/"
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit")
    ap.add_argument("--against", help="look for identifiers in this revision instead (e.g. HEAD for a retro scan)")
    args = ap.parse_args()
    if args.commit:
        diff = git("diff", "--unified=0", f"{args.commit}^", args.commit, "--", "memory")
        files = git("diff", "--name-only", f"{args.commit}^", args.commit, "--", "memory").split()
        read_new = lambda p: git("show", f"{args.commit}:{p}")
        tree = lambda d: [l for l in git("ls-tree", "-r", "--name-only", args.commit, "--", d).split() if l.endswith(".md")]
    else:
        diff = git("diff", "--cached", "--unified=0", "--", "memory")
        files = git("diff", "--cached", "--name-only", "--", "memory").split()
        read_new = lambda p: git("show", f":{p}")
        tree = lambda d: [l for l in git("ls-files", "--", d).split() if l.endswith(".md")]

    removed: dict[str, list[str]] = {}
    added: list[tuple[str, str]] = []
    cur = None
    cur_new = None
    for line in diff.splitlines():
        if line.startswith("--- "):
            cur = line[6:] if line.startswith("--- a/") else None
        elif line.startswith("+++ "):
            cur_new = line[6:] if line.startswith("+++ b/") else None
            continue
        elif cur_new and cur_new.endswith(".md") and line.startswith("+"):
            added.append((cur_new, line[1:]))
        elif cur and cur.endswith(".md") and line.startswith("-") and not line.startswith("---"):
            removed.setdefault(cur, []).append(line[1:])
    # Only pages that still exist were compressed; deleted/archived files moved whole.
    # index.md and log.md lose pointer lines by design.
    alive = set(files) if not args.commit else set(git("ls-tree", "-r", "--name-only", args.commit, "--", "memory").split())
    removed = {p: ls for p, ls in removed.items()
               if p in alive and p not in ("memory/index.md", "memory/log.md") and not p.startswith("memory/librarian/")}
    grep_rev = args.against or args.commit

    touched_text = "\n".join(read_new(f) for f in files)
    problems = 0
    for path, lines in removed.items():
        scope = scope_of(path)
        if args.against:
            files_then = [l for l in git("ls-tree", "-r", "--name-only", args.against, "--", scope).split() if l.endswith(".md")]
            haystack = "\n".join(git("show", f"{args.against}:{p}") for p in files_then)
        else:
            haystack = touched_text + "\n" + "\n".join(read_new(p) for p in tree(scope))
        for line in lines:
            lost = [t for t in idents(line) if t not in haystack and not anywhere(t, grep_rev)]
            if lost:
                problems += 1
                print(f"{path}: lost {', '.join(sorted(lost))}\n    removed line: {line.strip()[:200]}")
    problems += expired_check(removed, added)
    if problems:
        print(f"\n{problems} problem(s): restore lost lines verbatim to the project's history.md, "
              "and keep expiry markers on expired rules, before committing.")
        return 1
    print(f"ok: {len(removed)} page(s) lost lines; every identifier still present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
