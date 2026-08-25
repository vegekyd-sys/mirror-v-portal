#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dc_exhibition_stage.py — 展会阶段状态（exhibition_stage）单一真相。

阶段：profiling(画像) → planning(获客方案·核心) → inviting(邀约) → live(展中) → followup(展后)。
状态存 data/memory/<supplier_id>/meta.json：exhibition_stage / understanding_done / plan_done。

写方：
  - agent（对话推进，直接写）
  - exhibition_assistant.py stage 子命令（调 set_stage）
  - 脚本兜底日期推进（reconcile_stage）
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

STAGE_LABELS = {
    "profiling": "画像（锁定第一推荐产品）",
    "planning": "制定获客方案",
    "inviting": "邀约中",
    "live": "展中对接",
    "followup": "展后跟进",
}
STAGES = tuple(STAGE_LABELS)


def stage_next_step(stage: str, *, invited: int = 0, rec: int = 0, days: int = 30) -> str:
    """按阶段给「下一步」动作（价值口径，非步骤名）。"""
    if stage == "profiling":
        return "锁定「第一推荐产品」：结合展会国判断哪个产品最有优势，深度吃透后再出方案"
    if stage == "planning":
        return "产出获客方案：买家类型 + 邀约方向 + 沟通策略（围绕第一推荐产品）"
    if stage == "inviting":
        if rec <= 0:
            return "持续推进邀约，跟进确认到展"
        remaining = max(rec - invited, 0)
        if remaining > 0:
            daily = max(1, round(remaining / max(days, 1)))
            return f"邀约进度 {invited}/{rec}，还差 {remaining} 家，今天建议邀约 {daily} 家"
        return f"邀约已达成 {invited}/{rec}，转入跟进确认到展"
    return ""


def meta_path(supplier_id: str) -> Path:
    return Path(__file__).resolve().parents[2] / "data" / "memory" / str(supplier_id) / "meta.json"


def read_meta(supplier_id: str) -> dict:
    p = meta_path(supplier_id)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def read_stage(supplier_id: str) -> dict:
    meta = read_meta(supplier_id)
    stage = meta.get("exhibition_stage") or "profiling"
    if stage not in STAGES:
        stage = "profiling"
    return {
        "stage": stage,
        "understanding_done": bool(meta.get("understanding_done")),
        "plan_done": bool(meta.get("plan_done")),
    }


def set_stage(supplier_id: str, stage: str, *, understanding_done=None, plan_done=None) -> dict:
    """写入阶段状态（原子写）。understanding_done/plan_done 传 None 表示不覆盖。"""
    if stage not in STAGES:
        return {"ok": False, "error": f"stage 必须是 {STAGES} 之一"}
    p = meta_path(supplier_id)
    meta = read_meta(supplier_id)
    meta["exhibition_stage"] = stage
    if understanding_done is not None:
        meta["understanding_done"] = bool(understanding_done)
    if plan_done is not None:
        meta["plan_done"] = bool(plan_done)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return {"ok": True, "stage": stage, "file": str(p)}


def reconcile_stage(supplier_id: str, today: str | None = None, *, write: bool = True) -> dict:
    """日期兜底推进：开展日到 → live，闭展日过 → followup。返回 {stage, changed}。"""
    meta = read_meta(supplier_id)
    stage = meta.get("exhibition_stage") or "profiling"
    if stage not in STAGES:
        stage = "profiling"
    today = today or date.today().isoformat()
    new_stage = stage
    for e in meta.get("exhibitions", []):
        start = str(e.get("start") or "")[:10]
        end = str(e.get("end") or e.get("start") or "")[:10]
        if start and stage in ("profiling", "planning", "inviting") and today >= start:
            new_stage = "live"
            break
        if end and stage == "live" and today > end:
            new_stage = "followup"
            break
    changed = new_stage != stage
    if changed and write:
        meta["exhibition_stage"] = new_stage
        p = meta_path(supplier_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(p)
    return {"stage": new_stage, "changed": changed}
