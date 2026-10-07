#!/usr/bin/env python3
"""Cross-project relation metric + candidates for the Memory Librarian.

LLM-free first pass (memory/SCHEMA.md「关联」). The Librarian confirms each
candidate and writes a typed line into both pages' `## 相关` section.

- metric: share of projects/*/main.md that link (markdown link) to at least one
  other project's page.
- unlinked_mentions: page A names project B (slug path or an alias from B's
  `关键词` line) but has no markdown link to B.
- co_mentions: pairs of projects named in the same daily-log section
  (memory/2026-*.md, split on `## `), counted over sections.

Writes memory/librarian/relation-candidates.json. Usage:
  librarian-relations.py [--min-co 3] [--top 150] [--metric-only]
"""
import argparse, json, re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEM = ROOT / "memory"
OUT = MEM / "librarian" / "relation-candidates.json"
KW = re.compile(r"(?:别名/)?关键词[：:]\s*(.+)")
LINK = re.compile(r"\]\(([^)#\s]+)")
GENERIC = {"v", "tianyi", "makaron", "openclaw", "feishu", "飞书", "项目", "main", "agent", "cli", "skill", "cron", "scene", "wiki",
           "project", "workflow", "dashboard", "live board", "策划案", "report", "api", "bot", "prd", "demo", "test"}
HUB_SHARE = 0.03  # projects named in >3% of daily-log sections: reported as hubs; pair score is cosine-normalised so they do not dominate


def projects():
    out = {}
    for p in sorted(MEM.glob("projects/*/main.md")):
        slug = p.parent.name
        text = p.read_text(errors="ignore")
        head = re.sub(r"<!--.*?-->", "", "\n".join(text.splitlines()[:25]))  # drop HTML comments (e.g. project path markers)
        aliases = {slug.lower()}
        m = KW.search(head)
        if m:
            for a in re.split(r"[/、,，|｜]", m.group(1)):
                a = re.sub(r"[`*（）()]", "", a).strip().lower()
                if len(a) >= 3 and a not in GENERIC and not a.startswith("oc_"):
                    aliases.add(a)
        title = next((l.lstrip("# ").strip() for l in text.splitlines() if l.startswith("# ")), slug)
        out[slug] = {"path": str(p.relative_to(ROOT)), "title": title, "aliases": sorted(aliases), "text": text}
    # aliases claimed by several projects are ambiguous; drop them
    owners = defaultdict(set)
    for s, d in out.items():
        for a in d["aliases"]:
            owners[a].add(s)
    for s, d in out.items():
        d["aliases"] = [a for a in d["aliases"] if len(owners[a]) == 1 or a == s.lower()]
    return out


def linked_projects(slug, d):
    got = set()
    base = (ROOT / d["path"]).parent
    for l in LINK.findall(d["text"]):
        try:
            full = (base / l).resolve().relative_to(MEM.resolve())
        except ValueError:
            continue
        parts = full.parts
        if len(parts) >= 2 and parts[0] == "projects" and parts[1] != slug:
            got.add(parts[1])
    return got


def mention_re(d):
    return re.compile("|".join(re.escape(a) for a in sorted(d["aliases"], key=len, reverse=True)), re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-co", type=int, default=3)
    ap.add_argument("--top", type=int, default=150)
    ap.add_argument("--metric-only", action="store_true")
    a = ap.parse_args()
    P = projects()
    links = {s: linked_projects(s, d) for s, d in P.items()}
    with_rel = sum(1 for s in P if links[s])
    metric = {"project_mains": len(P), "with_related_link": with_rel, "share": round(with_rel / max(len(P), 1), 3)}
    if a.metric_only:
        print(json.dumps(metric, ensure_ascii=False)); return
    rx = {s: mention_re(d) for s, d in P.items()}

    unlinked = []
    for s, d in P.items():
        low = d["text"].lower()
        for t in P:
            if t == s or t in links[s]:
                continue
            m = rx[t].search(low)
            if m:
                unlinked.append({"from": s, "to": t, "hit": m.group(0)})

    co, freq, nsec = Counter(), Counter(), 0
    for daily in sorted(MEM.glob("2026-*.md")):
        for sec in daily.read_text(errors="ignore").split("\n## "):
            low = sec.lower()
            hit = sorted(s for s in P if rx[s].search(low))
            nsec += 1
            freq.update(hit)
            if 2 <= len(hit) <= 6:  # sections naming many projects are digests, not relations
                for i, x in enumerate(hit):
                    for y in hit[i + 1:]:
                        co[(x, y)] += 1
    hubs = sorted(s for s, n in freq.items() if n > HUB_SHARE * nsec)
    co_list = []
    for (x, y), n in co.items():
        if n < a.min_co:
            continue
        co_list.append({"a": x, "b": y, "sections": n, "score": round(n / (freq[x] * freq[y]) ** 0.5, 3),
                        "linked": (y in links[x] or x in links[y])})
    co_list = sorted(co_list, key=lambda c: -c["score"])[: a.top]

    OUT.write_text(json.dumps({"metric": metric, "unlinked_mentions": unlinked, "co_mentions": co_list,
                               "hubs": hubs, "aliases": {s: d["aliases"] for s, d in P.items()}}, ensure_ascii=False, indent=1))
    print(json.dumps({**metric, "hubs": hubs, "unlinked_mentions": len(unlinked), "co_pairs": len(co_list),
                      "co_pairs_unlinked": sum(1 for c in co_list if not c["linked"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
