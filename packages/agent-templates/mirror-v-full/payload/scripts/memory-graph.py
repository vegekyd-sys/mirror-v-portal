#!/usr/bin/env python3
"""memory-graph.py — build a self-contained graph view of V's memory wiki.

Obsidian-style graph view equivalent for the Librarian (see memory/SCHEMA.md).
Nodes are wiki-layer markdown pages; edges are markdown links and backtick
path references between them. Output is one offline HTML file (library and
data inlined). Only titles/paths/stats are embedded — never page bodies — so
secrets inside pages cannot leak through the graph.

Usage: python3 scripts/memory-graph.py [--out artifacts/memory-graph/index.html]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEMORY = ROOT / "memory"
VENDOR = ROOT / "artifacts" / "memory-graph" / "vendor" / "force-graph.min.js"
HISTORY = ROOT / "artifacts" / "memory-graph" / "history.jsonl"

WIKI_DIRS = ["concepts", "decisions", "research", "people", "tools", "procedures",
             "incidents", "sources", "references", "company", "ops", "leads"]
HUBS = ["memory/index.md", "memory/SCHEMA.md", "MEMORY.md", "memory/ai-patterns.md",
        "memory/user-patterns.md", "memory/TODO.md", "PROJECTS.md"]
FRAGMENT_MARK = "Auto-promoted from daily log"

MD_LINK = re.compile(r"\]\(([^)\s]+?\.md)(?:#[^)]*)?\)")
TICK_PATH = re.compile(r"`((?:memory/)?(?:projects|concepts|decisions|research|people|tools)/[^`\s]+?\.md)`")
WIKI_LINK = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")


def collect_pages() -> list[Path]:
    pages: list[Path] = []
    for d in WIKI_DIRS:
        base = MEMORY / d
        if base.is_dir():
            pages += [p for p in base.rglob("*.md") if "_TEMPLATE" not in p.name]
    proj = MEMORY / "projects"
    pages += list(proj.glob("*.md"))          # project-root pages (mostly fragments)
    pages += list(proj.glob("*/*.md"))        # project main.md + first-level subpages
    for h in HUBS:
        p = ROOT / h
        if p.exists():
            pages.append(p)
    return sorted(set(pages))


def kind_of(rel: str, text: str) -> str:
    if rel in HUBS:
        return "hub"
    if FRAGMENT_MARK in text[:400]:
        return "fragment"
    parts = rel.split("/")
    if parts[0] == "memory" and len(parts) > 2:
        top = parts[1]
        if top == "projects":
            if len(parts) == 3:
                return "fragment" if re.match(r"\d{4}-\d{2}-\d{2}", parts[2]) else "project-sub"
            return "project" if parts[-1] in ("main.md", "README.md") else "project-sub"
        kinds = {"concepts": "concept", "decisions": "decision", "research": "research", "people": "person"}
        if top in kinds:
            return kinds[top]
    return "other"


def title_of(text: str, path: Path) -> str:
    for line in text.splitlines()[:15]:
        if line.startswith("# "):
            return line[2:].strip()[:90]
    return path.stem[:90]


def resolve(target: str, src: Path) -> str | None:
    target = target.strip().lstrip("<").rstrip(">")
    if target.startswith(("http://", "https://", "mailto:")):
        return None
    cands = [(src.parent / target)]
    if target.startswith("memory/"):
        cands.append(ROOT / target)
    else:
        cands += [MEMORY / target, ROOT / target]
    for c in cands:
        try:
            r = c.resolve()
        except OSError:
            continue
        if r.exists() and r.is_file():
            try:
                return str(r.relative_to(ROOT))
            except ValueError:
                return None
    return None


def build() -> dict:
    pages = collect_pages()
    texts: dict[str, str] = {}
    for p in pages:
        try:
            texts[str(p.relative_to(ROOT))] = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
    ids = set(texts)
    stem_index: dict[str, str] = {}
    for rel in ids:
        stem_index.setdefault(Path(rel).stem, rel)

    nodes, links, broken = [], set(), 0
    for rel, text in texts.items():
        src = ROOT / rel
        targets = [m.group(1) for m in MD_LINK.finditer(text)]
        targets += [m.group(1) for m in TICK_PATH.finditer(text)]
        for t in targets:
            r = resolve(t, src)
            if r and r in ids and r != rel:
                links.add((rel, r))
            elif r is None and rel == "memory/index.md":
                broken += 1
        for m in WIKI_LINK.finditer(text):
            r = stem_index.get(m.group(1).strip())
            if r and r != rel:
                links.add((rel, r))

    indeg: dict[str, int] = {}
    indeg_no_index: dict[str, int] = {}
    for s, t in links:
        indeg[t] = indeg.get(t, 0) + 1
        if s != "memory/index.md":
            indeg_no_index[t] = indeg_no_index.get(t, 0) + 1

    for rel, text in texts.items():
        parts = rel.split("/")
        project = parts[2] if len(parts) > 3 and parts[1] == "projects" else ""
        nodes.append({
            "id": rel,
            "t": title_of(text, ROOT / rel),
            "k": kind_of(rel, text),
            "p": project,
            "in": indeg.get(rel, 0),
            "in2": indeg_no_index.get(rel, 0),
            "idx": ("memory/index.md", rel) in links,
        })

    counts: dict[str, int] = {}
    for n in nodes:
        counts[n["k"]] = counts.get(n["k"], 0) + 1
    orphans = sum(1 for n in nodes if n["in"] == 0 and n["k"] != "hub")
    archived = sum(1 for p in (MEMORY / "archive" / "fragments").rglob("*.md") if not p.name.startswith("MANIFEST")) if (MEMORY / "archive" / "fragments").exists() else 0
    index_lines = len(texts.get("memory/index.md", "").splitlines())
    stats = {
        "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "pages": len(nodes), "links": len(links), "counts": counts,
        "orphans": orphans, "archived": archived, "index_lines": index_lines,
        "index_broken": broken,
    }
    return {"nodes": nodes, "links": [{"source": s, "target": t} for s, t in sorted(links)], "stats": stats}


def append_history(stats: dict) -> list[dict]:
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    row = {"ts": stats["generated"], "fragment": stats["counts"].get("fragment", 0),
           "compiled": stats["pages"] - stats["counts"].get("fragment", 0) - stats["counts"].get("hub", 0),
           "orphans": stats["orphans"], "archived": stats["archived"], "index_lines": stats["index_lines"]}
    rows = []
    if HISTORY.exists():
        rows = [json.loads(l) for l in HISTORY.read_text().splitlines() if l.strip()]
    if not rows or rows[-1]["ts"][:10] != row["ts"][:10]:
        rows.append(row)
    else:
        rows[-1] = row  # one point per day
    HISTORY.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    return rows


MANIFEST_LINE = re.compile(r"- `(.+?)` → (合并|归档|跳过)[:：]?\s*(.*)")
MANIFEST_ACTION = {"合并": "merged", "归档": "archived", "跳过": "skipped"}


def expand_sources(sources: list[dict]) -> list[dict]:
    """Safety net: a source that points at a batch MANIFEST is expanded to one entry per fragment."""
    out: list[dict] = []
    for s in sources:
        path = ROOT / s.get("source", "")
        if path.name.startswith("MANIFEST") and path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                m = MANIFEST_LINE.match(line)
                if m:
                    out.append({"source": str(path.parent.relative_to(ROOT) / m.group(1)),
                                "action": MANIFEST_ACTION[m.group(2)], "note": m.group(3).strip()})
        else:
            out.append(s)
    return out


def load_runs() -> list[dict]:
    runs_dir = MEMORY / "librarian" / "runs"
    days = []
    for f in sorted(runs_dir.glob("*.json"), reverse=True) if runs_dir.exists() else []:
        try:
            day = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for run in day.get("runs", []):
            run["sources"] = expand_sources(run.get("sources", []))
        # newest run first (the owner 2026-09-28); same time -> the one written later first
        runs = list(enumerate(day.get("runs", [])))
        runs.sort(key=lambda ir: (str(ir[1].get("time", ""))[-8:].lstrip("T"), ir[0]), reverse=True)
        day["runs"] = [r for _, r in runs]
        days.append(day)
    return days


def load_plan() -> list[dict]:
    plan = MEMORY / "librarian" / "backlog-plan.json"
    if not plan.exists():
        return []
    batches = json.loads(plan.read_text(encoding="utf-8")).get("batches", [])
    rows = [{"id": b["id"], "theme": b["theme"], "status": b.get("status", "pending"),
             "n": len(b.get("files", [])), "done_at": b.get("done_at", "")} for b in batches]
    # Old reflections are cleaned after the fragment batches, one "batch" per month.
    cur = MEMORY / "librarian" / "reflections-cursor.json"
    if cur.exists():
        c = json.loads(cur.read_text(encoding="utf-8"))
        for month, status in c.get("backlog", {}).items():
            rows.append({"id": f"reflection-{month}", "theme": f"旧 reflection {month}", "status": status,
                         "n": c.get("backlog_counts", {}).get(month, 0), "done_at": c.get("backlog_done_at", {}).get(month, "")})
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "artifacts" / "memory-graph" / "index.html"))
    args = ap.parse_args()
    data = build()
    data["history"] = append_history(data["stats"])
    data["runs"] = load_runs()
    data["plan"] = load_plan()
    tpl = (Path(__file__).with_name("memory-graph.template.html")).read_text(encoding="utf-8")
    lib = VENDOR.read_text(encoding="utf-8")
    html = tpl.replace("/*__LIB__*/", lib).replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    s = data["stats"]
    print(f"memory-graph: {s['pages']} pages, {s['links']} links, counts={s['counts']}, orphans={s['orphans']}, archived={s['archived']} -> {out}")


if __name__ == "__main__":
    main()
