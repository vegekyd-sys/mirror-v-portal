#!/usr/bin/env python3
"""email_metrics.adapter — 旧数据 → 事实层事件（只读，不修改原存储）。

旧数据三类来源：
  1. `email-facts/outbound/**/*.md`   —— 发送记录（含 provider_status）
  2. `email-facts/inbound/**/*.md`    —— 入站来信
  3. `email-facts/delivery-events/*.md` —— 投递事件 JSONL

转换规则（按 `docs/email-metrics-v1.md`）：
  - **无 provider id 的旧 outbound** → 标 `legacy_unverified`，
    **不映射为 accepted、不计入 sent**。
  - 有 provider id 的 → 生成 `accepted` 事件；再按 provider_status 生成
    `delivered` / `bounced` / `failed`。没有终态事件的停在 accepted（→ pending）。
  - 旧数据没有 provider 原始时间戳，事件时间标 `source=legacy_proxy`，
    与 provider 原始事件区分开，避免把推断当事实。
  - 入站绑定：`binding_status=bound` → bound；否则有
    `in-reply-to`/`references`/`thread_id` → ambiguous；都没有 → unassigned。

事件 id 是确定性的（同一条旧记录重复跑不会产生新事件），Adapter 幂等。
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from . import schema as S


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _event_id(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _first(*values):
    for v in values:
        if v:
            return v
    return ""


def _as_list(value) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else [value]
        except json.JSONDecodeError:
            return [value]
    return []


def _base_event(*, event_type: str, occurred_at: str, direction: str, record: dict,
                now: str) -> dict:
    return {
        S.F_SCHEMA_VERSION: S.SCHEMA_VERSION,
        S.F_EVENT_TYPE: event_type,
        S.F_OCCURRED_AT_UTC: occurred_at,
        S.F_INGESTED_AT_UTC: now,
        S.F_PROVIDER: record.get(S.F_PROVIDER) or "resend",
        S.F_ACCOUNT_ID: record.get(S.F_ACCOUNT_ID, "") or "",
        S.F_COMPANY_ID: record.get(S.F_COMPANY_ID, "") or "",
        S.F_CAMPAIGN_ID: record.get(S.F_CAMPAIGN_ID, "") or "",
        S.F_LEAD_ID: record.get(S.F_LEAD_ID, "") or "",
        S.F_CONTACT_ID: record.get(S.F_CONTACT_ID, "") or "",
        S.F_THREAD_ID: record.get(S.F_THREAD_ID, "") or "",
        S.F_DIRECTION: direction,
        S.F_SOURCE: S.SOURCE_LEGACY_PROXY,
    }


# ── outbound ────────────────────────────────────────────
def adapt_outbound(record: dict, now: str | None = None) -> dict:
    """单条旧 outbound → `{"events": [...], "unverified": {...} | None}`。"""
    now = now or _now_iso()
    provider_message_id = _first(record.get(S.F_PROVIDER_MESSAGE_ID),
                                 record.get("resend_id"))
    occurred_at = _first(record.get("sent_at"), record.get("created_at"))

    if not provider_message_id:
        return {
            "events": [],
            "unverified": {
                S.F_LEGACY_UNVERIFIED: True,
                S.F_COMPANY_ID: record.get(S.F_COMPANY_ID, "") or "",
                S.F_CAMPAIGN_ID: record.get(S.F_CAMPAIGN_ID, "") or "",
                S.F_LEAD_ID: record.get(S.F_LEAD_ID, "") or "",
                S.F_ACCOUNT_ID: record.get(S.F_ACCOUNT_ID, "") or "",
                S.F_DIRECTION: S.DIRECTION_OUTBOUND,
                S.F_OCCURRED_AT_UTC: occurred_at,
                S.F_SOURCE: S.SOURCE_LEGACY_PROXY,
                S.F_RAW_REF: record.get(S.F_RAW_REF, "") or "",
                "reason": "no_provider_message_id",
            },
        }

    base = _base_event(event_type=S.EV_ACCEPTED, occurred_at=occurred_at,
                       direction=S.DIRECTION_OUTBOUND, record=record, now=now)
    base[S.F_PROVIDER_MESSAGE_ID] = provider_message_id
    base[S.F_SMTP_MESSAGE_ID] = _first(record.get(S.F_SMTP_MESSAGE_ID), "")
    base[S.F_EVENT_ID] = _event_id(S.EV_ACCEPTED, provider_message_id)
    events = [base]

    status = (record.get("provider_status") or "").strip().lower()
    if status in (S.EV_DELIVERED, S.EV_BOUNCED, S.EV_FAILED):
        terminal = _base_event(event_type=status, occurred_at=occurred_at,
                               direction=S.DIRECTION_OUTBOUND, record=record, now=now)
        terminal[S.F_PROVIDER_MESSAGE_ID] = provider_message_id
        terminal[S.F_SMTP_MESSAGE_ID] = _first(record.get(S.F_SMTP_MESSAGE_ID), "")
        # 旧记录只有单一 updated_at，退化为同一时间点；靠 event_id 定序（确定性）
        terminal[S.F_EVENT_ID] = _event_id(status, provider_message_id)
        events.append(terminal)

    return {"events": events, "unverified": None}


# ── inbound ─────────────────────────────────────────────
def adapt_inbound(record: dict, now: str | None = None) -> dict:
    """单条旧 inbound → 事件（只存一次入站事实，reply 关系另行派生）。"""
    now = now or _now_iso()
    received_id = _first(record.get(S.F_PROVIDER_RECEIVED_ID),
                         record.get("resend_received_id"), record.get("resend_id"))
    if not received_id:
        received_id = _first(record.get("message_id"), "")

    occurred_at = _first(record.get("received_at"), record.get("created_at"),
                         record.get("sent_at"))
    ev = _base_event(event_type=S.EV_INBOUND_RECEIVED, occurred_at=occurred_at,
                     direction=S.DIRECTION_INBOUND, record=record, now=now)
    ev[S.F_PROVIDER_MESSAGE_ID] = _first(record.get("message_id"), "")
    ev[S.F_PROVIDER_RECEIVED_ID] = received_id
    ev[S.F_IN_REPLY_TO] = _first(record.get(S.F_IN_REPLY_TO), "")
    ev[S.F_REFERENCES] = _as_list(record.get(S.F_REFERENCES))
    ev[S.F_EVENT_ID] = _event_id(S.EV_INBOUND_RECEIVED, received_id)
    ev[S.F_BUYER_KEY] = _first(record.get(S.F_BUYER_KEY), "")
    if record.get("auto_reply"):
        # 自动回复是入站事实的一部分，必须带下去，否则会被当作人工回复
        ev["auto_reply"] = True

    bound = (record.get(S.F_BINDING_STATUS) or "").strip().lower()
    if bound == S.BINDING_BOUND:
        ev[S.F_BINDING_STATUS] = S.BINDING_BOUND
        ev[S.F_BINDING_REASON] = "legacy_bound"
    elif ev[S.F_IN_REPLY_TO] or ev[S.F_REFERENCES] or ev[S.F_THREAD_ID]:
        ev[S.F_BINDING_STATUS] = S.BINDING_AMBIGUOUS
        ev[S.F_BINDING_REASON] = "legacy_weak_reference"
    else:
        ev[S.F_BINDING_STATUS] = S.BINDING_UNASSIGNED
        ev[S.F_BINDING_REASON] = "legacy_no_reference"
    return {"events": [ev], "unverified": None}


# ── delivery-events（旧 JSONL）──────────────────────────
def adapt_delivery_event(line: dict, now: str | None = None) -> dict:
    now = now or _now_iso()
    status = (line.get("event_type") or line.get("status") or "").strip().lower()
    rid = _first(line.get("resend_id"), "")
    ev = {
        S.F_SCHEMA_VERSION: S.SCHEMA_VERSION,
        S.F_EVENT_TYPE: status,
        S.F_OCCURRED_AT_UTC: _first(line.get("created_at"), ""),
        S.F_INGESTED_AT_UTC: now,
        S.F_PROVIDER: "resend",
        S.F_PROVIDER_MESSAGE_ID: rid,
        S.F_DIRECTION: S.DIRECTION_OUTBOUND,
        S.F_SOURCE: S.SOURCE_PROVIDER,
        S.F_EVENT_ID: _first(line.get("event_id"), "") or _event_id(status, rid, line.get("created_at", "")),
    }
    return ev


# ── 批量 ────────────────────────────────────────────────
def adapt_all(outbound_records, inbound_records=(), delivery_lines=(), now: str | None = None) -> dict:
    """批量转换。返回 {"events": [...去重...], "legacy_unverified": [...], "stats": {...}}。"""
    now = now or _now_iso()
    events: list[dict] = []
    unverified: list[dict] = []
    for rec in outbound_records or []:
        out = adapt_outbound(rec, now=now)
        events.extend(out["events"])
        if out["unverified"]:
            unverified.append(out["unverified"])
    for rec in inbound_records or []:
        events.extend(adapt_inbound(rec, now=now)["events"])
    for line in delivery_lines or []:
        events.append(adapt_delivery_event(line, now=now))

    # 幂等去重：event_id 是确定性的
    seen: set[str] = set()
    deduped: list[dict] = []
    duplicates = 0
    for ev in events:
        eid = ev.get(S.F_EVENT_ID, "")
        if eid and eid in seen:
            duplicates += 1
            continue
        if eid:
            seen.add(eid)
        deduped.append(ev)

    return {
        "events": deduped,
        "legacy_unverified": unverified,
        "stats": {
            "events_in": len(events),
            "events_out": len(deduped),
            "duplicate_events": duplicates,
            "legacy_unverified": len(unverified),
        },
    }


def load_legacy_records(facts_root: str | Path) -> dict:
    """只读读出旧数据原始记录（供对账复现旧口径用）。

    返回 `{"outbound": [...], "inbound": [...], "delivery": [...]}`，
    与 `load_legacy_from_dir` 读的是同一份数据，口径不同。
    """
    root = Path(facts_root)
    outbound, inbound, delivery = [], [], []

    for kind, sink in (("outbound", outbound), ("inbound", inbound)):
        for path in sorted((root / kind).rglob("*.md")):
            rec = _read_json_snapshot(path)
            if rec:
                rec.setdefault(S.F_RAW_REF, str(path))
                sink.append(rec)

    for path in sorted((root / "delivery-events").glob("*.md")):
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                delivery.append(obj)

    return {"outbound": outbound, "inbound": inbound, "delivery": delivery}


def load_legacy_from_dir(facts_root: str | Path) -> dict:
    """从 `email-facts/` 目录读旧数据（只读）。缺目录按空处理，不报错。"""
    recs = load_legacy_records(facts_root)
    return adapt_all(recs["outbound"], recs["inbound"], recs["delivery"])


def _read_json_snapshot(path: Path) -> dict | None:
    """快照格式：`# 头` + 一行 JSON。取第一个可解析的 JSON 对象行。"""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            return obj if isinstance(obj, dict) else None
    except OSError:
        return None
    return None
