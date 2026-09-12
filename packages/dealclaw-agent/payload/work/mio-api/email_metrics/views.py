#!/usr/bin/env python3
"""email_metrics.views — 唯一统计入口。

**早晚报 / EmailProvider / 看板都只走这里**，谁都不许再自己聚合。
现有三处各算各的，正是三处数字不一致的根因。

三个入口：
  - `activity_view`  —— 日活动：某段时间内每天发生了什么
  - `campaign_view`  —— 批次效果：某批次最终如何（分子分母都取自该批次）
  - `metrics_view`   —— 汇总：给早晚报 / Provider / 看板用的统一指标

硬约束：
  - **禁止用当天发送数计算当天回复率**（分子分母不同期）→ 所以回复率只在
    `campaign_view` 里算，且分母是**该批次**的 `delivered_final`。
  - `delivered_final`（终态是送达）与 `delivered_ever`（历史上出现过送达）分开报；
    早晚报只用 `delivered_final`。
  - `accepted` / `delivered` / `bounced` **不强制凑平**，另有 `pending` / `failed` /
    `unknown` 与数据完整度。
  - 数据源缺失（如线索源）→ 返回 `data_complete=False` + 原因，**不报 0**。
"""
from __future__ import annotations

from . import schema as S
from .facts import reply_links, to_local_date
from .pseudonym import event_key, pseudonym

DEFAULT_REPORT_TZ = "Asia/Shanghai"
_EVIDENCE_LIMIT = 50


# ── 内部工具 ────────────────────────────────────────────
def _in_range(iso: str, start: str | None, end: str | None, tz: str) -> bool:
    if not start and not end:
        return True
    d = to_local_date(iso, tz)
    if not d:
        return False
    if start and d < start:
        return False
    if end and d > end:
        return False
    return True


def _replier_key(ev: dict) -> str:
    """unique_repliers 去重键：lead_id/customer_id > contact_id > normalized_email(假名)。

    不按公司名或域名强合并；键缺失时退到消息/线程，避免把不同人并成一个。
    """
    for field in (S.F_LEAD_ID, S.F_CONTACT_ID, S.F_BUYER_KEY):
        v = ev.get(field)
        if v:
            return f"{field}:{v}"
    for field in (S.F_PROVIDER_RECEIVED_ID, S.F_THREAD_ID, S.F_EVENT_ID):
        v = ev.get(field)
        if v:
            return f"{field}:{v}"
    return ""


def _is_human_reply(ev: dict) -> bool:
    """自动回复不算人工回复（口径见 v1 文档 2.2）。"""
    return not ev.get("auto_reply", False)


# ── 主入口 ──────────────────────────────────────────────
def metrics_view(replay_result, *, company_id: str | None = None,
                 date: str | None = None, date_range=None,
                 report_timezone: str = DEFAULT_REPORT_TZ,
                 campaign_id: str | None = None,
                 opportunity_signals=None,
                 legacy_unverified: int = 0,
                 leads=None) -> dict:
    """统一指标。`replay_result` 为 facts.replay() 的输出。

    `date` / `date_range` 指定时按 `report_timezone` 算业务日归属，
    事实层不含 business_date。
    """
    start, end = _normalize_range(date, date_range)
    tz = report_timezone or DEFAULT_REPORT_TZ

    def _keep(rec: dict) -> bool:
        if company_id and (rec.get(S.F_COMPANY_ID) or "") != company_id:
            return False
        if campaign_id and (rec.get(S.F_CAMPAIGN_ID) or "") != campaign_id:
            return False
        return True

    messages = [m for m in replay_result.messages.values() if _keep({
        S.F_COMPANY_ID: m.company_id, S.F_CAMPAIGN_ID: m.campaign_id})]
    if start or end:
        messages = [m for m in messages
                    if _in_range(m.first_seen_utc, start, end, tz)]

    accepted_messages = [m for m in messages if m.has_accepted]
    delivered_final = [m for m in messages if m.delivered_final]
    delivered_ever = [m for m in messages if m.delivered_ever]
    bounced = [m for m in messages if m.bounced_final]
    failed = [m for m in messages if m.failed_final]
    pending = [m for m in messages if m.pending]
    unknown = [m for m in messages if m.final_state == S.STATE_UNKNOWN]

    links = reply_links(replay_result)

    def _reply_events():
        out = []
        for msg_key, evs in links.items():
            st = replay_result.messages.get(msg_key)
            if st is None or not _keep({S.F_COMPANY_ID: st.company_id,
                                        S.F_CAMPAIGN_ID: st.campaign_id}):
                continue
            for ev in evs:
                if not _is_human_reply(ev):
                    continue
                if (start or end) and not _in_range(
                        ev.get(S.F_OCCURRED_AT_UTC), start, end, tz):
                    continue
                out.append(ev)
        return out

    replies = _reply_events()
    replier_keys = {_replier_key(ev) for ev in replies}
    replier_keys.discard("")
    threads = {(replay_result.messages[key].thread_id or key)
               for key in links
               if replay_result.messages.get(key)
               and _keep({S.F_COMPANY_ID: replay_result.messages[key].company_id,
                          S.F_CAMPAIGN_ID: replay_result.messages[key].campaign_id})}

    opp_repliers = _opportunity_repliers(opportunity_signals, replay_result, _keep)

    completeness = dict(replay_result.completeness or {})
    completeness["legacy_unverified"] = int(legacy_unverified or 0)
    completeness["data_complete"] = not completeness.get("partial", False)

    result = {
        "schema_version": S.SCHEMA_VERSION,
        "company_id": company_id or "",
        "campaign_id": campaign_id or "",
        "report_timezone": tz,
        "range": {"start": start, "end": end},
        # 发送：Provider accepted（不是 outbound 记录数）
        "sent": len(accepted_messages),
        "delivered_final": len(delivered_final),
        "delivered_ever": len(delivered_ever),
        "bounced": len(bounced),
        "failed": len(failed),
        "pending": len(pending),
        "unknown": len(unknown),
        "legacy_unverified": int(legacy_unverified or 0),
        # 回复四数，永不合并
        "inbound_messages": len(replies),
        "unique_repliers": len(replier_keys),
        "replied_threads": len(threads),
        "confirmed_opportunity_repliers": opp_repliers,
        "data_completeness": completeness,
        "evidence": _evidence(accepted_messages, replied_events=replies),
    }
    if leads is not None:
        result["followup"] = followup_candidates(messages, replay_result,
                                                 leads=leads,
                                                 opportunity_signals=opportunity_signals)
    else:
        result["followup"] = {
            "count": None,
            "data_complete": False,
            "reason": "lead_source_missing",
        }
    return result


def _normalize_range(date, date_range):
    if date_range:
        if isinstance(date_range, (list, tuple)) and len(date_range) == 2:
            return date_range[0], date_range[1]
        if isinstance(date_range, dict):
            return date_range.get("start"), date_range.get("end")
    if date:
        return date, date
    return None, None


def _opportunity_repliers(signals, replay_result, keep) -> int:
    """已确认商机回复买家数 —— 取可追溯 signal 的 source_message_id，**不碰原始事实**。"""
    if not signals:
        return 0
    keys = set()
    for sig in signals:
        if (sig.get("signal_type") or "") not in S.OPPORTUNITY_SIGNAL_TYPES:
            continue
        msg_key = sig.get("source_message_id") or ""
        st = replay_result.messages.get(msg_key)
        lead = (st.lead_id if st else "") or sig.get("lead_id") or ""
        contact = (st.contact_id if st else "") or sig.get("contact_id") or ""
        buyer = (st.buyer_key if st else "") or sig.get("buyer_key") or ""
        key = lead or contact or buyer or msg_key
        if key:
            keys.add(key)
    return len(keys)


# ── 日活动 ──────────────────────────────────────────────
def activity_view(replay_result, *, company_id: str | None = None,
                  date_range=None,
                  report_timezone: str = DEFAULT_REPORT_TZ,
                  legacy_unverified: int = 0) -> dict:
    """日活动：按业务日分桶，回答「今天发生了什么」。"""
    start, end = _normalize_range(None, date_range)
    tz = report_timezone or DEFAULT_REPORT_TZ
    days: dict[str, dict] = {}

    def bucket(day: str) -> dict:
        return days.setdefault(day, {
            "business_date": day, "sent": 0, "delivered_final": 0,
            "delivered_ever": 0, "bounced": 0, "failed": 0, "pending": 0,
            "inbound_messages": 0, "unique_repliers": 0,
            "_repliers": set(),
        })

    for st in replay_result.messages.values():
        if company_id and st.company_id != company_id:
            continue
        day = to_local_date(st.first_seen_utc, tz)
        if not day or (start and day < start) or (end and day > end):
            continue
        b = bucket(day)
        if st.has_accepted:
            b["sent"] += 1
        if st.delivered_final:
            b["delivered_final"] += 1
        if st.delivered_ever:
            b["delivered_ever"] += 1
        if st.bounced_final:
            b["bounced"] += 1
        if st.failed_final:
            b["failed"] += 1
        if st.pending:
            b["pending"] += 1

    links = reply_links(replay_result)
    for msg_key, evs in links.items():
        st = replay_result.messages.get(msg_key)
        if st is None or (company_id and st.company_id != company_id):
            continue
        for ev in evs:
            if not _is_human_reply(ev):
                continue
            day = to_local_date(ev.get(S.F_OCCURRED_AT_UTC), tz)
            if not day or (start and day < start) or (end and day > end):
                continue
            b = bucket(day)
            b["inbound_messages"] += 1
            b["_repliers"].add(_replier_key(ev))

    out_days = []
    for day in sorted(days):
        b = days[day]
        b["unique_repliers"] = len({k for k in b.pop("_repliers") if k})
        out_days.append(b)

    return {
        "company_id": company_id or "",
        "report_timezone": tz,
        "days": out_days,
        "legacy_unverified": int(legacy_unverified or 0),
        "data_completeness": dict(replay_result.completeness or {}),
    }


# ── 批次效果 ────────────────────────────────────────────
def campaign_view(replay_result, *, company_id: str, campaign_id: str,
                  report_timezone: str = DEFAULT_REPORT_TZ,
                  opportunity_signals=None) -> dict:
    """批次效果：分子分母都取自该批次，**不受当天发送数污染**。"""
    m = metrics_view(replay_result, company_id=company_id, campaign_id=campaign_id,
                     report_timezone=report_timezone,
                     opportunity_signals=opportunity_signals)
    m["rate_basis"] = "campaign"
    m["note"] = "率的分母是该批次的 delivered_final，不是当天发送数"
    return m


# ── 待跟进 ──────────────────────────────────────────────
def followup_candidates(messages, replay_result, *, leads, opportunity_signals=None) -> dict:
    """待跟进：按**唯一 lead/opportunity** 计，不统计邮件数。

    条件（全部满足）：序列 active、最近邮件已送达（`delivered_final`）、
    `next_touch_at` 已到、无人工回复、未达最大轮次、未退订/投诉/拒绝、
    有有效渠道、未人工暂停。无有效渠道 → 待补联系人；有明确商机 next_step 的
    不重复计入普通待跟进。
    """
    links = reply_links(replay_result)
    replied_leads = set()
    for msg_key in links:
        st = replay_result.messages.get(msg_key)
        if st and st.lead_id:
            replied_leads.add(st.lead_id)

    opp_leads = set()
    for sig in (opportunity_signals or []):
        if (sig.get("signal_type") or "") in S.OPPORTUNITY_SIGNAL_TYPES and sig.get("lead_id"):
            opp_leads.add(sig["lead_id"])

    by_state = {"waiting": [], "missing_contact": [], "skipped_opportunity": [],
                "excluded": []}
    for lead in leads or []:
        lead_id = lead.get("lead_id") or lead.get("opportunity_id") or ""
        entry = {"lead_id": lead_id, "reason": ""}
        if lead.get("sequence_status") != "active":
            entry["reason"] = "sequence_not_active"
            by_state["excluded"].append(entry)
            continue
        if lead.get("manually_paused"):
            entry["reason"] = "manually_paused"
            by_state["excluded"].append(entry)
            continue
        if lead.get("unsubscribed") or lead.get("complained") or lead.get("rejected"):
            entry["reason"] = "opted_out"
            by_state["excluded"].append(entry)
            continue
        if not lead.get("channel_valid", True):
            entry["reason"] = "no_valid_channel"
            by_state["missing_contact"].append(entry)
            continue
        if lead_id in replied_leads:
            entry["reason"] = "replied"
            by_state["excluded"].append(entry)
            continue
        if not lead.get("delivered_final", False):
            entry["reason"] = "not_delivered_final"
            by_state["excluded"].append(entry)
            continue
        if not lead.get("next_touch_due", False):
            entry["reason"] = "next_touch_not_due"
            by_state["excluded"].append(entry)
            continue
        if int(lead.get("touch_number", 0)) >= int(lead.get("max_rounds", 3)):
            entry["reason"] = "max_rounds_reached"
            by_state["excluded"].append(entry)
            continue
        if lead_id in opp_leads:
            entry["reason"] = "has_opportunity_next_step"
            by_state["skipped_opportunity"].append(entry)
            continue
        by_state["waiting"].append(entry)

    return {
        "count": len(by_state["waiting"]),
        "data_complete": True,
        "waiting": by_state["waiting"],
        "missing_contact": by_state["missing_contact"],
        "skipped_opportunity": by_state["skipped_opportunity"],
        "excluded": by_state["excluded"],
    }


# ── 证据 ────────────────────────────────────────────────
def _evidence(messages, *, replied_events) -> dict:
    """脱敏证据：每个数字挂得住 message/event ID，供抽查。"""
    return {
        "sent": _ids(messages, "msg"),
        "delivered_final": _ids([m for m in messages if m.delivered_final], "msg"),
        "delivered_ever": _ids([m for m in messages if m.delivered_ever], "msg"),
        "bounced": _ids([m for m in messages if m.bounced_final], "msg"),
        "pending": _ids([m for m in messages if m.pending], "msg"),
        "inbound_messages": _ids(replied_events, "ev"),
        "truncated": len(messages) > _EVIDENCE_LIMIT,
    }


def _ids(items, kind: str) -> list:
    out = []
    for it in list(items)[:_EVIDENCE_LIMIT]:
        raw = it.get(S.F_EVENT_ID) if isinstance(it, dict) else getattr(it, "message_key", "")
        if raw:
            out.append(event_key(raw) if kind == "ev" else pseudonym("msg", raw))
    return out
