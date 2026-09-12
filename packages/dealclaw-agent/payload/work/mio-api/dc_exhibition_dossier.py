#!/usr/bin/env python3
"""
dc_exhibition_dossier.py — 展会「一客一案」生成（复用 memory 现有记录）

目标：展会场景下，用户能**一目了然查询已跟进的买家**：
  ① 买家一览（index）：一张表看清 公司/国家/类型/匹配/阶段/优先级/邀约/最近联系/互动数/下次动作
  ② 单客档案：复用 `dc_dossier.build_dossier_content`，补展会字段（邀约/到场）

数据源（唯一，不新建）：`data/memory/<enterprise_id>/`，统一走 `dc_memory_data` 读。
  leads.json / interactions.json / email_followup.json / exhibition-invitations.json

设计原则：
  - **不新建数据源**：能读 memory 里的就不另存；档案是「可再生阅读层」。
  - 无数据不报错：字段缺就留空，互动为 0 就写「暂无互动记录」。
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Optional


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _memory_dir(company_id: str, workspace_root: Optional[str] = None) -> Path:
    root = Path(workspace_root) if workspace_root else _workspace_root()
    return root / "data" / "memory" / str(company_id)


def _read_json(company_id: str, name: str, default, workspace_root: Optional[str] = None):
    p = _memory_dir(company_id, workspace_root) / name
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


# ─────────────────────────────────────────────────────────────
# 1. 组装（全部复用 memory 现有记录）
# ─────────────────────────────────────────────────────────────

def _customer_key(lead: dict) -> str:
    """与 dc_memory_data._customer_id 同口径：cdp 优先，否则 hash(company+website)。"""
    import hashlib
    cdp = (lead.get("company_cdp_id") or "").strip()
    if cdp:
        return cdp
    base = f"{(lead.get('company') or '').strip().lower()}|{(lead.get('website') or '').strip().lower()}"
    return "c_" + hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def load_buyers(company_id: str, *, workspace_root: Optional[str] = None) -> list:
    """读 memory → 每个买家一条聚合视图（lead + 互动 + 邀约）。"""
    leads = _read_json(company_id, "leads.json", [], workspace_root)
    interactions = _read_json(company_id, "interactions.json", [], workspace_root)
    invitations = _read_json(company_id, "exhibition-invitations.json", {}, workspace_root)
    invitations = invitations.get("invitations", []) if isinstance(invitations, dict) else []

    its_by_customer: dict = {}
    for it in interactions:
        if not isinstance(it, dict):
            continue
        cid = (it.get("customer_id") or "").strip()
        if cid:
            its_by_customer.setdefault(cid, []).append(it)

    inv_by_cdp = {}
    for inv in invitations:
        if isinstance(inv, dict) and inv.get("companyCdpId"):
            inv_by_cdp.setdefault(str(inv["companyCdpId"]).strip(), inv)

    out = []
    for lead in leads:
        if not isinstance(lead, dict):
            continue
        cid = _customer_key(lead)
        cdp = (lead.get("company_cdp_id") or "").strip()
        inv = inv_by_cdp.get(cdp) if cdp else None
        its = its_by_customer.get(cid, [])
        last = ""
        for it in its:
            t = str(it.get("occurred_at") or "")
            if t > last:
                last = t
        out.append({
            "key": cid,
            "lead": lead,
            "interactions": its,
            "invitation": inv,
            "last_interaction_at": last,
        })
    return out


# ─────────────────────────────────────────────────────────────
# 2. 一览表（一目了然）
# ─────────────────────────────────────────────────────────────

def _cell(v, dash: str = "—") -> str:
    s = str(v or "").strip()
    return s.replace("|", "/") if s else dash


def build_index_markdown(buyers: list, *, title: str = "展会买家一览") -> str:
    """买家一览表：一行一客，关键字段齐。"""
    n = len(buyers)
    lines = [f"# {title}", "", f"共 **{n}** 家"]
    if not buyers:
        lines += ["", "（暂无买家记录）"]
        return "\n".join(lines)

    lines += ["", "| 公司 | 国家 | 类型 | 匹配 | 阶段 | 优先级 | 邀约 | 互动 | 最近联系 | 下次动作 |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    for b in sorted(buyers, key=lambda x: (x["lead"].get("company") or "")):
        L, inv = b["lead"], b["invitation"]
        invite = "已邀约" if inv else "未邀约"
        lines.append("| " + " | ".join([
            _cell(L.get("company")),
            _cell(L.get("country")),
            _cell(L.get("buyer_type")),
            _cell(L.get("match_grade")),
            _cell(L.get("stage")),
            _cell(L.get("followup_priority")),
            invite,
            str(len(b["interactions"])),
            _cell((b["last_interaction_at"] or L.get("last_contact_at") or "")[:10]),
            _cell(L.get("next_action")),
        ]) + " |")
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────
# 3. 单客档案（复用 dc_dossier 生成层）
# ─────────────────────────────────────────────────────────────

def build_buyer_markdown(buyer: dict) -> str:
    """单客档案：复用 dc_dossier.build_dossier_content + 展会补充（邀约）。"""
    from dc_dossier import build_dossier_content

    lead = buyer.get("lead") or {}
    content = build_dossier_content(lead, buyer.get("interactions") or [])
    inv = buyer.get("invitation")
    if inv:
        extra = ["", "**展会邀约**", f"已邀约（{_cell(inv.get('exhibitionName'))}）"]
        if inv.get("sendTime"):
            extra.append(f"邀约时间：{str(inv.get('sendTime'))[:10]}")
        content = content + "\n" + "\n".join(extra)
    return content


def build_report_markdown(company_id: str, *, workspace_root: Optional[str] = None,
                          title: str = "展会买家跟进档案") -> str:
    """完整报告：一览表 + 每客一案。"""
    buyers = load_buyers(company_id, workspace_root=workspace_root)
    parts = [build_index_markdown(buyers, title=f"{title} · 一览")]
    for b in sorted(buyers, key=lambda x: (x["lead"].get("company") or "")):
        parts.append("\n---\n")
        parts.append(build_buyer_markdown(b))
    return "\n".join(parts)


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

def _cli() -> int:
    ap = argparse.ArgumentParser(description="展会一客一案（复用 memory 记录）")
    ap.add_argument("--company-id", required=True)
    ap.add_argument("--workspace-root", default="")
    ap.add_argument("--mode", default="all", choices=["index", "all"],
                    help="index=只出一览表；all=一览 + 每客档案")
    args = ap.parse_args()

    buyers = load_buyers(args.company_id, workspace_root=args.workspace_root or None)
    if args.mode == "index":
        print(build_index_markdown(buyers))
    else:
        print(build_report_markdown(args.company_id, workspace_root=args.workspace_root or None))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
