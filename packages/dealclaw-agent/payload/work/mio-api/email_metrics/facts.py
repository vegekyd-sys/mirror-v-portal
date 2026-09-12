#!/usr/bin/env python3
"""email_metrics.facts — 事件回放 + 消息投递投影。

两条不变量：

1. **投递态与互动态分开**：`complained` / `unsubscribed` 只记 engagement，
   **永不覆盖送达状态**。
2. **终态投影不被晚到事件覆盖**：投影按 `occurred_at_utc` 排序取最后一条，
   **不按 ingested 顺序**。所以乱序到达的早期事件不会翻掉已确立的终态；
   而 occurred_at 确实更晚的 `bounced`（延迟退信）会正常成为终态。

产出：
  - `delivered_ever`  —— 历史上出现过 delivered（哪怕后来退信）
  - `delivered_final` —— 终态是 delivered（延迟退信后为 False）
  早晚报未来只使用 `delivered_final`。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import schema as S
from .pseudonym import buyer_key, normalize_email

try:  # Python 3.9+
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None


# 同一时刻的事件定序：数字越大、越「终态」。
# 旧数据只有单一时间戳，accepted 与 terminal 会同刻；靠这个次序保证终态胜出。
_STATE_RANK = {S.EV_ACCEPTED: 0, S.EV_DELIVERED: 1, S.EV_FAILED: 2, S.EV_BOUNCED: 3}


def parse_ts(value) -> float | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def to_local_date(value, tz_name: str = "Asia/Shanghai") -> str:
    """UTC 时间戳 → 业务时区日期（日报归属日期在这里现算，事实层不存）。"""
    ts = parse_ts(value)
    if ts is None:
        return ""
    tz = ZoneInfo(tz_name) if ZoneInfo else timezone.utc
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(tz).date().isoformat()


@dataclass
class MessageState:
    """单封邮件的投影状态。"""
    message_key: str
    direction: str
    company_id: str = ""
    campaign_id: str = ""
    lead_id: str = ""
    contact_id: str = ""
    thread_id: str = ""
    buyer_key: str = ""
    smtp_message_id: str = ""
    delivery_events: list = field(default_factory=list)
    engagement: dict = field(default_factory=dict)
    final_state: str = S.STATE_UNKNOWN
    has_accepted: bool = False
    delivered_ever: bool = False
    delivered_final: bool = False
    first_seen_utc: str = ""
    last_event_utc: str = ""

    @property
    def bounced_final(self) -> bool:
        return self.final_state == S.STATE_BOUNCED

    @property
    def failed_final(self) -> bool:
        return self.final_state == S.STATE_FAILED

    @property
    def pending(self) -> bool:
        """有 accepted、但没有任何终态事件 —— 投递结果未知的中间态。"""
        return self.final_state == S.STATE_ACCEPTED

    @property
    def complained(self) -> bool:
        return self.engagement.get(S.EV_COMPLAINED, 0) > 0

    @property
    def unsubscribed(self) -> bool:
        return self.engagement.get(S.EV_UNSUBSCRIBED, 0) > 0


@dataclass
class ReplayResult:
    messages: dict = field(default_factory=dict)
    inbound_events: list = field(default_factory=list)
    unassigned: list = field(default_factory=list)
    ambiguous: list = field(default_factory=list)
    unknown_events: list = field(default_factory=list)
    duplicates: int = 0
    completeness: dict = field(default_factory=dict)


def _msg_key(ev: dict) -> str:
    if ev.get(S.F_DIRECTION) == S.DIRECTION_INBOUND:
        return ev.get(S.F_PROVIDER_RECEIVED_ID) or ev.get(S.F_PROVIDER_MESSAGE_ID) or ""
    return ev.get(S.F_PROVIDER_MESSAGE_ID) or ""


def replay(events, watermark_utc: str | None = None) -> ReplayResult:
    """回放事件流 → 消息投影。

    `watermark_utc`：只应用 `occurred_at_utc <= watermark` 的事件（partial 同步用）。
    传入 watermark 时结果标记 `partial=True`，下游必须报「数据未同步」而不是 0。
    """
    res = ReplayResult()
    seen: set[str] = set()
    watermark_ts = parse_ts(watermark_utc)
    out_of_window = 0

    for ev in events or []:
        eid = ev.get(S.F_EVENT_ID, "")
        if eid and eid in seen:
            res.duplicates += 1
            continue
        if eid:
            seen.add(eid)

        occurred = ev.get(S.F_OCCURRED_AT_UTC)
        occ_ts = parse_ts(occurred)
        if watermark_ts is not None and occ_ts is not None and occ_ts > watermark_ts:
            out_of_window += 1
            continue

        etype = (ev.get(S.F_EVENT_TYPE) or "").strip().lower()
        direction = ev.get(S.F_DIRECTION) or S.DIRECTION_OUTBOUND

        if etype == S.EV_INBOUND_RECEIVED:
            if ev.get(S.F_BINDING_STATUS) == S.BINDING_UNASSIGNED:
                res.unassigned.append(ev)
            elif ev.get(S.F_BINDING_STATUS) == S.BINDING_AMBIGUOUS:
                res.ambiguous.append(ev)
            res.inbound_events.append(ev)
            continue

        if etype not in S.DELIVERY_EVENT_TYPES and etype not in S.ENGAGEMENT_EVENT_TYPES:
            res.unknown_events.append(ev)
            continue

        key = _msg_key(ev)
        if not key:
            res.unknown_events.append(ev)
            continue

        st = res.messages.get(key)
        if st is None:
            st = MessageState(message_key=key, direction=direction)
            res.messages[key] = st

        st.company_id = st.company_id or ev.get(S.F_COMPANY_ID, "") or ""
        st.campaign_id = st.campaign_id or ev.get(S.F_CAMPAIGN_ID, "") or ""
        st.lead_id = st.lead_id or ev.get(S.F_LEAD_ID, "") or ""
        st.contact_id = st.contact_id or ev.get(S.F_CONTACT_ID, "") or ""
        st.thread_id = st.thread_id or ev.get(S.F_THREAD_ID, "") or ""
        st.buyer_key = st.buyer_key or ev.get(S.F_BUYER_KEY, "") or ""
        st.smtp_message_id = st.smtp_message_id or ev.get(S.F_SMTP_MESSAGE_ID, "") or ""

        if etype in S.DELIVERY_EVENT_TYPES:
            st.delivery_events.append(ev)
            if etype == S.EV_ACCEPTED:
                st.has_accepted = True
        else:
            st.engagement[etype] = st.engagement.get(etype, 0) + 1

        if occ_ts is not None:
            if not st.first_seen_utc or occ_ts < (parse_ts(st.first_seen_utc) or occ_ts):
                st.first_seen_utc = occurred
            if not st.last_event_utc or occ_ts >= (parse_ts(st.last_event_utc) or occ_ts):
                st.last_event_utc = occurred

    _project(res)
    res.completeness = _completeness(res, out_of_window=out_of_window,
                                    partial=watermark_ts is not None)
    return res


def _project(res: ReplayResult) -> None:
    """对每封邮件算终态。按 occurred_at 排序（同刻用 event_id 定序），最后一条胜出。"""
    for st in res.messages.values():
        ordered = sorted(
            st.delivery_events,
            key=lambda e: (parse_ts(e.get(S.F_OCCURRED_AT_UTC)) or 0.0,
                           _STATE_RANK.get(e.get(S.F_EVENT_TYPE), -1),
                           e.get(S.F_EVENT_ID, "")),
        )
        st.delivered_ever = any(e.get(S.F_EVENT_TYPE) == S.EV_DELIVERED for e in ordered)
        if not ordered:
            st.final_state = S.STATE_UNKNOWN
        else:
            last = ordered[-1].get(S.F_EVENT_TYPE)
            st.final_state = last if last in (
                S.STATE_ACCEPTED, S.STATE_DELIVERED, S.STATE_BOUNCED, S.STATE_FAILED,
            ) else S.STATE_UNKNOWN
        # delivered_final：终态是 delivered。延迟退信（更晚的 bounced）会让它为 False
        st.delivered_final = st.final_state == S.STATE_DELIVERED


def _completeness(res: ReplayResult, *, out_of_window: int, partial: bool) -> dict:
    accepted = sum(1 for m in res.messages.values() if m.final_state == S.STATE_ACCEPTED)
    unknown = sum(1 for m in res.messages.values() if m.final_state == S.STATE_UNKNOWN)
    missing_accepted = sum(
        1 for m in res.messages.values()
        if not m.has_accepted and m.delivery_events
    )
    return {
        "partial": partial,
        "events_out_of_window": out_of_window,
        "duplicate_events": res.duplicates,
        "messages_accepted": sum(1 for m in res.messages.values() if m.has_accepted),
        "messages_missing_accepted": missing_accepted,
        "messages_pending": accepted,
        "messages_unknown": unknown,
        "inbound_unassigned": len(res.unassigned),
        "inbound_ambiguous": len(res.ambiguous),
        "unknown_events": len(res.unknown_events),
    }


def reply_links(res: ReplayResult) -> dict:
    """派生 reply 关系：入站事件 → 它回复的那封 outbound（强引用优先）。

    强匹配：`in_reply_to` / `references` 命中某封 outbound 的
    `provider_message_id` / `smtp_message_id` / `thread_id`。
    命中不了保持 ambiguous / unassigned，**不硬挂**。
    """
    index: dict[str, str] = {}
    for key, st in res.messages.items():
        # 强引用索引：provider message id / smtp Message-ID / thread
        # 两边都去尖括号，否则 `<id>` 与 `id` 永远匹配不上
        for ref in (key, st.smtp_message_id, st.thread_id):
            r = _norm_ref(ref)
            if r:
                index[r] = key

    links: dict[str, list] = {}
    for ev in res.inbound_events:
        refs = [ev.get(S.F_IN_REPLY_TO) or ""] + list(ev.get(S.F_REFERENCES) or [])
        refs.append(ev.get(S.F_THREAD_ID) or "")
        hit = ""
        for ref in refs:
            r = _norm_ref(ref)
            if r and r in index:
                hit = index[r]
                break
        if hit:
            links.setdefault(hit, []).append(ev)
    return links


def buyer_key_of(email: str) -> str:
    return buyer_key(normalize_email(email))


def _norm_ref(value) -> str:
    """引用归一化：去空白与尖括号后再比对。"""
    return (str(value) if value else "").strip().strip("<>").strip()
