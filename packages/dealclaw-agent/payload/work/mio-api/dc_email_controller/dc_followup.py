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

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

# 轮次上限 / 节奏 / 分层 / 角度 / 回复判定：统一由 dc_touch_rounds 提供（单一来源），
# 本模块只负责「扫描 + 生成待确认草稿」，不再自己维护第二套参数。
from dc_touch_rounds import (
    angle_for_round, angle_label, build_lead_index, current_round_of, due_at_for, followup_id,
    has_reply as _tr_has_reply, read_lead_pool, resolve_tier, round_email_body,
)

MAX_ROUNDS = int(os.environ.get("DC_TOUCH_MAX_ROUNDS", "3") or 3)
FOLLOWUP_MAX_ROUNDS = MAX_ROUNDS
FOLLOWUP_DUE_DAYS = int(os.environ.get("DC_FOLLOWUP_DUE_DAYS", "2") or 2)

# 停止跟进的 provider_status（退信/投诉/失败）
_STOP_STATUSES = {"bounced", "complained", "failed"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _followup_id(company_id: str, campaign_id: str, lead_id: str, contact_id: str,
                 touch_number: int) -> str:
    """跟进草稿幂等键（与 dc_touch_rounds.followup_id 同式、同源）。"""
    return followup_id(company_id, campaign_id, lead_id, contact_id, touch_number)


def _parse_ts(ts) -> float | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except (ValueError, OSError):
        return None


def _has_reply(inbounds: list[dict], thread_id: str, contact_id: str, sent_at: str,
               outbound: dict | None = None, outbound_records: list | None = None) -> bool:
    """是否已收到人工回复（**停止跟进**的判据之一）。

    统一走 dc_touch_rounds.has_reply（单一来源）：
      - binding_status=bound + thread/contact 匹配（旧路径保留）；
      - Adapter 引用匹配（In-Reply-To / References / thread，`resend_received_id` /
        `resend_id` 两种字段名都认），避免入站 id 只存在于一种字段名时把已回复买家
        误算进待跟进。
    本地 binding 判定作为兜底保留，保证行为只增不减。
    """
    if outbound is not None:
        try:
            if _tr_has_reply(outbound, inbounds, outbound_records):
                return True
        except Exception:  # noqa: BLE001 — 归属判定失败不阻断跟进扫描
            pass
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
    """跟进邮件正文（按轮次给不同角度，配置在 dc_touch_rounds.ROUND_ANGLES）。

    R1 首触（产品+能力）/ R2 价值强化（认证/产能/案例/价格锚点）/ R3 机会型（展会/限时/样品）。
    """
    return round_email_body(touch_number, buyer_name=buyer_name, product=product)


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
        if current_round_of(ob) < FOLLOWUP_MAX_ROUNDS:
            continue
        thread_id = ob.get("thread_id") or ob.get("local_message_id", "")
        if _has_reply(inbounds, thread_id, ob.get("contact_id", ""),
                      ob.get("sent_at") or ob.get("created_at", ""),
                      outbound=ob, outbound_records=outbounds):
            continue
        result.append({"resend_id": ob.get("resend_id", ""),
                       "buyer_email": (ob.get("recipients") or [""])[0],
                       "touch_number": ob.get("touch_number"),
                       "campaign_id": ob.get("campaign_id", "")})
    return result


def list_followup_candidates(company_id: str, at: str = None) -> list[dict]:
    """扫描 delivered + 未回复 + 未停止 + 到期的 outbound，返回跟进候选（含 next_touch）。

    到期时间与分层节奏统一走 dc_touch_rounds.due_at_for：
      · 显式 followup_due_at 优先；
      · 能分出 T1/T2（线索池「跟进优先级」）→ 用分层节奏（T1 3/5 天，T2 7/10 天）；
      · 分不出分层（线索池无此买家 / 优先级为空）→ 兜底节奏 FOLLOWUP_DUE_DAYS（默认 2 天），
        保持既有线上行为不变。
    `touch_number` 0 与 1 都算 R1（current_round_of），next_touch 不会重复算成 1。
    """
    from email_gateway.store import EmailStore
    from dc_ls_store import LeadStore
    store = EmailStore()
    ls = LeadStore()
    outbounds = store.list_outbound_records(company_id=company_id)
    inbounds = store.list_inbound_records(company_id=company_id)
    lead_index = build_lead_index(read_lead_pool(company_id))
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
        touch = current_round_of(ob)
        next_touch = touch + 1
        if next_touch > FOLLOWUP_MAX_ROUNDS:
            continue  # 超过第三轮 → 停止（交给策略复盘）
        thread_id = ob.get("thread_id") or ob.get("local_message_id", "")
        if _has_reply(inbounds, thread_id, ob.get("contact_id", ""),
                      ob.get("sent_at") or ob.get("created_at", ""),
                      outbound=ob, outbound_records=outbounds):
            continue  # 已回复 → 停止
        sent_at = ob.get("sent_at") or ob.get("created_at", "")
        tier_info = resolve_tier(lead_index, ob)
        due_at, due_policy = due_at_for(ob, tier=tier_info["tier"], current_round=touch,
                                        fallback_due_days=FOLLOWUP_DUE_DAYS)
        due_ts = _parse_ts(due_at)
        if due_ts is None or at_ts < due_ts:
            continue  # 未到期
        candidates.append({
            "outbound": ob,
            "next_touch": next_touch,
            "due_at": due_at,
            "buyer_email": buyer_email,
            "tier": tier_info["tier"] or "未定",
            "priority": tier_info["priority"],
            "tier_source": tier_info["source"],
            "due_policy": due_policy,
            "angle": angle_label(next_touch),
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
            # 轮次元数据（分层 / 角度 / 依据），供确认时看得清「这轮为什么第 N 轮、写什么角度」
            "round_tier": c.get("tier", "") or "未定",
            "round_angle": angle_for_round(next_touch)["key"],
            "round_angle_label": c.get("angle") or angle_label(next_touch),
            "round_due_at": c.get("due_at", ""),
            "round_evidence": (f"touch_number={int(ob.get('touch_number', 0) or 0)} · "
                               f"{c.get('due_policy', '')} · 分层 {c.get('tier') or '未定'}"),
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
