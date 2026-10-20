#!/usr/bin/env python3
"""探针验收 —— 唯一真正衡量「记忆能不能用」的指标（recall@5）。

memory_search 是 OpenClaw 的**模型工具**，脚本调不到，所以这个脚本只当记账员：
emit 出题 → 模型自己跑 memory_search → record 回填命中页和耗时 → report 算分。

口径依据（不要绕过）：
- skills/memory-promotion-audit/SKILL.md Guardrails：不得凭文件名、链接数或
  `indexed` 字段推断可检索性，必须用真实检索接口证明。
- skills/long-term-memory-update/SKILL.md 第 4–5 步：重建索引后要用 memory_search
  查到新页才算完成；只看文件存在不算。

结果落 onboarding/probe-runs/<YYYY-MM-DD>.json，一天一份，导入编译完（import_pending 归零）跑一次，之后每次大批导入后再跑，可对比。

Usage:
  memory-index-verify.py [--workspace DIR] [--probes FILE] [--date YYYY-MM-DD] emit
  memory-index-verify.py ... record --id P3 --hits "a.md,b.md" --latency-ms 820 [--note ...]
  memory-index-verify.py ... report
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path

TOP_K = 5
RECALL_FLOOR = 0.8
DEFAULT_PROBES = "onboarding/probes.json"
TEMPLATE = {
    "note": "冷启动时由 agent 按这位主人的原料填充；每条题要能用一个页面回答，expect_pages 写相对 memory/ 的路径",
    "probes": [
        {"id": "P1", "question": "这家公司的工商注册名是什么？",
         "expect_pages": ["projects/<slug>/main.md"]},
        {"id": "P2", "question": "「跑量」在他们内部指什么？",
         "expect_pages": ["concepts/glossary.md"]},
    ],
}


def find_workspace(explicit: str | None) -> Path:
    """任意 cwd 下可跑：--workspace 优先，否则从脚本位置和 cwd 往上找 AGENTS.md。"""
    if explicit:
        d = Path(explicit).expanduser().resolve()
        if not (d / "AGENTS.md").is_file():
            sys.exit(f"--workspace {d} 下没有 AGENTS.md")
        return d
    for base in (Path(__file__).resolve().parent, Path.cwd().resolve()):
        for d in (base, *base.parents):
            if (d / "AGENTS.md").is_file():
                return d
    sys.exit("找不到工作区（向上没找到 AGENTS.md），用 --workspace 指定")


def norm(page: str) -> str:
    """命中页/期望页归一：去引号反引号、去 ./ 和 #锚点、去 memory/ 前缀。"""
    s = page.strip().strip("`'\"").split("#")[0].strip()
    while s.startswith("./"):
        s = s[2:]
    if s.startswith("memory/"):
        s = s[len("memory/"):]
    return s.rstrip("/")


def load_probes(path: Path) -> list[dict]:
    if not path.exists():
        print(f"探针题库不存在：{path}", file=sys.stderr)
        print("先建它（格式如下），再跑验收：\n", file=sys.stderr)
        print(json.dumps(TEMPLATE, ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(2)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"读不了题库 {path}：{e}")
    raw = data.get("probes", []) if isinstance(data, dict) else data
    probes = []
    for i, p in enumerate(raw, 1):
        pid = str(p.get("id") or f"P{i}")
        expect = [norm(x) for x in (p.get("expect_pages") or p.get("expect") or []) if str(x).strip()]
        if not expect:
            print(f"[warn] {pid} 没写 expect_pages，这题永远算未命中", file=sys.stderr)
        probes.append({"id": pid, "question": str(p.get("question", "")).strip(), "expect": expect})
    if not probes:
        sys.exit(f"{path} 里一道题都没有")
    return probes


def run_path(ws: Path, date: str) -> Path:
    return ws / "onboarding" / "probe-runs" / f"{date}.json"


def load_run(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            sys.exit(f"{path} 不是合法 JSON：{e}")
    return {"records": {}}


def hit_of(expect: list[str], hits: list[str]) -> str | None:
    """expect_pages 里任一条出现在前 TOP_K 条 hits 中 → 命中，返回命中的那条。"""
    for h in [norm(x) for x in hits[:TOP_K]]:
        for e in expect:
            if h == e or h.endswith("/" + e) or e.endswith("/" + h):
                return h
    return None


def pct(vals: list[int], q: float) -> int | None:
    if not vals:
        return None
    s = sorted(vals)
    return s[max(0, math.ceil(q * len(s)) - 1)]


def cmd_emit(probes: list[dict], run: dict, args) -> int:
    done = run.get("records", {})
    print(f"# 探针待检索清单（{args.date}）  共 {len(probes)} 题，已回填 {len(done)} 题")
    print("# 逐题用 memory_search 跑一次，把返回的前 5 个页面路径按顺序回填。脚本调不到这个工具。\n")
    for p in probes:
        mark = "已回填" if p["id"] in done else "待检索"
        print(f"[{mark}] {p['id']}  {p['question']}")
        print(f"         expect_pages: {', '.join(p['expect']) or '(空)'}")
    print("\n回填命令：")
    print(f"  python3 scripts/memory-index-verify.py --probes {args.probes_arg} record \\")
    print('      --id P3 --hits "concepts/a.md,projects/x/main.md" --latency-ms 820')
    return 0


def cmd_record(probes: list[dict], run: dict, path: Path, args) -> int:
    probe = next((p for p in probes if p["id"] == args.id), None)
    if probe is None:
        sys.exit(f"题库里没有 {args.id}（现有：{', '.join(p['id'] for p in probes)}）")
    hits = [h.strip() for h in args.hits.split(",") if h.strip()] if args.hits else []
    m = hit_of(probe["expect"], hits)
    run.setdefault("records", {})[probe["id"]] = {
        "hits": hits, "latency_ms": args.latency_ms, "hit": bool(m), "matched": m,
        "note": args.note, "recorded_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    run["date"] = args.date
    run["probes_file"] = args.probes_arg
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(run, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{probe['id']} {'命中 ' + m if m else '未命中'}  hits={len(hits)}  {args.latency_ms}ms  → {path}")
    return 0


def cmd_report(probes: list[dict], run: dict, args) -> int:
    recs, misses, lats, hit_n = run.get("records", {}), [], [], 0
    print(f"# 探针验收报告 {args.date}   题库 {args.probes_arg}")
    for p in probes:
        r = recs.get(p["id"])
        if not r:
            misses.append(p["id"])
            print(f"  {p['id']}  未检索   {p['question']}")
            continue
        if r.get("latency_ms") is not None:
            lats.append(int(r["latency_ms"]))
        if r.get("hit"):
            hit_n += 1
            print(f"  {p['id']}  命中 {r.get('matched')}  ({r.get('latency_ms')}ms)  {p['question']}")
        else:
            misses.append(p["id"])
            top = ", ".join(r.get("hits", [])[:TOP_K]) or "(无结果)"
            print(f"  {p['id']}  未命中  期望 {', '.join(p['expect']) or '(空)'} / 实得 {top}")
    total = len(probes)
    out = {"recall_at_5": round(hit_n / total, 3), "answered": len(recs), "total": total,
           "misses": misses, "latency_p50_ms": pct(lats, 0.5), "latency_p95_ms": pct(lats, 0.95),
           "date": args.date}
    print(json.dumps(out, ensure_ascii=False))
    if out["recall_at_5"] < RECALL_FLOOR:
        print(f"recall@5 {out['recall_at_5']} < {RECALL_FLOOR}：记忆不可用，别宣布完成", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="探针验收：recall@5 + 命中页 + 索引延迟")
    ap.add_argument("--workspace")
    ap.add_argument("--probes", default=DEFAULT_PROBES, help=f"题库路径，默认 {DEFAULT_PROBES}")
    ap.add_argument("--date", default=dt.date.today().isoformat(), help="落盘的运行日期，默认今天")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("emit", help="打印待检索的探针列表（给模型看）")
    rec = sub.add_parser("record", help="回填一题的 memory_search 结果")
    rec.add_argument("--id", required=True)
    rec.add_argument("--hits", default="", help="命中页路径，逗号分隔，按 memory_search 返回顺序")
    rec.add_argument("--latency-ms", type=int, default=None)
    rec.add_argument("--note", default=None)
    sub.add_parser("report", help="recall@5 / 未命中题 / 延迟 p50 p95")
    args = ap.parse_args()

    ws = find_workspace(args.workspace)
    args.probes_arg = args.probes
    probes_path = Path(args.probes) if Path(args.probes).is_absolute() else ws / args.probes
    probes = load_probes(probes_path)
    path = run_path(ws, args.date)
    run = load_run(path)
    if args.cmd == "emit":
        return cmd_emit(probes, run, args)
    if args.cmd == "record":
        return cmd_record(probes, run, path, args)
    return cmd_report(probes, run, args)


if __name__ == "__main__":
    sys.exit(main())
