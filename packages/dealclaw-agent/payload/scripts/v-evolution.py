#!/usr/bin/env python3
"""V evolution helper: Git audit + Knight OS reflection + LLM Wiki operations.

Usage:
  python3 scripts/v-evolution.py status
  python3 scripts/v-evolution.py new <type> <slug> [--title "..."]
  python3 scripts/v-evolution.py report [--days 7]
  python3 scripts/v-evolution.py lint-wiki
  python3 scripts/v-evolution.py promote <source> --kind <concept|project|decision|people|research> --slug <slug> --title "..." [--summary "..."]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEMORY = ROOT / "memory"
PROPOSALS = MEMORY / "proposals"
REFLECTIONS = MEMORY / "reflections"
LOG = MEMORY / "log.md"
INDEX = MEMORY / "index.md"
VALID_TYPES = {"memory", "skill", "rule", "worker", "heartbeat", "makaron", "research"}
PROMOTE_KINDS = {"concept", "project", "decision", "people", "research"}
CORE_DOCS = {"AGENTS.md", "SOUL.md", "REDLINES.md", "MEMORY.md"}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def run(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, cwd=ROOT, text=True, stderr=subprocess.STDOUT)


def slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", s)
    return s.strip("-") or "proposal"


def today_local() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d")


def parse_iso(ts: str) -> dt.datetime | None:
    if not ts:
        return None
    try:
        return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def read_reflections(days: int) -> list[dict]:
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    rows: list[dict] = []
    if not REFLECTIONS.exists():
        return rows
    for path in sorted(REFLECTIONS.glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            created = parse_iso(row.get("created_at", ""))
            if created is None or created >= cutoff:
                row["_path"] = rel(path)
                rows.append(row)
    return rows


def git_status_lines() -> list[str]:
    try:
        return run(["git", "status", "--porcelain"]).splitlines()
    except Exception:
        return []


def status(_: argparse.Namespace) -> None:
    print("## git status")
    try:
        print(run(["git", "status", "--short", "--branch"]).rstrip())
    except Exception as exc:
        print(f"git status failed: {exc}")
        return

    changed = git_status_lines()
    core_changed = []
    for line in changed:
        path = line[3:] if len(line) > 3 else ""
        if path in CORE_DOCS:
            core_changed.append(path)
    if core_changed:
        print("\n!! Core docs changed; require Tianyi confirmation before apply/commit:")
        for path in core_changed:
            print(f"- {path}")


def new(args: argparse.Namespace) -> None:
    typ = args.type
    if typ not in VALID_TYPES:
        raise SystemExit(f"invalid type {typ!r}; use one of: {', '.join(sorted(VALID_TYPES))}")

    date = today_local()
    slug = slugify(args.slug)
    path = PROPOSALS / f"{date}-{typ}-{slug}.md"
    title = args.title or f"{typ}: {args.slug}"
    if path.exists():
        raise SystemExit(f"proposal already exists: {path}")

    PROPOSALS.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"# {title}\n\n"
        f"Type: {typ}\n"
        f"Status: draft\n"
        f"Created: {date}\n"
        f"Requires Tianyi approval: {'yes' if typ in {'rule', 'skill'} else 'tbd'}\n\n"
        "## Why\n\n"
        "- \n\n"
        "## Proposed change\n\n"
        "- \n\n"
        "## Files likely affected\n\n"
        "- \n\n"
        "## Safety / boundaries\n\n"
        "- No secrets.\n"
        "- Core docs require exact diff + explicit confirmation before modification.\n\n"
        "## Validation\n\n"
        "- \n\n"
        "## Decision log\n\n"
        "- Draft created.\n",
        encoding="utf-8",
    )
    print(rel(path))


def report(args: argparse.Namespace) -> None:
    """Report what V learned/changed recently by combining Knight reflections, proposals, wiki log, and git."""
    days = args.days
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    print(f"# V Evolution Report — last {days} days")
    print()

    print("## Git changes")
    try:
        commits = run([
            "git",
            "log",
            f"--since={days} days ago",
            "--oneline",
            "--decorate",
            "--",
            "docs",
            "memory",
            "scripts",
            "AGENTS.md",
            "SOUL.md",
            "REDLINES.md",
            "MEMORY.md",
        ]).strip()
        print(commits or "- No tracked evolution commits.")
    except Exception as exc:
        print(f"- git log unavailable: {exc}")
    print()

    print("## Knight reflections")
    rows = read_reflections(days)
    if not rows:
        print("- No recent reflections.")
    else:
        for row in rows[-10:]:
            ctx = row.get("context", "(no context)")
            nxt = row.get("next_time", "")
            print(f"- {ctx}")
            if nxt:
                print(f"  - next: {nxt[:180]}")
    print()

    print("## Open proposals")
    proposals = sorted(PROPOSALS.glob("*.md")) if PROPOSALS.exists() else []
    pending = []
    for path in proposals:
        text = path.read_text(encoding="utf-8", errors="ignore")
        if re.search(r"^Status:\s*(draft|proposed|pending)", text, re.M | re.I):
            pending.append(path)
    if not pending:
        print("- No pending proposals.")
    else:
        for path in pending[-12:]:
            first = path.read_text(encoding="utf-8", errors="ignore").splitlines()[0].lstrip("# ")
            print(f"- {first} — `{rel(path)}`")
    print()

    print("## Wiki log entries")
    if LOG.exists():
        entries = []
        current: list[str] = []
        for line in LOG.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("## [") and current:
                entries.append("\n".join(current))
                current = [line]
            elif line.startswith("## ["):
                current = [line]
            elif current:
                current.append(line)
        if current:
            entries.append("\n".join(current))
        if entries:
            for entry in entries[-5:]:
                print(entry)
                print()
        else:
            print("- No parseable wiki log entries.")
    else:
        print("- memory/log.md missing.")
    print()

    dirty = git_status_lines()
    if dirty:
        print("## Needs attention")
        core = [line for line in dirty if (line[3:] if len(line) > 3 else "") in CORE_DOCS]
        if core:
            print("- Core docs have uncommitted changes; require Tianyi confirmation before apply/commit.")
        print(f"- Working tree has {len(dirty)} changed/untracked tracked-scope item(s). Run `python3 scripts/v-evolution.py status`.")


def extract_links(markdown: str) -> list[str]:
    return re.findall(r"\[[^\]]+\]\(([^)]+)\)", markdown)


def lint_wiki(_: argparse.Namespace) -> None:
    """Basic structural lint for the LLM Wiki."""
    problems: list[str] = []
    warnings: list[str] = []

    required = [INDEX, LOG, MEMORY / "concepts" / "llm-wiki.md", MEMORY / "decisions" / "2026-05-09-memory-wiki-upgrade.md"]
    for path in required:
        if not path.exists():
            problems.append(f"missing required wiki file: {rel(path)}")

    if INDEX.exists():
        index_text = INDEX.read_text(encoding="utf-8", errors="ignore")
        for link in extract_links(index_text):
            if link.startswith(("http://", "https://", "#")):
                continue
            target = (INDEX.parent / link).resolve()
            if not target.exists():
                problems.append(f"broken index link: {link}")

        indexed = set(extract_links(index_text))
        wiki_dirs = ["concepts", "projects", "decisions", "people", "sources"]
        for d in wiki_dirs:
            base = MEMORY / d
            if not base.exists():
                continue
            for path in sorted(base.rglob("*.md")):
                # Content batches are project working artifacts, not top-level wiki pages.
                # The project main page should link/summarize them when they become durable.
                if path.name.startswith("content-batch-"):
                    continue
                r = rel(path).replace("memory/", "")
                if r not in indexed:
                    warnings.append(f"wiki page not linked from memory/index.md: {rel(path)}")

    if PROPOSALS.exists():
        for path in sorted(PROPOSALS.glob("*.md")):
            text = path.read_text(encoding="utf-8", errors="ignore")
            if re.search(r"^Status:\s*draft", text, re.M | re.I):
                warnings.append(f"draft proposal pending: {rel(path)}")

    dirty = git_status_lines()
    core_dirty = [line[3:] for line in dirty if len(line) > 3 and line[3:] in CORE_DOCS]
    for path in core_dirty:
        problems.append(f"core doc has uncommitted change requiring Tianyi confirmation: {path}")

    print("# LLM Wiki Lint")
    print()
    if problems:
        print("## Problems")
        for p in problems:
            print(f"- {p}")
    else:
        print("## Problems")
        print("- None")
    print()
    if warnings:
        print("## Warnings")
        for w in warnings:
            print(f"- {w}")
    else:
        print("## Warnings")
        print("- None")

    if problems:
        raise SystemExit(1)


def target_for(kind: str, slug: str) -> Path:
    date = today_local()
    if kind == "concept":
        return MEMORY / "concepts" / f"{slug}.md"
    if kind == "project":
        return MEMORY / "projects" / slug / "main.md"
    if kind == "decision":
        return MEMORY / "decisions" / f"{date}-{slug}.md"
    if kind == "people":
        return MEMORY / "people" / f"{slug}.md"
    if kind == "research":
        return MEMORY / "research" / f"{slug}.md"
    raise ValueError(kind)


def promote(args: argparse.Namespace) -> None:
    """Promote a source/reflection/research note into an LLM Wiki draft or page.

    Without --summary, this creates a promotion proposal. With --summary, it creates the target wiki page
    and appends memory/log.md. This still does not touch core docs.
    """
    source = (ROOT / args.source).resolve() if not Path(args.source).is_absolute() else Path(args.source)
    if not source.exists():
        raise SystemExit(f"source not found: {source}")
    if args.kind not in PROMOTE_KINDS:
        raise SystemExit(f"invalid kind {args.kind!r}; use one of: {', '.join(sorted(PROMOTE_KINDS))}")

    slug = slugify(args.slug or source.stem)
    title = args.title or slug.replace("-", " ").title()
    summary = (args.summary or "").strip()

    if not summary:
        PROPOSALS.mkdir(parents=True, exist_ok=True)
        proposal = PROPOSALS / f"{today_local()}-memory-promote-{slug}.md"
        if proposal.exists():
            raise SystemExit(f"proposal already exists: {rel(proposal)}")
        proposal.write_text(
            f"# Promote to LLM Wiki: {title}\n\n"
            "Type: memory\n"
            "Status: draft\n"
            f"Created: {today_local()}\n"
            "Requires Tianyi approval: tbd\n\n"
            "## Source\n\n"
            f"- `{rel(source)}`\n\n"
            "## Target\n\n"
            f"- kind: `{args.kind}`\n"
            f"- slug: `{slug}`\n"
            f"- path: `{rel(target_for(args.kind, slug))}`\n\n"
            "## Summary to write\n\n"
            "- TODO: synthesize durable claims from source.\n\n"
            "## Validation\n\n"
            "- Run `python3 scripts/v-evolution.py lint-wiki` after promotion.\n\n"
            "## Safety\n\n"
            "- Do not copy secrets or private raw transcript details unnecessarily.\n"
            "- Prefer synthesis over raw dump.\n",
            encoding="utf-8",
        )
        print(rel(proposal))
        return

    target = target_for(args.kind, slug)
    if target.exists() and not args.force:
        raise SystemExit(f"target exists; use --force to overwrite: {rel(target)}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        f"# {title}\n\n"
        f"Status: active\n"
        f"Created: {today_local()}\n"
        f"Source: `{rel(source)}`\n\n"
        "## Summary\n\n"
        f"{summary}\n\n"
        "## Notes\n\n"
        "- Promoted via `scripts/v-evolution.py promote`.\n",
        encoding="utf-8",
    )

    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(
            f"\n## [{today_local()}] promote | {title}\n"
            f"- Source: `{rel(source)}`\n"
            f"- Target: `{rel(target)}`\n"
        )
    print(rel(target))


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(required=True)

    p_status = sub.add_parser("status")
    p_status.set_defaults(func=status)

    p_new = sub.add_parser("new")
    p_new.add_argument("type")
    p_new.add_argument("slug")
    p_new.add_argument("--title")
    p_new.set_defaults(func=new)

    p_report = sub.add_parser("report")
    p_report.add_argument("--days", type=int, default=7)
    p_report.set_defaults(func=report)

    p_lint = sub.add_parser("lint-wiki")
    p_lint.set_defaults(func=lint_wiki)

    p_promote = sub.add_parser("promote")
    p_promote.add_argument("source")
    p_promote.add_argument("--kind", required=True, choices=sorted(PROMOTE_KINDS))
    p_promote.add_argument("--slug")
    p_promote.add_argument("--title")
    p_promote.add_argument("--summary", help="If omitted, create a promotion proposal instead of writing a wiki page.")
    p_promote.add_argument("--force", action="store_true")
    p_promote.set_defaults(func=promote)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
