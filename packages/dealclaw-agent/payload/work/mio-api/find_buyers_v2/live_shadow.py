#!/usr/bin/env python3
"""find_buyers_v2.live_shadow — 真租户影子跑（只读搜索 + legacy/v2 离线对比）。

前置：先 source 租户的 .env（提供 MIO_V_OPEN_ID / MIO_CDP_SUPPLIER_ID）。
本工具**只调搜索**，不查联系人、不解锁、不写线索池、不发卡；产物全部落在 data/ 下（不进 Git）。

用法：
    python3 -m find_buyers_v2.live_shadow --scenario big \\
        --tag-keyword fan --countries US,DE --pages 2 --runs 2

产物：
    data/evals/find-buyers/<tenant>/<date>/<scenario>-r<run>-p<page>.json          原始响应（本地）
    data/evals/find-buyers/<tenant>/<date>/<scenario>-r<run>-p<page>-redacted.json  脱敏 fixture
    data/evals/find-buyers/<tenant>/<date>/report-<scenario>.json                   legacy/v2 对比 + 诊断
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_MIO = _HERE.parent
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from cards.find_buyers_diag import JobDiagnostics  # noqa: E402
from find_buyers_v2.normalize import normalize_record  # noqa: E402
from find_buyers_v2.replay import load_fixture, render_markdown, replay  # noqa: E402
from find_buyers_v2.summarize import redact_for_fixture  # noqa: E402

_WS_ROOT = _HERE.parents[2]           # payload 根
DEFAULT_SEARCHER = (_WS_ROOT / "skills" / "dealclaw-find-buyers"
                    / "scripts" / "search_aiv2.py")


def run_search(*, tag_keyword="", countries="", page=1, page_size=100,
               pre_exhibition_ids="", features="", categories="",
               searcher: Path = DEFAULT_SEARCHER,
               timeout: int = 120) -> tuple[dict, float]:
    """调一次只读搜索，返回 (响应 dict, 秒)。

    有 categories（结构化采购类目 JSON）时走 xiaoyuan CLI（脚本侧暂无该参数），
    否则走本地 search_aiv2.py。
    """
    if categories:
        cmd = ["xiaoyuan",
               "--open-id", os.environ.get("MIO_V_OPEN_ID", ""),
               "--supplier-id", os.environ.get("MIO_CDP_SUPPLIER_ID", ""),
               "--timeout", str(timeout),
               "buyer", "search", "--supplier-categories", categories,
               "--countries", countries, "--page-num", str(page),
               "--page-size", str(page_size)]
        t0 = time.perf_counter()
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 30)
        elapsed = time.perf_counter() - t0
        if out.returncode != 0:
            raise RuntimeError(f"cli search 失败: {out.stderr[-300:]}")
        return json.loads(out.stdout), elapsed
    cmd = [sys.executable, str(searcher),
           "--open-id", os.environ.get("MIO_V_OPEN_ID", ""),
           "--supplier-id", os.environ.get("MIO_CDP_SUPPLIER_ID", ""),
           "--tag-keyword", tag_keyword, "--countries-json", countries,
           "--page-num", str(page), "--page-size", str(page_size),
           "--timeout", str(timeout)]
    if pre_exhibition_ids:
        cmd += ["--pre-exhibition-ids-json", pre_exhibition_ids]
    if features:
        cmd += ["--features-json", features]
    t0 = time.perf_counter()
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 30)
    elapsed = time.perf_counter() - t0
    if out.returncode != 0:
        raise RuntimeError(f"search 失败: {out.stderr[-300:]}")
    payload = json.loads(out.stdout)
    return payload, elapsed


def to_fixture_pages(raw_pages: list[dict]) -> list[dict]:
    """把 searchAIV2 响应转成 replay 需要的 {page, records}。"""
    pages = []
    for idx, raw in enumerate(raw_pages, start=1):
        data = (raw.get("response") or {}).get("data") or {}
        recs = ((data.get("page") or {}).get("records")
                or data.get("records") or [])
        pages.append({"page": idx, "records": recs})
    return pages


def out_dir(tenant: str, date: str) -> Path:
    return _WS_ROOT / "data" / "evals" / "find-buyers" / tenant / date


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="真租户 find-buyers 影子跑（只读）")
    ap.add_argument("--scenario", required=True, help="场景名，如 big / small / expo")
    ap.add_argument("--tag-keyword", default="")
    ap.add_argument("--countries", default="")
    ap.add_argument("--pre-exhibition-ids", default="")
    ap.add_argument("--categories", default="", help="结构化采购类目 JSON（优先于产品词）")
    ap.add_argument("--features", default="")
    ap.add_argument("--pages", type=int, default=2)
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--deliver-limit", type=int, default=10)
    ap.add_argument("--tenant", default=os.environ.get("DC_TENANT_NAME", "unknown"))
    ap.add_argument("--no-raw", action="store_true", help="不保存原始响应（只存脱敏）")
    args = ap.parse_args(argv)

    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    target = out_dir(args.tenant, date)
    target.mkdir(parents=True, exist_ok=True)

    reports, search_ms = [], []
    for run in range(1, args.runs + 1):
        raw_pages = []
        for page in range(1, args.pages + 1):
            raw, sec = run_search(tag_keyword=args.tag_keyword, countries=args.countries,
                                  page=page, pre_exhibition_ids=args.pre_exhibition_ids,
                                  features=args.features, categories=args.categories)
            search_ms.append(sec * 1000.0)
            raw_pages.append(raw)
            stem = f"{args.scenario}-r{run}-p{page}"
            if not args.no_raw:
                (target / f"{stem}.json").write_text(
                    json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            recs = ((raw.get("response") or {}).get("data") or {}).get("page", {}).get("records") or []
            norms = [normalize_record(r, page=page, position=i)
                     for i, r in enumerate(recs, start=1)]
            (target / f"{stem}-redacted.json").write_text(
                json.dumps(redact_for_fixture(norms), ensure_ascii=False, indent=1), encoding="utf-8")
        pages = to_fixture_pages(raw_pages)
        fixture = {"meta": {"name": f"{args.scenario}-live", "kind": "live",
                            "target_exhibition_ids": [t for t in args.pre_exhibition_ids.split(",") if t]},
                   "pages": pages}
        diag = JobDiagnostics(f"live-{args.scenario}-r{run}", args.tenant, "", dry_run=True)
        for sec in search_ms[-(args.pages):]:
            diag.record_stage("search", sec)
        rep = replay(fixture, deliver_limit=args.deliver_limit,
                     target_exhibition_ids=fixture["meta"]["target_exhibition_ids"],
                     diag=diag, fixture_path=f"{args.scenario}-r{run}")
        # 候选诊断（脱敏）：全部候选 + 剔除原因 + 是否交付
        ex_keys = {(e.get("page"), e.get("position")) for e in rep["v2"].get("excluded") or []}
        dl_keys = {(n.get("page"), n.get("position")) for n in rep["v2"].get("delivered") or []}
        for pg, pos, rec in [(p.get("page"), i, r) for p in pages for i, r in enumerate(p.get("records") or [], 1)]:
            if (pg, pos) in ex_keys:
                continue
            nn = normalize_record(rec, page=pg, position=pos)
            diag.add_candidate(nn.get("company", ""), page=pg, position=pos, score=nn.get("score"),
                               qualified=True, excluded_reason="", delivered=(pg, pos) in dl_keys)
        for e in rep["v2"].get("excluded") or []:
            diag.add_candidate(e.get("company", ""), page=e.get("page"), position=e.get("position"),
                               score=e.get("score"), qualified=False,
                               excluded_reason=e.get("excluded_reason", ""), delivered=False)
        s = diag.summary()
        rep["stages_ms"] = {k: v.get("last_ms") for k, v in s["stages"].items()}
        rep["per_page_scores"] = s["candidates"]["per_page"]
        reports.append(rep)
        (target / f"report-{args.scenario}-r{run}.json").write_text(
            json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")

    md = "\n\n".join(render_markdown(r) for r in reports)
    (target / f"summary-{args.scenario}.md").write_text(md, encoding="utf-8")
    print(md)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
