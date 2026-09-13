#!/usr/bin/env python3
"""find_buyers_v2.replay — 固定 fixture 上的 legacy vs v2 A/B（离线、可复现）。

用法：
    python3 -m find_buyers_v2.replay --fixture tests/fixtures/find_buyers/synthetic_3pages.json
    python3 -m find_buyers_v2.replay --fixture <path> --markdown --exhibition 152996309411

fixture 两类（田耕郡 2026-09-13）：
  - 合成结构 fixture：进 Git（tests/fixtures/find_buyers/）；
  - 真实语义 fixture：脱敏后放 data/evals/（该目录已被 .gitignore 忽略，不进 Git）。

本模块只读 fixture、只算不写；replay 不触碰生产写入 / 线索池 / 卡片。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Iterable, Optional

_HERE = Path(__file__).resolve().parent
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

from find_buyers_v2.pipeline import compare_delivery, flatten_pages, run_legacy, run_v2  # noqa: E402
from find_buyers_v2.summarize import estimate_tokens  # noqa: E402


def load_fixture(path) -> dict:
    """读 fixture：{"meta": {...}, "pages": [{"page": n, "records": [...]}, ...]}。"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("pages"), list):
        raise ValueError("fixture 结构非法：需要 {meta, pages:[{page, records}]}")
    return data


def replay(fixture: dict, *, deliver_limit: int = 10,
           target_exhibition_ids: Iterable[str] = (),
           need_contact: bool = False,
           semantic_judge=None, diag=None, rank: str = "api",
           fixture_path: str = "") -> dict:
    """同一份 fixture 同时跑 legacy 与 v2，给出候选 diff、摘要 token 变化、阶段耗时。"""
    pages = fixture.get("pages") or []
    meta = fixture.get("meta") or {}
    if not target_exhibition_ids:
        target_exhibition_ids = meta.get("target_exhibition_ids") or ()
    legacy = run_legacy(pages, deliver_limit=deliver_limit)
    t_norm = time.perf_counter()
    v2 = run_v2(pages, deliver_limit=deliver_limit,
                target_exhibition_ids=target_exhibition_ids,
                semantic_judge=semantic_judge, need_contact=need_contact, rank=rank)
    if diag is not None:
        diag.record_stage("normalize", (time.perf_counter() - t_norm) * 1000.0)
    raw_rows = [r["record"] for r in flatten_pages(pages)]
    return {
        "fixture": {
            "path": fixture_path or meta.get("name", ""),
            "name": meta.get("name", ""),
            "kind": meta.get("kind", "synthetic"),
            "pages": len(pages),
            "records": len(raw_rows),
            "target_exhibition_ids": list(target_exhibition_ids or ()),
            "deliver_limit": deliver_limit,
            "need_contact": need_contact,
        },
        "legacy": legacy,
        "v2": v2,
        "diff": compare_delivery(legacy, v2),
        "tokens": {
            "legacy_all_records": estimate_tokens(raw_rows),
            "v2_model_input": estimate_tokens(v2.get("model_input") or []),
            "note": "估算值（CJK≈1/字，其余≈4 字符/token）；真实用量从运行时读取",
        },
    }


def render_markdown(report: dict) -> str:
    f, d = report["fixture"], report["diff"]
    t = report["tokens"]
    v2 = report["v2"]
    lines = [
        f"# find-buyers replay · {f.get('name') or f.get('path')}",
        "",
        f"- fixture：`{f.get('path')}`（{f.get('kind')}）· {f.get('pages')} 页 / {f.get('records')} 条候选",
        f"- 展会过滤：{f.get('target_exhibition_ids') or '无'} · 交付上限：{f.get('deliver_limit')}"
        f" · 联系方式：{'需要' if f.get('need_contact') else '不需要（跳过 contact）'}",
        "",
        "## 交付对比",
        "",
        f"- legacy 交付 {d['legacy_count']} 家 → v2 交付 {d['v2_count']} 家",
        f"- 同名同域名（交集）：{len(d['common'])} 家",
        f"- 仅 legacy 有：{len(d['only_legacy'])} 家",
        f"- 仅 v2 有：{len(d['only_v2'])} 家",
        f"- 位置一致率：{d['order_agreement']}",
        "",
        "## v2 确定性剔除",
        "",
        f"- 剔除合计 {len(v2.get('excluded') or [])} 条；字段问题 {v2.get('field_issue_count')} 条（只标不剔）",
    ]
    reasons: dict[str, int] = {}
    for row in v2.get("excluded") or []:
        r = row.get("excluded_reason") or "未标注"
        reasons[r] = reasons.get(r, 0) + 1
    for r, n in sorted(reasons.items()):
        lines.append(f"  - {r}：{n}")
    lines += [
        "",
        "## 模型输入（摘要化）",
        "",
        f"- legacy 口径（全量原始记录）估算 token：**{t['legacy_all_records']}**",
        f"- v2 模型摘要估算 token：**{t['v2_model_input']}**",
        f"- 差值：{t['legacy_all_records'] - t['v2_model_input']}（{t['note']}）",
        "",
        "## 联系方式（后置）",
        "",
        f"- {json.dumps(v2.get('contact_plan'), ensure_ascii=False)}",
    ]
    if report.get("stages_ms"):
        lines += ["", "## 阶段耗时（ms）", "", f"- {json.dumps(report['stages_ms'], ensure_ascii=False)}"]
    if report.get("per_page_scores"):
        lines += ["", "## 分页分数分布", "", f"- {json.dumps(report['per_page_scores'], ensure_ascii=False)}"]
    return "\n".join(lines) + "\n"


def _diag(stages: bool):
    if not stages:
        return None
    try:
        from cards.find_buyers_diag import JobDiagnostics
    except Exception:
        return None
    return JobDiagnostics("replay", "", "", dry_run=True)


def main(argv: Optional[list[str]] = None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="find-buyers legacy vs v2 replay")
    ap.add_argument("--fixture", required=True, help="fixture json 路径")
    ap.add_argument("--deliver-limit", type=int, default=10)
    ap.add_argument("--exhibition", action="append", default=[],
                    help="目标展会 ID（可重复；缺省用 fixture.meta）")
    ap.add_argument("--need-contact", action="store_true", help="需要联系方式（默认跳过 contact）")
    ap.add_argument("--stages", action="store_true", help="附带阶段耗时")
    ap.add_argument("--markdown", action="store_true", help="输出 markdown 报告")
    ap.add_argument("--out", default="", help="把报告写到文件")
    args = ap.parse_args(argv)

    fixture = load_fixture(args.fixture)
    diag = _diag(args.stages)
    report = replay(fixture, deliver_limit=args.deliver_limit,
                    target_exhibition_ids=args.exhibition,
                    need_contact=args.need_contact,
                    diag=diag, fixture_path=args.fixture)
    if diag is not None:
        s = diag.summary()
        report["stages_ms"] = {k: v.get("last_ms") for k, v in s["stages"].items()}
    text = render_markdown(report) if args.markdown else json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
