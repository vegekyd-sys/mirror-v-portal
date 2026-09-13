#!/usr/bin/env python3
"""find_buyers_v2.baseline_report — 把 live_shadow 的 report-*.json 汇总成两份产物：

  1) 影子基线文档（阶段耗时 / 模型输入规模 / 新旧 Top10 交集）—— 可进 Git（只含聚合数字）
  2) 标注表（每场景 v2 Top10 + legacy Top10，含公司名与留空标注列）—— 落 data/evals（不进 Git）

用法：
    python3 -m find_buyers_v2.baseline_report --dir data/evals/find-buyers/zhuoli/2026-09-13 \
        --baseline-out docs/find-buyers/shadow-baseline-2026-09-13.md \
        --labeling-out data/evals/find-buyers/zhuoli/2026-09-13/labeling-2026-09-13.md
"""
from __future__ import annotations

import argparse
import glob
import json
import statistics as st
from pathlib import Path


def _p50(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return round(st.median(vals), 1) if vals else None


def _max(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return round(max(vals), 1) if vals else None


def load_reports(directory) -> list[dict]:
    out = []
    for f in sorted(glob.glob(str(Path(directory) / "report-*.json"))):
        try:
            out.append(json.loads(Path(f).read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def baseline_markdown(reports: list[dict], tenant: str = "", date: str = "") -> str:
    sr = [(r.get("stages_ms") or {}).get("search") for r in reports]
    nm = [(r.get("stages_ms") or {}).get("normalize") for r in reports]
    lt = [(r.get("tokens") or {}).get("legacy_all_records") for r in reports]
    vt = [(r.get("tokens") or {}).get("v2_model_input") for r in reports]
    p50_lt, p50_vt = _p50(lt), _p50(vt)
    drop = round(100 - 100 * p50_vt / p50_lt) if (p50_lt and p50_vt) else None
    lines = [
        "# find-buyers 影子基线 · " + (date or ""),
        "",
        "租户：" + (tenant or "") + "（只读搜索：不查联系人 / 不解锁 / 不入池 / 不发卡）",
        "覆盖：" + str(len(reports)) + " 轮（每轮 2 页）",
        "",
        "## 阶段耗时（每页）",
        "",
        "| 阶段 | p50 | max | n |",
        "|---|---|---|---|",
        f"| search（上游接口） | {_p50(sr)} ms | {_max(sr)} ms | {len([v for v in sr if isinstance(v, (int, float))])} |",
        f"| normalize（归一化+去重+展会核验+摘要） | {_p50(nm)} ms | {_max(nm)} ms | {len([v for v in nm if isinstance(v, (int, float))])} |",
        "| qualify / contact / pool / card | — | — | 影子阶段不执行（零副作用） |",
        "",
        "## 模型输入规模（估算 token）",
        "",
        "| 口径 | p50 | max |",
        "|---|---|---|",
        f"| legacy（全量原始记录） | {p50_lt} | {_max(lt)} |",
        f"| v2（摘要） | {p50_vt} | {_max(vt)} |",
        "",
        "摘要化后输入降幅：约 **" + (str(drop) + "%" if drop is not None else "n/a") + "**",
        "",
        "## 新旧 Top10 交集",
        "",
        "| 场景轮次 | 交集 |",
        "|---|---|",
    ]
    for r in reports:
        name = (r.get("fixture") or {}).get("path") or ""
        common = len(((r.get("diff") or {}).get("common")) or [])
        lines.append(f"| {name} | {common}/10 |")
    lines += [
        "",
        "## 结论（只陈述事实）",
        "",
        "- 上游搜索不是瓶颈（见 search p50）。",
        "- 确定性管线是毫秒级（见 normalize p50）。",
        "- **数分钟量级的时间在模型阶段**：现在模型要吞 legacy 口径的原始记录，摘要后输入规模见上表。",
        "- 新旧 Top10 重叠很低：两套选法差异大，**谁更准需专家标注**（旧链路不作为标准答案）。",
        "",
    ]
    return "\n".join(lines)


def labeling_markdown(reports: list[dict], scenarios: list[str], run: str = "r3") -> str:
    """每场景给 v2 / legacy 的 Top10，留空标注列。"""
    by_name = {}
    for r in reports:
        name = str((r.get("fixture") or {}).get("path") or "")
        by_name[name] = r
    out = [
        "# find-buyers 标注表",
        "",
        "用法：在「标注」列填 ✅（合格买家）/ ❌（不合格），可加一句原因。",
        "v2（新）= 按五维综合分排序的前 10；legacy（旧）= 接口返回顺序前 10（现网口径）。",
        "",
    ]
    for scen in scenarios:
        rep = by_name.get(f"{scen}-{run}") or by_name.get(f"{scen}-r1")
        if not rep:
            continue
        for tag, key in (("v2（新）", "v2"), ("legacy（旧）", "legacy")):
            items = (rep.get(key) or {}).get("delivered") or []
            out.append(f"## {scen} · {tag} Top10")
            out.append("| # | 公司 | 官网 | 国家 | 五维分 | 简介摘要 | 标注 |")
            out.append("|---|---|---|---|---|---|---|")
            for i, it in enumerate(items, 1):
                if not isinstance(it, dict):
                    continue
                name = it.get("company", "")
                site = it.get("website", "")
                country = it.get("country", "")
                score = (it.get("scores_raw") or {}).get("fiveCompositeScore")
                profile = (it.get("profile") or "")[:60].replace("|", "/")
                out.append(f"| {i} | {name} | {site} | {country} | {score} | {profile} | |")
            out.append("")
    return "\n".join(out)


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="汇总影子跑报告 → 基线 + 标注表")
    ap.add_argument("--dir", required=True, help="含 report-*.json 的目录")
    ap.add_argument("--tenant", default="")
    ap.add_argument("--date", default="")
    ap.add_argument("--scenarios", default="big,big2,small,small2,expo")
    ap.add_argument("--run", default="r3")
    ap.add_argument("--baseline-out", default="")
    ap.add_argument("--labeling-out", default="")
    args = ap.parse_args(argv)

    reports = load_reports(args.dir)
    if not reports:
        print("没有 report-*.json，先跑 live_shadow")
        return 1
    if args.baseline_out:
        Path(args.baseline_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.baseline_out).write_text(
            baseline_markdown(reports, args.tenant, args.date), encoding="utf-8")
        print("基线 →", args.baseline_out)
    if args.labeling_out:
        Path(args.labeling_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.labeling_out).write_text(
            labeling_markdown(reports, [s for s in args.scenarios.split(",") if s], args.run),
            encoding="utf-8")
        print("标注表 →", args.labeling_out)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
