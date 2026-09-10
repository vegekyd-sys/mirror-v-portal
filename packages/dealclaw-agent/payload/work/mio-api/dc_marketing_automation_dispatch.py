#!/usr/bin/env python3
"""
dc_marketing_automation_dispatch.py — 展会自动营销执行桥接（消费 active automations）

把 automations.json 里的 active 记录路由成可执行动作，复用已有发送 Skill：
  - first_invite / second_invite / onsite_followup / missed_meeting_reengage
      → 生成 pending 草稿（复用 dc_reply_draft.record_draft），正文由模型生成后确认发送。
  - nurture → 静默完成（complete_automation），不发邮件，只进培育池状态。

职责边界（对齐 spec 约束 4/5）：
  - 本层只决定「发给谁、走哪个通道、要不要审批、幂等键」。
  - 邮件正文是模型职责：本层生成草稿时只填 subject 骨架 + 元数据，text 留空，
    由 agent 轮（模型）读草稿后生成正文 → confirm_and_send 发送。
  - 不重造发送逻辑：发送复用 dc_email_send / dc_pending_send / dc_reply_draft.confirm_and_send。

nurture 语义：多轮无回复 → 长期培育，静默（不发送、不打扰用户），只落状态。
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from dc_marketing_automation import (
    load_automations,
    complete_automation,
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

# 各动作默认 subject 骨架（正文由模型生成）
ACTION_SUBJECT = {
    FIRST_INVITE: "Invitation to meet at {exhibition}",
    SECOND_INVITE: "Re: invitation — come visit our booth at {exhibition}",
    ONSITE_FOLLOWUP: "Great meeting you at {exhibition}",
    MISSED_MEETING_REENGAGE: "Let's connect at {exhibition}",
}

# 发送类动作（需要生成草稿）
SEND_ACTIONS = (FIRST_INVITE, SECOND_INVITE, ONSITE_FOLLOWUP, MISSED_MEETING_REENGAGE)

# 内容生成路由：dispatch 只路由，正文由对应 skill 生成（本层不产正文）。
# 注：邀约 skill 的「选模板」是展示用途，本层不做自动匹配（田耕郡 2026-09-11 定）。
CONTENT_ROUTE = {
    FIRST_INVITE: "dealclaw-exhibition-invitation",
    SECOND_INVITE: "dealclaw-exhibition-invitation",
    ONSITE_FOLLOWUP: "dealclaw-email-growth-send",
    MISSED_MEETING_REENGAGE: "dealclaw-email-growth-send",
}

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")


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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _extract_emails(text) -> list:
    """从联系人文本提取邮箱（兼容 str/list）。"""
    if isinstance(text, list):
        text = " ".join(str(x) for x in text)
    return sorted(set(EMAIL_RE.findall(str(text or ""))))


def _lead_emails(lead: dict) -> list:
    """从 lead 的 contact / 联系人 字段提取邮箱。"""
    return _extract_emails(lead.get("contact") or lead.get("联系人") or "")


# ─────────────────────────────────────────────────────────────
# 1. 回查买家邮箱（automation 只存引用，不回存邮箱）
# ─────────────────────────────────────────────────────────────

def _resolve_buyer_email(automation: dict, leads_by_id: dict, invitations_by_cdp: dict) -> str:
    """按优先级回查买家邮箱：invitation.contact.email > leads 联系人 > 空。"""
    cid = (automation.get("customer_id") or "").strip()
    # 1. invitation 记录里的 contact.email（展商自邀时解锁的联系人）
    inv = invitations_by_cdp.get(cid)
    if inv:
        contact = inv.get("contact") or {}
        if isinstance(contact, dict) and contact.get("email"):
            return contact["email"].strip()
    # 2. leads.json 联系人字段里的邮箱
    lead = leads_by_id.get(cid)
    if lead:
        emails = _lead_emails(lead)
        if emails:
            return emails[0]
    return ""


# ─────────────────────────────────────────────────────────────
# 2. 生成待发送草稿（复用 dc_reply_draft）
# ─────────────────────────────────────────────────────────────

def _build_draft(company_id: str, automation: dict, buyer_email: str, company_name: str,
                 exhibition_name: str) -> dict:
    """从 automation 构建 pending 草稿（正文留空，模型后填）。"""
    action = automation.get("action", "")
    subject_tpl = ACTION_SUBJECT.get(action, "Follow-up")
    subject = subject_tpl.format(exhibition=exhibition_name or "our exhibition")

    # draft_id 幂等：由 automation 的 idempotency_key 派生，避免重复生成
    import hashlib
    draft_id = "am_" + hashlib.sha1(
        (automation.get("idempotency_key") or "").encode("utf-8")
    ).hexdigest()[:16]

    return {
        "draft_id": draft_id,
        "company_id": company_id,
        "campaign_id": "",
        "lead_id": automation.get("customer_id", ""),
        "contact_id": "",
        "account_id": "",
        "buyer_email": buyer_email,
        "related_reply_id": "",
        "subject": subject,
        "text": "",                        # 正文由模型生成
        "missing_fields": [],
        "status": "pending_confirmation",
        "created_at": _now(),
        "expires_at": "",
        "updated_at": _now(),
        "message_id": "",
        "sent_at": "",
        "failure_reason": "",
        "next_action": "",
        "attempts": 0,
        "touch_number": 0,
        # automation 元数据（供 agent 轮理解上下文，不回存正文）
        "automation_action": action,
        "automation_id": automation.get("automation_id", ""),
        "automation_idempotency_key": automation.get("idempotency_key", ""),
        "automation_requires_approval": automation.get("requires_approval", True),
        "content_route": CONTENT_ROUTE.get(action, ""),
        "company_name": company_name,
        "exhibition_name": exhibition_name,
    }


# ─────────────────────────────────────────────────────────────
# 3. 主入口：dispatch
# ─────────────────────────────────────────────────────────────

def dispatch_pending(
    company_id: str,
    *,
    workspace_root: Optional[str] = None,
    now: Optional[str] = None,
    dry_run: bool = True,
) -> dict:
    """消费 active automations，路由到执行动作。

    - nurture → complete_automation（静默，转培育池）
    - 发送类 → 生成 pending 草稿（复用 dc_reply_draft.record_draft），正文留待模型

    返回脱敏摘要。dry_run=True 时不落草稿、不 complete。
    """
    from dc_email_controller.dc_reply_draft import record_draft

    automation_state = load_automations(company_id, workspace_root)
    actives = [a for a in automation_state.get("automations", [])
               if isinstance(a, dict) and a.get("status") == "active"]

    leads = _read_json(company_id, "leads.json", [], workspace_root)
    inv_data = _read_json(company_id, "exhibition-invitations.json", {}, workspace_root)
    invitations = inv_data.get("invitations", []) if isinstance(inv_data, dict) else []

    leads_by_id = {}
    for l in leads:
        if not isinstance(l, dict):
            continue
        cdp = (l.get("company_cdp_id") or "").strip()
        if cdp:
            leads_by_id.setdefault(cdp, l)
        # 无 cdp 时用 company+website hash 兜底（与 runner 同口径）
        if not cdp:
            import hashlib
            base = f"{(l.get('company') or '').strip().lower()}|{(l.get('website') or '').strip().lower()}"
            leads_by_id.setdefault("c_" + hashlib.sha1(base.encode("utf-8")).hexdigest()[:16], l)

    invitations_by_cdp = {}
    for inv in invitations:
        if isinstance(inv, dict) and inv.get("companyCdpId"):
            invitations_by_cdp.setdefault(inv["companyCdpId"].strip(), inv)

    results = []
    for a in actives:
        action = a.get("action", "")
        entry = {
            "automation_id": a.get("automation_id", ""),
            "action": action,
            "action_label": ACTION_LABELS.get(action, action),
            "customer_id": a.get("customer_id", ""),
            "company_name": "",
            "disposition": "",
            "buyer_email": "",
            "draft_id": "",
            "content_route": CONTENT_ROUTE.get(action, ""),
        }

        if action == NURTURE:
            # 静默完成，转培育池
            entry["disposition"] = "nurture_completed"
            if not dry_run:
                complete_automation(company_id, a.get("automation_id", ""),
                                    status="completed", execution_ref="nurture_pool",
                                    workspace_root=workspace_root)
            results.append(entry)
            continue

        if action not in SEND_ACTIONS:
            entry["disposition"] = "unknown_action_skipped"
            results.append(entry)
            continue

        # 回查买家邮箱
        buyer_email = _resolve_buyer_email(a, leads_by_id, invitations_by_cdp)
        lead = leads_by_id.get(a.get("customer_id", "")) or {}
        company_name = lead.get("company", "") or ""
        exhibition_name = (invitations_by_cdp.get(a.get("customer_id", "")) or {}).get("exhibitionName", "")

        entry["company_name"] = company_name
        entry["buyer_email"] = buyer_email

        if not buyer_email:
            entry["disposition"] = "no_email_skipped"
            results.append(entry)
            continue

        draft = _build_draft(company_id, a, buyer_email, company_name, exhibition_name)
        entry["draft_id"] = draft["draft_id"]

        if dry_run:
            entry["disposition"] = "draft_pending_dry_run"
        else:
            written = record_draft(draft)
            entry["disposition"] = "draft_created" if written else "draft_duplicate"
        results.append(entry)

    summary = {
        "company_id": company_id,
        "dry_run": dry_run,
        "now": now or _now(),
        "active_processed": len(actives),
        "by_disposition": {},
        "results": results,
    }
    for r in results:
        d = r["disposition"]
        summary["by_disposition"][d] = summary["by_disposition"].get(d, 0) + 1
    return summary


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

def _cli() -> int:
    ap = argparse.ArgumentParser(description="展会自动营销执行桥接（消费 active automations）")
    ap.add_argument("--company-id", required=True, help="企业 ID（supplier_id）")
    ap.add_argument("--workspace-root", default="", help="workspace 根（缺省 OPENCLAW_WORKSPACE_DIR 或 parents[2]）")
    ap.add_argument("--no-dry-run", action="store_true", help="真正落草稿/complete（默认 dry_run）")
    args = ap.parse_args()

    result = dispatch_pending(
        args.company_id,
        workspace_root=args.workspace_root or None,
        dry_run=not args.no_dry_run,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
