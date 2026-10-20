#!/usr/bin/env python3
"""Which memory pages cannot be reached from memory/index.md by following links?

LLM Wiki navigation only works if every page is reachable index → project
main.md → sub-page. This reuses memory-graph.py's page/link model, walks links
from index.md, and writes memory/librarian/unreachable.json grouped by owner
(project dir, or top-level memory dir) with each page's title and first line so
the Librarian can link it from the right directory page, merge it, or archive it.

Usage: librarian-reachability.py [--metric-only]
"""
import argparse, collections, importlib.util, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mg", ROOT / "scripts" / "memory-graph.py")
mg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mg)


def owner(pid: str) -> str:
    parts = pid.split("/")
    if parts[1] == "projects" and len(parts) > 3:
        return f"projects/{parts[2]}"
    return parts[1] if len(parts) > 2 else "memory"


def first_line(path: Path) -> str:
    try:
        for line in path.read_text(errors="ignore").splitlines():
            s = line.strip().lstrip("#>*- ").strip()
            if s and not s.startswith(("<!--", "---", "_最近复核")):
                return s[:120]
    except OSError:
        pass
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--metric-only", action="store_true")
    a = ap.parse_args()
    d = mg.build()
    nodes = {n["id"]: n for n in d["nodes"]}
    adj = collections.defaultdict(set)
    for l in d["links"]:
        adj[l["source"]].add(l["target"])
    seen, stack = {"memory/index.md"}, ["memory/index.md"]
    while stack:
        for y in adj[stack.pop()]:
            if y not in seen:
                seen.add(y)
                stack.append(y)
    pages = [n for n in nodes.values() if n["k"] != "hub" and "/_TEMPLATE/" not in n["id"]]
    unreach = [n for n in pages if n["id"] not in seen]
    metric = {"pages": len(pages), "reachable": len(pages) - len(unreach),
              "share": round((len(pages) - len(unreach)) / max(len(pages), 1), 3)}
    if a.metric_only:
        print(json.dumps(metric, ensure_ascii=False))
        return
    groups = collections.defaultdict(list)
    for n in sorted(unreach, key=lambda n: n["id"]):
        groups[owner(n["id"])].append({"path": n["id"], "title": n["t"], "kind": n["k"], "inbound": n["in"],
                                       "first_line": first_line(ROOT / n["id"])})
    out = ROOT / "memory" / "librarian" / "unreachable.json"
    # 生产环境靠 boot 建好 librarian/，但从备份恢复的工作区没有这一步，
    # 目录不在时整个夜间 step 3 会挂掉。自己兜底建。
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"metric": metric, "groups": dict(sorted(groups.items(), key=lambda kv: -len(kv[1])))},
                              ensure_ascii=False, indent=1))
    print(json.dumps({**metric, "unreachable": len(unreach), "groups": len(groups)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
