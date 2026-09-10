#!/usr/bin/env python3
"""
dc_marketing_automation_runner.py — 展会自动营销编排层（轻量调度入口）

把 dc_marketing_automation.evaluate_next_action()（纯函数决策）接到实际任务生成：
  扫描 memory → 组装每个 opportunity 的输入 → 逐个决策 → 需要动作的落 automations.json。

职责边界（对齐 spec 约束 5/8）：
  - 本层只「新增任务」（写 automations.json 的 active 记录 + 产出待办清单），
    不发送邮件/WhatsApp；动作执行复用已有 Skill（邀约/邮件/followup）。
  - 无 cron/lease/重试队列。外部轻量 cron 调 run_cycle() 即可驱动。

数据源（复用现有 memory，只读）：
  - leads.json           customer + opportunity 视图（company/company_cdp_id/contact_policy/
                         opportunity_status/stage/match_grade/reply_count）
  - email_followup.json  触达轮数 touch_number / inbound_count（无邀约记录时的 nurture 依据）
  - exhibition-invitations.json  邀约名单（companyCdpId → 是否邀约过 + sendTime）
  - interactions.json    沟通明细（按 customer_id 分组）
  - meta.json            exhibition_stage（首邀/二次邀约/到场跟进的阶段门）
  - automations.json     频控 + 单活跃互斥（load/activate）

invitation 的到场状态（isCheckIn/isMeeting/inviationState）来自 getInvitationByPage 接口，
由调用方通过 invitation_statuses 注入（见 assemble_opportunities）；缺省时不做到场判定，
已邀约买家走「未到场」分支（second_invite）。
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from dc_marketing_automation import (
    evaluate_next_action,
    load_automations,
    activate_automation,
    NONE,
    FIRST_INVITE,
    SECOND_INVITE,
    ONSITE_FOLLOWUP,
    MISSED_MEETING_REENGAGE,
    NURTURE,
)

ACTION_LABELS = {
    FIRST_INVITE: "首邀",
    SECOND_INVITE: "二次邀约",
    ONSITE_FOLLOWUP: "到场跟进",
    MISSED_MEETING_REENGAGE: "到场再触达",
    NURTURE: "长期培育",
}


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _memory_path(company_id: str, name: str, workspace_root: Optional[str] = None) -> Path:
    root = Path(workspace_root) if workspace_root else _workspace_root()
    return root / "data" / "memory" / str(company_id) / name


def _read_json(company_id: str, name: str, default, workspace_root: Optional[str] = None):
    p = _memory_path(company_id, name, workspace_root)
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _read_leads(company_id: str, workspace_root: Optional[str] = None) -> list:
    return _read_json(company_id, "leads.json", [], workspace_root)


def _read_email_followup(company_id: str, workspace_root: Optional[str] = None) -> list:
    return _read_json(company_id, "email_followup.json", [], workspace_root)


def _read_interactions(company_id: str, workspace_root: Optional[str] = None) -> list:
    return _read_json(company_id, "interactions.json", [], workspace_root)


def _read_invitations(company_id: str, workspace_root: Optional[str] = None) -> list:
    data = _read_json(company_id, "exhibition-invitations.json", {}, workspace_root)
    if isinstance(data, dict):
        return data.get("invitations", [])
    return []


def _read_meta(company_id: str, workspace_root: Optional[str] = None) -> dict:
    return _read_json(company_id, "meta.json", {}, workspace_root)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────
# 1. 组装：把 memory 拼成 evaluate_next_action 的输入
# ─────────────────────────────────────────────────────────────

def _customer_id_of(lead: dict) -> str:
    """与 dc_memory_data._customer_id 同口径：优先 cdp，否则 hash(company+website)。"""
    import hashlib
    cdp = (lead.get("company_cdp_id") or "").strip()
    if cdp:
        return cdp
    base = f"{(lead.get('company') or '').strip().lower()}|{(lead.get('website') or '').strip().lower()}"
    return "c_" + hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def assemble_opportunities(
    company_id: str,
    *,
    workspace_root: Optional[str] = None,
    invitation_statuses: Optional[list] = None,
) -> list:
    """从 memory 组装所有 opportunity 的决策输入。

    invitation_statuses: list[dict]，来自 getInvitationByPage，含
      companyCdpId / isCheckIn / isMeeting / inviationState / isConnect，
      用于补齐邀请记录的到场/商洽状态。缺省 None → 不补状态。

    返回 list，每项 = {customer, opportunity, invitation, interactions, meta, automation_state}。
    """
    leads = _read_leads(company_id, workspace_root)
    followup = _read_email_followup(company_id, workspace_root)
    interactions = _read_interactions(company_id, workspace_root)
    invitations = _read_invitations(company_id, workspace_root)
    meta = _read_meta(company_id, workspace_root)
    automation_state = load_automations(company_id, workspace_root)

    # 索引
    followup_by_cdp = {}
    for f in followup:
        cdp = (f.get("company_cdp_id") or "").strip()
        if cdp:
            followup_by_cdp.setdefault(cdp, f)
    followup_by_name = {}
    for f in followup:
        name = (f.get("company") or "").strip().lower()
        if name:
            followup_by_name.setdefault(name, f)

    inv_by_cdp = {}
    for inv in invitations:
        cdp = (inv.get("companyCdpId") or "").strip()
        if cdp:
            inv_by_cdp.setdefault(cdp, inv)

    status_by_cdp = {}
    for s in (invitation_statuses or []):
        if not isinstance(s, dict):
            continue
        cdp = (s.get("companyCdpId") or "").strip()
        if cdp:
            status_by_cdp.setdefault(cdp, s)

    its_by_customer = {}
    for it in interactions:
        if not isinstance(it, dict):
            continue
        cid = (it.get("customer_id") or "").strip()
        if cid:
            its_by_customer.setdefault(cid, []).append(it)

    out = []
    for lead in leads:
        if not isinstance(lead, dict):
            continue
        cid = _customer_id_of(lead)
        name = (lead.get("company") or "").strip().lower()

        customer = {
            "companyCdpId": (lead.get("company_cdp_id") or "").strip(),
            "companyName": (lead.get("company") or "").strip(),
            "contact_policy": (lead.get("contact_policy") or "active"),
            "has_reply": int(lead.get("reply_count") or 0) > 0,
            "touch_number": int(lead.get("touch_number") or 0),
        }
        # 触达轮数：leads 无则从 email_followup 补齐
        fw = followup_by_cdp.get(cid) or followup_by_name.get(name)
        if fw:
            if not customer["touch_number"]:
                customer["touch_number"] = int(fw.get("touch_number") or 0)
            if not customer["has_reply"] and int(fw.get("inbound_count") or 0) > 0:
                customer["has_reply"] = True

        opportunity = {
            "opportunity_id": cid,
            "opportunity_status": (lead.get("opportunity_status") or "active"),
            "stage": (lead.get("stage") or ""),
            "match_grade": (lead.get("match_grade") or ""),
        }

        # 邀请记录：本地名单 + 接口到场状态合并
        invitation = None
        inv = inv_by_cdp.get((lead.get("company_cdp_id") or "").strip())
        if inv:
            invitation = dict(inv)
        st = status_by_cdp.get((lead.get("company_cdp_id") or "").strip())
        if st:
            if invitation is None:
                invitation = {}
            for k in ("isCheckIn", "isMeeting", "inviationState", "isConnect", "exhibitionId"):
                if k in st and not invitation.get(k):
                    invitation[k] = st[k]

        out.append({
            "customer": customer,
            "opportunity": opportunity,
            "invitation": invitation,
            "interactions": its_by_customer.get(cid, []),
            "meta": meta,
            "automation_state": automation_state,
        })
    return out


# ─────────────────────────────────────────────────────────────
# 2. 编排：决策 + 落库
# ─────────────────────────────────────────────────────────────

def run_cycle(
    company_id: str,
    *,
    workspace_root: Optional[str] = None,
    now: Optional[str] = None,
    dry_run: bool = True,
    invitation_statuses: Optional[list] = None,
) -> dict:
    """扫描 + 决策 + 落 automations.json。返回脱敏摘要。

    - 对每个 opportunity 调 evaluate_next_action
    - action != none 的：dry_run=False 时 activate 到 automations.json（store 层强制单活跃）
    - requires_approval 的动作照常激活（status=active），由下游 Skill 按 requires_approval 决定是否等确认
    """
    inputs = assemble_opportunities(company_id, workspace_root=workspace_root,
                                    invitation_statuses=invitation_statuses)
    now = now or _now()

    tasks: list = []
    skipped_active = 0
    excluded = 0

    for inp in inputs:
        r = evaluate_next_action(
            customer=inp["customer"],
            opportunity=inp["opportunity"],
            invitation=inp["invitation"],
            interactions=inp["interactions"],
            meta=inp["meta"],
            automation_state=inp["automation_state"],
            now=now,
        )
        action = r["action"]
        if action == NONE:
            if r.get("excluded_reason"):
                excluded += 1
            elif "active automation" in r.get("reason", ""):
                skipped_active += 1
            continue

        task = {
            "action": action,
            "action_label": ACTION_LABELS.get(action, action),
            "opportunity_id": inp["opportunity"].get("opportunity_id", ""),
            "customer_id": inp["customer"].get("companyCdpId", ""),
            "company_name": inp["customer"].get("companyName", ""),
            "reason": r["reason"],
            "due_at": r["due_at"],
            "requires_approval": r["requires_approval"],
            "idempotency_key": r["idempotency_key"],
        }
        if not dry_run:
            act = activate_automation(company_id, {
                "opportunity_id": task["opportunity_id"],
                "customer_id": task["customer_id"],
                "exhibition_id": (inp["invitation"] or {}).get("exhibitionId", ""),
                "action": action,
                "idempotency_key": task["idempotency_key"],
                "due_at": task["due_at"],
                "requires_approval": task["requires_approval"],
                "evidence_refs": r.get("evidence_refs", []),
                "reason": task["reason"],
            }, workspace_root=workspace_root)
            task["automation_id"] = act.get("record", {}).get("automation_id", "")
            task["activated"] = act.get("ok", False)
        tasks.append(task)

    # 摘要
    summary = {
        "company_id": company_id,
        "dry_run": dry_run,
        "now": now,
        "scanned": len(inputs),
        "tasks_created": len(tasks),
        "skipped_active": skipped_active,
        "excluded": excluded,
        "by_action": {a: sum(1 for t in tasks if t["action"] == a) for a in ACTION_LABELS},
        "tasks": tasks,
    }
    return summary


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

def _cli() -> int:
    ap = argparse.ArgumentParser(description="展会自动营销编排（扫描→决策→落库）")
    ap.add_argument("--company-id", required=True, help="企业 ID（supplier_id）")
    ap.add_argument("--workspace-root", default="", help="workspace 根（缺省 OPENCLAW_WORKSPACE_DIR 或自身 parents[2]）")
    ap.add_argument("--no-dry-run", action="store_true", help="真正落 automations.json（默认 dry_run）")
    ap.add_argument("--invitation-statuses", default="", help="getInvitationByPage 到场状态 JSON 数组（可选）")
    args = ap.parse_args()

    statuses = json.loads(args.invitation_statuses) if args.invitation_statuses else None
    result = run_cycle(
        args.company_id,
        workspace_root=args.workspace_root or None,
        dry_run=not args.no_dry_run,
        invitation_statuses=statuses,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
