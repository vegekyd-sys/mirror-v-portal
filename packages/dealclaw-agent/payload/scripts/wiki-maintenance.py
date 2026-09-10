#!/usr/bin/env python3
"""wiki-maintenance.py — deterministic maintenance for V's LLM Wiki layer.

This does the boring automatic work Heartbeat should not keep doing manually:
  1. Link durable wiki pages from memory/index.md.
  2. Append memory/log.md entries for automatic index maintenance.
  3. Scan recent daily logs and create bounded promotion proposals for durable-looking sections.
  4. Auto-promote draft proposals to actual wiki pages.
  5. Run v-evolution.py lint-wiki and report remaining issues.
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEMORY = ROOT / "memory"
INDEX = MEMORY / "index.md"
LOG = MEMORY / "log.md"
PROPOSALS = MEMORY / "proposals"

DURABLE_KEYWORDS = (
    "决定", "原则", "纠正", "规则", "workflow", "Workflow", "架构", "上线", "部署",
    "Heartbeat", "heartbeat", "Cron", "cron", "LLM Wiki", "Wiki", "Makaron", "Report",
    "Supabase", "Cloudflare", "CLI", "协作", "自动", "promote", "promotion", "lesson", "Lesson",
)
SKIP_DAILY_HEADINGS = ("Heartbeat Report",)


def today() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d")


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[#:`*_\[\]()]+", "", text)
    text = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", text)
    return text.strip("-")[:80] or "promotion"


def title_of(path: Path) -> str:
    try:
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("# "):
                return line[2:].strip()
    except OSError:
        pass
    return path.parent.name.replace("-", " ").title()


def existing_links(text: str) -> set[str]:
    return set(re.findall(r"\[[^\]]+\]\(([^)]+)\)", text))


def project_main_pages() -> list[Path]:
    projects = MEMORY / "projects"
    if not projects.exists():
        return []
    return sorted(p for p in projects.glob("*/main.md") if p.is_file())


def ensure_project_index() -> list[str]:
    if not INDEX.exists():
        INDEX.write_text("# Memory Wiki Index\n\n", encoding="utf-8")

    text = INDEX.read_text(encoding="utf-8", errors="ignore")
    links = existing_links(text)
    missing: list[Path] = []
    for path in project_main_pages():
        link = rel(path).replace("memory/", "")
        if link not in links:
            missing.append(path)

    if not missing:
        return []

    # Only build link lines, don't duplicate the heading
    new_link_lines: list[str] = []
    for path in missing:
        link = rel(path).replace("memory/", "")
        new_link_lines.append(f"- [{title_of(path)}]({link})")

    heading = "### Auto-indexed Projects"
    if heading in text:
        # Append to existing Auto-indexed Projects section
        block = "\n".join(new_link_lines) + "\n"
        text = text.replace(heading, heading + "\n" + "\n".join(new_link_lines), 1)
    else:
        block_lines = ["", heading] + new_link_lines
        block = "\n".join(block_lines) + "\n"
        marker = "## Decisions"
        if marker in text:
            text = text.replace(marker, block + "\n" + marker, 1)
        else:
            if "## Projects" not in text:
                text += "\n## Projects\n"
            text += block

    INDEX.write_text(text, encoding="utf-8")
    return [rel(p) for p in missing]


def append_log(kind: str, title: str, lines: list[str]) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    entry = f"\n## [{today()}] {kind} | {title}\n" + "\n".join(f"- {line}" for line in lines) + "\n"
    existing = LOG.read_text(encoding="utf-8", errors="ignore") if LOG.exists() else "# Memory Wiki Log\n"
    # Deduplicate by exact heading.
    heading = f"## [{today()}] {kind} | {title}"
    if heading not in existing:
        LOG.write_text(existing.rstrip() + "\n" + entry, encoding="utf-8")


def recent_daily_files(days: int) -> list[Path]:
    cutoff = dt.date.today() - dt.timedelta(days=days - 1)
    files: list[Path] = []
    for path in sorted(MEMORY.glob("2026-*.md")):
        m = re.match(r"(\d{4}-\d{2}-\d{2})\.md$", path.name)
        if not m:
            continue
        try:
            d = dt.date.fromisoformat(m.group(1))
        except ValueError:
            continue
        if d >= cutoff:
            files.append(path)
    return files


def split_sections(text: str) -> list[tuple[str, str]]:
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", text, flags=re.M))
    out: list[tuple[str, str]] = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        out.append((m.group(1).strip(), text[start:end].strip()))
    return out


def proposal_exists(slug: str) -> bool:
    if not PROPOSALS.exists():
        return False
    return any(slug in p.name for p in PROPOSALS.glob("*.md"))


def create_promotion_proposals(days: int, max_new: int) -> list[str]:
    PROPOSALS.mkdir(parents=True, exist_ok=True)
    created: list[str] = []
    existing_all = ""
    if LOG.exists():
        existing_all += LOG.read_text(encoding="utf-8", errors="ignore")
    for p in PROPOSALS.glob("*.md"):
        existing_all += "\n" + p.name + "\n" + p.read_text(encoding="utf-8", errors="ignore")[:1000]

    for daily in recent_daily_files(days):
        text = daily.read_text(encoding="utf-8", errors="ignore")
        for heading, body in split_sections(text):
            if len(created) >= max_new:
                return created
            if any(skip in heading for skip in SKIP_DAILY_HEADINGS):
                continue
            if not body or not any(k in heading or k in body for k in DURABLE_KEYWORDS):
                continue
            slug = slugify(f"{daily.stem}-{heading}")
            if slug in existing_all or proposal_exists(slug):
                continue
            proposal = PROPOSALS / f"{today()}-memory-promote-{slug}.md"
            excerpt = "\n".join(body.splitlines()[:12]).strip()
            proposal.write_text(
                f"# Promote to LLM Wiki: {heading}\n\n"
                "Type: memory\n"
                "Status: draft\n"
                f"Created: {today()}\n"
                "Requires Tianyi approval: no for non-core wiki pages; yes for core docs/MEMORY.md\n\n"
                "## Source\n\n"
                f"- `{rel(daily)}` section `{heading}`\n\n"
                "## Why this may be durable\n\n"
                "- Detected by heartbeat wiki maintenance from recent daily logs.\n"
                "- Promote only if this is a reusable project workflow, concept, decision, people fact, or operating rule.\n\n"
                "## Source excerpt\n\n"
                f"```markdown\n{excerpt}\n```\n\n"
                "## Target recommendation\n\n"
                "- kind: `project|concept|decision|people|research`\n"
                "- path: TODO\n\n"
                "## Summary to write\n\n"
                "- TODO: synthesize durable claims; do not dump raw logs.\n\n"
                "## Validation\n\n"
                "- Run `python3 scripts/v-evolution.py lint-wiki` after promotion.\n",
                encoding="utf-8",
            )
            created.append(rel(proposal))
    return created


# ── Auto-promotion ───────────────────────────────────────────────────────────

KIND_KEYWORDS: dict[str, list[str]] = {
    "project": ["项目", "project", "Project", "Makaron", "makaron", "CooClip",
                "ABT", "abt", "Certia", "认证", "Tezign", "多芬", "九阳",
                "千川", "workflow", "Workflow", "流水线", "平台"],
    "concept": ["规则", "Rule", "rule", "SOP", "sop", "纠正", "原则", "机制",
                "教训", "lesson", "Lesson", "模式", "pattern", "Pattern",
                "流程", "process", "处理", "规范", "约定"],
    "decision": ["决定", "Decision", "decision", "选择", "choose", "架构",
                 "方向", "采用", "废弃", "deprecated", "不再"],
    # People pages are sensitive and easy to misclassify. Keep this list narrow:
    # generic words like "用户/客户/反馈/测试" belong to projects/concepts unless the
    # proposal is explicitly about a person profile or relationship.
    "people": ["人物", "person", "Person", "people page", "联系人", "contact",
               "Feishu open_id", "open_id", "关系", "wife", "朋友", "同事",
               "owner/human", "张经纬", "陈文建", "李国琳", "郑伟", "雪梨",
               "康浩源", "赵维杰"],
    "research": ["调研", "Research", "research", "探索", "探索", "分析",
                 "Analytics", "数据", "data", "实验", "experiment"],
}

REVIEW_REQUIRED_KINDS = {"people"}


def classify_proposal(heading: str, body: str) -> str:
    """Classify a proposal into a wiki kind based on keyword matching."""
    text = heading + " " + body
    scores: dict[str, int] = {}
    for kind, keywords in KIND_KEYWORDS.items():
        scores[kind] = sum(1 for kw in keywords if kw in text)
    if not any(scores.values()):
        return "concept"  # default fallback
    return max(scores, key=scores.get)  # type: ignore[arg-type]


def extract_title(heading: str) -> str:
    """Extract a wiki-friendly title from a daily log heading."""
    # Remove leading markers like "### " and time ranges
    title = re.sub(r"^#{1,4}\s*", "", heading)
    # Limit length
    if len(title) > 60:
        title = title[:57] + "..."
    return title.strip()


def wiki_page_path(kind: str, slug: str) -> Path:
    """Return the target wiki page path for a kind + slug."""
    kind_dir = {
        "concept": MEMORY / "concepts",
        "decision": MEMORY / "decisions",
        "people": MEMORY / "people",
        "project": MEMORY / "projects",
        "research": MEMORY / "research",
    }
    base = kind_dir.get(kind, MEMORY / "concepts")
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{slug}.md"


def auto_promote_proposals() -> list[dict]:
    """Read all draft proposals, auto-classify, and promote to wiki pages.

    Returns list of promotion results for reporting.
    """
    if not PROPOSALS.exists():
        return []

    results: list[dict] = []

    for prop_path in sorted(PROPOSALS.glob("*.md")):
        try:
            text = prop_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue

        # Only process exact draft proposals. Do not accidentally consume
        # draft_review / blocked proposals as if they were plain drafts.
        if not re.search(r"^Status:\s*draft\s*$", text, re.M | re.I):
            continue

        # Extract heading from proposal
        heading_match = re.search(r"^# Promote to LLM Wiki: (.+)$", text, re.M)
        if not heading_match:
            continue
        heading = heading_match.group(1).strip()

        # Extract source excerpt
        excerpt_match = re.search(r"```markdown\n(.+?)\n```", text, re.DOTALL)
        excerpt = excerpt_match.group(1).strip() if excerpt_match else ""
        if not excerpt:
            continue

        # Extract source daily file
        source_match = re.search(r"`(memory/20\d{2}-\d{2}-\d{2}\.md)`", text)
        source_file = source_match.group(1) if source_match else ""

        # Classify
        kind = classify_proposal(heading, excerpt)
        title = extract_title(heading)

        if kind in REVIEW_REQUIRED_KINDS:
            review_text = re.sub(r"^Status:\s*draft\s*$", "Status: draft_review", text, flags=re.M | re.I)
            if "Review reason:" not in review_text:
                review_text = review_text.replace(
                    "Status: draft_review",
                    "Status: draft_review\nReview reason: people facts require V synthesis; Tianyi approval is not required for routine people memory",
                    1,
                )
            if "Suggested action:" not in review_text:
                review_text = review_text.replace(
                    "Review reason: people facts require V synthesis; Tianyi approval is not required for routine people memory",
                    "Review reason: people facts require V synthesis; Tianyi approval is not required for routine people memory\nSuggested action: V synthesize | edit | merge | skip",
                    1,
                )
            prop_path.write_text(review_text, encoding="utf-8")
            continue

        # Generate slug from proposal filename (strip date and prefix)
        raw_slug = prop_path.stem
        # Remove date prefix: 2026-05-17-memory-promote- → leave the rest
        slug = re.sub(r"^\d{4}-\d{2}-\d{2}-memory-promote-", "", raw_slug)
        if not slug or len(slug) < 3:
            slug = slugify(title)

        # Build wiki page content
        source_ref = f"Source: `{source_file}`" if source_file else ""
        page_content = f"""# {title}

_Auto-promoted from daily log. {source_ref}_

{excerpt}
"""

        # Write wiki page
        page_path = wiki_page_path(kind, slug)
        if page_path.exists():
            # Append to existing page (with separator)
            existing = page_path.read_text(encoding="utf-8", errors="ignore")
            if heading not in existing:
                append_content = f"\n\n---\n\n## {heading}\n\n{excerpt}\n"
                page_path.write_text(existing.rstrip() + append_content, encoding="utf-8")
        else:
            page_path.write_text(page_content, encoding="utf-8")

        # Mark proposal as promoted
        promoted_text = text.replace("Status: draft", "Status: promoted")
        prop_path.write_text(promoted_text, encoding="utf-8")

        results.append({
            "kind": kind,
            "title": title,
            "slug": slug,
            "path": rel(page_path),
            "proposal": rel(prop_path),
        })

    # Update index.md with promoted pages
    if results:
        _update_index_for_promoted(results)

    return results


def _update_index_for_promoted(results: list[dict]) -> None:
    """Add promoted pages to memory/index.md if not already linked."""
    if not INDEX.exists():
        INDEX.write_text("# Memory Wiki Index\n\n> LLM-maintained structured wiki layer.\n\n", encoding="utf-8")

    idx_text = INDEX.read_text(encoding="utf-8", errors="ignore")
    existing_links_set = existing_links(idx_text)

    section_map = {
        "concept": "## Core Concepts",
        "decision": "## Decisions",
        "people": "## People",
        "project": "## Projects",
        "research": "## Research",
    }

    # Group by kind, collect only genuinely new links
    by_kind: dict[str, list[str]] = {}
    for r in results:
        link_target = r["path"].replace("memory/", "")
        if link_target in existing_links_set:
            continue
        link_entry = f"- [{r['title']}]({link_target})"
        by_kind.setdefault(r["kind"], []).append(link_entry)
        existing_links_set.add(link_target)

    if not by_kind:
        return

    # Insert new links under the appropriate section headers
    for kind, kind_links in by_kind.items():
        if not kind_links:
            continue
        section = section_map.get(kind)
        if not section:
            continue
        block = "\n".join(kind_links)
        if section in idx_text:
            idx_text = idx_text.replace(section, section + "\n" + block, 1)
        else:
            idx_text += f"\n{section}\n{block}\n"

    INDEX.write_text(idx_text, encoding="utf-8")


def reindex_all_wiki_pages() -> int:
    """Scan all wiki page dirs and ensure every page is linked from index.md."""
    if not INDEX.exists():
        INDEX.write_text("# Memory Wiki Index\n\n> LLM-maintained structured wiki layer.\n\n", encoding="utf-8")

    idx_text = INDEX.read_text(encoding="utf-8", errors="ignore")
    existing_links_set = existing_links(idx_text)

    section_map = {
        "concepts": "## Core Concepts",
        "decisions": "## Decisions",
        "people": "## People",
        "projects": "## Projects",
        "research": "## Research",
    }

    # Collect all missing links grouped by kind
    skip_names = {"TODO.md"}
    missing_by_kind: dict[str, list[str]] = {}
    for kind_dir_name in ["concepts", "decisions", "people", "projects", "research"]:
        kind_dir = MEMORY / kind_dir_name
        if not kind_dir.is_dir():
            continue
        for page in sorted(kind_dir.glob("*.md")):
            if page.name in skip_names:
                continue
            if "_TEMPLATE" in str(page):
                continue
            link_target = f"{kind_dir_name}/{page.name}"
            if link_target in existing_links_set:
                continue
            t = title_of(page)
            missing_by_kind.setdefault(kind_dir_name, []).append(
                f"- [{t}]({link_target})"
            )

    if not missing_by_kind:
        return 0

    count = 0
    for kind_dir_name, links in missing_by_kind.items():
        section = section_map.get(kind_dir_name)
        if not section:
            continue
        block = "\n".join(links)
        if section in idx_text:
            idx_text = idx_text.replace(section, section + "\n" + block, 1)
        else:
            idx_text += f"\n{section}\n{block}\n"
        count += len(links)

    INDEX.write_text(idx_text, encoding="utf-8")
    return count


def run_lint() -> tuple[int, str]:
    script = ROOT / "scripts" / "v-evolution.py"
    if not script.exists():
        return 0, "lint unavailable: scripts/v-evolution.py missing"
    proc = subprocess.run(
        ["python3", str(script), "lint-wiki"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=60,
    )
    output = (proc.stdout + proc.stderr).strip()
    return proc.returncode, output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=3)
    parser.add_argument("--max-proposals", type=int, default=3)
    args = parser.parse_args()

    changed_links = ensure_project_index()
    created_props = create_promotion_proposals(args.days, args.max_proposals)

    if changed_links:
        append_log("auto-index", "Project wiki pages", [f"Linked `{p}` from `memory/index.md`." for p in changed_links])
    if created_props:
        ts = dt.datetime.now().strftime("%H:%M")
        append_log("candidate", f"Heartbeat promotion proposals {ts}", [f"Created `{p}`." for p in created_props])

    # Auto-promote all draft proposals to wiki pages
    promoted = auto_promote_proposals()
    if promoted:
        ts = dt.datetime.now().strftime("%H:%M")
        promo_log_lines = [
            f"Promoted `{p['title']}` → `{p['path']}` [{p['kind']}]"
            for p in promoted
        ]
        append_log("promote", f"Heartbeat auto-promotion {ts}", promo_log_lines)

    # Full reindex: ensure all wiki pages are linked from index.md
    reindexed = reindex_all_wiki_pages()

    code, lint_output = run_lint()

    print("# Wiki Maintenance")
    print(f"- Indexed project pages: {len(changed_links)}")
    for p in changed_links:
        print(f"  - {p}")
    print(f"- Promotion proposals created: {len(created_props)}")
    for p in created_props:
        print(f"  - {p}")
    print(f"- Auto-promoted to wiki: {len(promoted)}")
    for p in promoted:
        print(f"  - [{p['kind']}] {p['title']} → {p['path']}")
    print(f"- Reindexed pages: {reindexed}")
    print(f"- Lint: {'ok' if code == 0 else 'attention needed'}")
    if lint_output:
        # Keep heartbeat output bounded.
        lines = lint_output.splitlines()
        print("- Lint summary:")
        for line in lines[:24]:
            print(f"  {line}")
        if len(lines) > 24:
            print(f"  ... ({len(lines) - 24} more lines)")

    # Auto-commit changes if anything was modified
    total_changes = len(changed_links) + len(promoted) + reindexed
    if total_changes > 0:
        committed = _git_auto_commit(promoted, reindexed)
        if committed:
            print(f"- Git: committed ({committed})")


def _git_auto_commit(promoted: list[dict], reindexed: int) -> str | None:
    """Stage wiki changes and commit with a summary message. Returns short hash or None."""
    try:
        # Stage wiki-tracked areas only
        subprocess.run(
            ["git", "add", "memory/concepts/", "memory/decisions/", "memory/people/",
             "memory/projects/", "memory/sources/", "memory/index.md", "memory/log.md",
             "memory/ai-patterns.md", "memory/user-patterns.md"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        # Check if anything is staged
        diff = subprocess.run(
            ["git", "diff", "--cached", "--quiet"],
            cwd=ROOT, capture_output=True, timeout=10,
        )
        if diff.returncode == 0:
            return None  # nothing to commit

        # Build commit message
        parts = []
        if promoted:
            count = len(promoted)
            kinds = set(p["kind"] for p in promoted)
            parts.append(f"promote {count} wiki pages ({', '.join(sorted(kinds))})")
        if reindexed > 0:
            parts.append(f"reindex {reindexed} pages")
        msg = "chore(heartbeat): " + "; ".join(parts)

        result = subprocess.run(
            ["git", "commit", "-m", msg],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            # Extract short hash
            hash_result = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=ROOT, capture_output=True, text=True, timeout=10,
            )
            return hash_result.stdout.strip() if hash_result.returncode == 0 else "ok"
        return None
    except Exception:
        return None  # never block on git failures


if __name__ == "__main__":
    main()
