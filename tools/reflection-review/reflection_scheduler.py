#!/usr/bin/env python3
"""reflection_scheduler.py — 仅测试母体运行的每日候选调度（不自动改系统）

安全约束（对应需求 4-11）：
  4. 业务时区取自 knight.config.json（timezone），运行时间默认 21:30，可配置。
  5. 仅当 environment == "test_mother" **且** 显式 enabled=true 才运行。
  6. source hash / cursor 增量扫描 + 单实例锁。
  7. 同类候选合并（保留 source_refs）。
  8. 只生成 pending 候选 + 内部审核摘要；无新增静默；失败不影响主流程（exit 0）。
  9. 禁止自动改代码/Skill/知识/commit/push/构建 payload。
 10. 输出只写 data/reflection-review（不进 Git / payload）。

用法：
  python3 reflection_scheduler.py --workspace <runtime> [--dry-run] [--force]
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
CLASSES = ("bug", "skill_improvement", "industry_knowledge", "tenant_only", "ignore")


def _load_review():
    spec = importlib.util.spec_from_file_location("review_reflections", HERE / "review-reflections.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_config(workspace: Path) -> dict:
    p = workspace / "knight.config.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _merge_same_class(cands: list[dict]) -> list[dict]:
    """同类候选合并（classification + 归一 summary），保留 source_refs。"""
    merged: dict[tuple, dict] = {}
    for c in cands:
        key = (c["classification"], c["summary"].strip().lower())
        if key in merged:
            refs = merged[key].setdefault("source_refs", [])
            if c.get("source_ref") and c["source_ref"] not in refs:
                refs.append(c["source_ref"])
        else:
            c = dict(c)
            c["source_refs"] = [c.get("source_ref")] if c.get("source_ref") else []
            merged[key] = c
    return list(merged.values())


def main() -> int:
    ap = argparse.ArgumentParser(description="仅测试母体的每日候选调度（只出候选）")
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--dry-run", action="store_true", help="只演示，不写盘")
    ap.add_argument("--force", action="store_true", help="忽略 enabled/时间窗口（手动冒烟用）")
    args = ap.parse_args()

    ws = Path(args.workspace).expanduser()
    cfg = load_config(ws)
    rr = cfg.get("reflection_review", {}) or {}
    tzname = cfg.get("timezone") or "Asia/Shanghai"
    tz = ZoneInfo(tzname)
    out_dir = ws / "data" / "reflection-review"
    try:
        # 5. gate：仅测试母体 + 显式 enabled
        if not args.force and (rr.get("environment") != "test_mother" or not rr.get("enabled")):
            print("[scheduler] skip：非 test_mother 或未 enabled")
            return 0
        # 4. 业务时区时间窗口
        now = datetime.now(tz)
        target = str(rr.get("time") or "21:30")
        hh, mm = (target.split(":") + ["0"])[:2]
        delta = abs((now.hour * 60 + now.minute) - (int(hh) * 60 + int(mm)))
        if not args.force and delta > 15:
            print(f"[scheduler] skip：当前 {now:%H:%M} 不在 {target}±15min 窗口")
            return 0
        out_dir.mkdir(parents=True, exist_ok=True)
        # 6. 单实例锁
        lock = open(out_dir / ".lock", "a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("[scheduler] skip：已有实例在运行")
            return 0

        # 6. 增量：cursor（source_ref -> hash）
        cursor_path = out_dir / "cursor.json"
        cursor = json.loads(cursor_path.read_text(encoding="utf-8")) if cursor_path.exists() else {}

        rev = _load_review()
        all_c = rev.build_candidates(ws)
        fresh = []
        for c in all_c:
            ref = c.get("source_ref", "")
            h = _hash(json.dumps(c, ensure_ascii=False, sort_keys=True))
            if cursor.get(ref) != h:
                cursor[ref] = h
                fresh.append(c)

        # 7. 同类合并
        merged = _merge_same_class(fresh)
        counts = {k: sum(1 for x in merged if x["classification"] == k) for k in CLASSES}

        # 8. 无新增静默
        if not fresh:
            print("[scheduler] 无新增，静默")
            return 0

        today = now.strftime("%Y-%m-%d")
        body = {"generated_at": datetime.now(timezone.utc).isoformat(),
                "environment": rr.get("environment", ""), "timezone": tzname,
                "scanned": len(all_c), "fresh": len(fresh), "counts": counts,
                "candidates": merged}
        if args.dry_run:
            print(f"[scheduler][dry-run] 扫描 {len(all_c)} / 新增 {len(fresh)} / 分类 {counts}")
            return 0
        # 10. 只写 data/reflection-review
        (out_dir / "candidates").mkdir(parents=True, exist_ok=True)
        (out_dir / "candidates" / f"candidates-{today}.json").write_text(
            json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
        lines = [f"# Reflection 每日候选（pending）· {today}", "",
                 f"> env={rr.get('environment')} · 扫描 {len(all_c)} · 新增 {len(fresh)} · 分类 {counts}",
                 "> **只生成 pending 候选，不自动修改任何系统内容。**", ""]
        for k in CLASSES:
            g = [x for x in merged if x["classification"] == k]
            lines.append(f"## {k}（{len(g)}）")
            for x in g:
                lines.append(f"- {x['summary']}｜refs={x.get('source_refs', [])}")
            lines.append("")
        (out_dir / "candidates" / f"candidates-{today}.md").write_text("\n".join(lines) + "\n",
                                                                      encoding="utf-8")
        cursor_path.write_text(json.dumps(cursor, ensure_ascii=False, indent=2), encoding="utf-8")
        nxt = f"{target} {tzname}"
        print(f"[scheduler] 完成：扫描 {len(all_c)} / 新增 {len(fresh)} / 分类 {counts} / 下次 {nxt}")
        return 0
    except Exception as e:  # noqa: BLE001 — 8. 失败不影响主流程
        print(f"[scheduler] 失败但不影响主流程：{type(e).__name__}: {e}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
