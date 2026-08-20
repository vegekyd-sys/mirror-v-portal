#!/usr/bin/env python3
"""
dc_followup.py — 多轮跟进调度（展会邮件增长闭环）

扫描 delivered + 未回复 + 未停止的 outbound，按 touch_number 自动进入跟进计划：
  touch 1 = 首次触达，touch 2 = 第二轮跟进，touch 3 = 第三轮跟进；超过第三轮暂停进入策略复盘。

跟进到期后生成：no_reply_due 信号 + 跟进草稿（pending_confirmation）+ 待确认列表。
草稿自动生成，但外部邮件必须等用户明确确认后才发送。

幂等键：company_id + campaign_id + lead_id + contact_id + touch_number（下一轮）。
停止条件：已回复 / 退信 / 投诉 / 退订 / 邮箱无效 / 达到第三轮。
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

FOLLOWUP_MAX_ROUNDS = 3
FOLLOWUP_DUE_DAYS = int(os.environ.get("DC_FOLLOWUP_DUE_DAYS", "2"))

# 停止跟进的 provider_status（退信/投诉/失败）
_STOP_STATUSES = {"bounced", "complained", "failed"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(s: str) -> str:
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()


def _followup_id(company_id: str, campaign_id: str, lead_id: str, contact_id: str,
                 touch_number: int) -> str:
    return _hash("|".join(["followup", company_id or "", campaign_id or "",
                           lead_id or "", contact_id or "", str(touch_number)]))


def _iso_add_days(iso: str, days: int) -> str:
    try:
        dt = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
        return (dt + timedelta(days=days)).isoformat()
    except (ValueError, OSError):
        return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def _parse_ts(ts) -> float | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except (ValueError, OSError):
        return None


def _has_reply(inbounds: list[dict], thread_id: str, contact_id: str, sent_at: str) -> bool:
    for ib in inbounds:
        if ib.get("binding_status") != "bound":
            continue
        if thread_id and ib.get("thread_id") == thread_id:
            return True
        if contact_id and ib.get("contact_id") == contact_id \
                and (ib.get("received_at") or "") >= (sent_at or ""):
            return True
    return False


def followup_text(touch_number: int, buyer_name: str = "", product: str = "our products") -> str:
    """跟进邮件正文（round 2/3）。"""
    name = f" {buyer_name}" if buyer_name else ""
    if touch_number <= 2:
        return (f"Hi{name}, just following up on my previous email about {product}. "
                f"Did you have a chance to review it? Happy to share pricing and samples.")
    return (f"Hi{name}, this is my last follow-up on {product}. "
            f"If you're interested, please let me know — I'd love to connect at the exhibition.")


def list_strategy_review_candidates(company_id: str) -> list[dict]:
    """到达第三轮仍无回复的 outbound（需策略复盘，不实时打扰用户）。"""
    from email_gateway.store import EmailStore
    store = EmailStore()
    outbounds = store.list_outbound_records(company_id=company_id)
    inbounds = store.list_inbound_records(company_id=company_id)
    result = []
    for ob in outbounds:
        if ob.get("provider_status") != "delivered":
            continue
        if int(ob.get("touch_number", 0) or 0) < FOLLOWUP_MAX_ROUNDS:
            continue
        thread_id = ob.get("thread_id") or ob.get("local_message_id", "")
        if _has_reply(inbounds, thread_id, ob.get("contact_id", ""),
                      ob.get("sent_at") or ob.get("created_at", "")):
            continue
        result.append({"resend_id": ob.get("resend_id", ""),
                       "buyer_email": (ob.get("recipients") or [""])[0],
                       "touch_number": ob.get("touch_number"),
                       "campaign_id": ob.get("campaign_id", "")})
    return result


def list_followup_candidates(company_id: str, at: str = None) -> list[dict]:
    """扫描 delivered + 未回复 + 未停止 + 到期的 outbound，返回跟进候选（含 next_touch）。"""
    from email_gateway.store import EmailStore
    from dc_ls_store import LeadStore
    store = EmailStore()
    ls = LeadStore()
    outbounds = store.list_outbound_records(company_id=company_id)
    inbounds = store.list_inbound_records(company_id=company_id)
    at_ts = _parse_ts(at) if at else datetime.now(timezone.utc).timestamp()

    candidates = []
    for ob in outbounds:
        if ob.get("provider_status") != "delivered":
            continue
        if ob.get("provider_status") in _STOP_STATUSES:
            continue
        buyer_email = (ob.get("recipients") or [""])[0]
        if ls.is_buyer_blocked(company_id, buyer_email):
            continue  # 买家已拒绝/排除 → 停止跟进
        touch = int(ob.get("touch_number", 0) or 0)
        next_touch = touch + 1
        if next_touch > FOLLOWUP_MAX_ROUNDS:
            continue  # 超过第三轮 → 停止（交给策略复盘）
        thread_id = ob.get("thread_id") or ob.get("local_message_id", "")
        if _has_reply(inbounds, thread_id, ob.get("contact_id", ""),
                      ob.get("sent_at") or ob.get("created_at", "")):
            continue  # 已回复 → 停止
        sent_at = ob.get("sent_at") or ob.get("created_at", "")
        due_at = ob.get("followup_due_at") or _iso_add_days(sent_at, FOLLOWUP_DUE_DAYS)
        due_ts = _parse_ts(due_at)
        if due_ts is None or at_ts < due_ts:
            continue  # 未到期
        candidates.append({
            "outbound": ob,
            "next_touch": next_touch,
            "due_at": due_at,
            "buyer_email": buyer_email,
        })
    return candidates


def run_followup_cycle(company_id: str, at: str = None, dry_run: bool = False) -> dict:
    """生成跟进草稿（pending_confirmation）+ no_reply_due 信号，幂等。

    复用 dc_email_signals.evaluate_due 生成 no_reply_due 信号；
    复用 dc_reply_draft 生成 + 存储跟进草稿（category=followup，touch_number=下一轮）。
    """
    candidates = list_followup_candidates(company_id, at=at)
    generated = []
    skipped = 0

    # 1) no_reply_due 信号（幂等，复用 evaluate_due）
    try:
        from .dc_email_signals import evaluate_due
        evaluate_due(company_id)
    except Exception:
        pass

    # 2) 跟进草稿
    from .dc_reply_draft import record_draft, get_draft
    for c in candidates:
        ob = c["outbound"]
        next_touch = c["next_touch"]
        fid = _followup_id(company_id, ob.get("campaign_id", ""), ob.get("lead_id", ""),
                           ob.get("contact_id", ""), next_touch)
        if get_draft(fid):
            skipped += 1
            continue
        buyer = c["buyer_email"].split("@")[0] if "@" in c["buyer_email"] else c["buyer_email"]
        rec = {
            "draft_id": fid,
            "company_id": company_id,
            "campaign_id": ob.get("campaign_id", ""),
            "lead_id": ob.get("lead_id", ""),
            "contact_id": ob.get("contact_id", ""),
            "account_id": ob.get("account_id", ""),
            "buyer_email": c["buyer_email"],
            "related_reply_id": ob.get("resend_id", "") or ob.get("local_message_id", ""),
            "subject": f"Re: {ob.get('subject', '')}" if ob.get("subject") else "Follow-up",
            "text": followup_text(next_touch, buyer),
            "missing_fields": [],
            "status": "pending_confirmation",
            "category": "followup",
            "created_at": _now(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
            "updated_at": _now(),
            "message_id": "",
            "sent_at": "",
            "failure_reason": "",
            "next_action": "",
            "attempts": 0,
            "touch_number": next_touch,
        }
        if not dry_run:
            record_draft(rec)
        generated.append(rec)

    return {
        "company_id": company_id,
        "candidates": len(candidates),
        "generated": len(generated),
        "skipped": skipped,
        "dry_run": dry_run,
        "followups": [{"draft_id": g["draft_id"], "touch_number": g["touch_number"],
                       "buyer_email": g["buyer_email"]} for g in generated],
    }
