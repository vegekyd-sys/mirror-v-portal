#!/usr/bin/env python3
"""email_metrics.schema — 邮件事实字段名与枚举的唯一来源。

设计依据：`docs/email-metrics-v1.md`

**禁止在其它模块写字段名字面量。** 线上 bug 的根因就是
`direction` vs `record_type`、`resend_id` vs `resend_received_id` 两套名字混用：
读错不报错，只静默返回 0 / False。
"""
from __future__ import annotations

SCHEMA_VERSION = 1

# ── 方向 ────────────────────────────────────────────────
DIRECTION_OUTBOUND = "outbound"
DIRECTION_INBOUND = "inbound"

# ── 投递态事件（delivery_state）──────────────────────────
EV_ACCEPTED = "accepted"
EV_DELIVERED = "delivered"
EV_BOUNCED = "bounced"
EV_FAILED = "failed"
DELIVERY_EVENT_TYPES = (EV_ACCEPTED, EV_DELIVERED, EV_BOUNCED, EV_FAILED)

# ── 互动态事件（engagement）─────────────────────────────
EV_OPENED = "opened"
EV_CLICKED = "clicked"
EV_COMPLAINED = "complained"
EV_UNSUBSCRIBED = "unsubscribed"
ENGAGEMENT_EVENT_TYPES = (EV_OPENED, EV_CLICKED, EV_COMPLAINED, EV_UNSUBSCRIBED)

# ── 入站事件 ────────────────────────────────────────────
EV_INBOUND_RECEIVED = "inbound_received"
INBOUND_EVENT_TYPES = (EV_INBOUND_RECEIVED,)

ALL_EVENT_TYPES = DELIVERY_EVENT_TYPES + ENGAGEMENT_EVENT_TYPES + INBOUND_EVENT_TYPES

# ── 消息投递终态（投影结果）─────────────────────────────
STATE_UNKNOWN = "unknown"
STATE_PENDING = "pending"
STATE_ACCEPTED = "accepted"
STATE_DELIVERED = "delivered"
STATE_BOUNCED = "bounced"
STATE_FAILED = "failed"
NON_FINAL_STATES = (STATE_UNKNOWN, STATE_PENDING, STATE_ACCEPTED)

# ── 归属绑定状态 ────────────────────────────────────────
BINDING_BOUND = "bound"
BINDING_AMBIGUOUS = "ambiguous"
BINDING_UNASSIGNED = "unassigned"

# ── 商机信号类型（可追溯 signal；不写进原始邮件事实）────────
OPPORTUNITY_SIGNAL_TYPES = (
    "quote_request", "sample_request", "meeting_interest", "missing_info",
)

# ── 字段名（唯一来源）───────────────────────────────────
F_SCHEMA_VERSION = "schema_version"
F_EVENT_ID = "event_id"
F_EVENT_TYPE = "event_type"
F_OCCURRED_AT_UTC = "occurred_at_utc"
F_INGESTED_AT_UTC = "ingested_at_utc"
F_PROVIDER = "provider"
F_PROVIDER_MESSAGE_ID = "provider_message_id"
F_PROVIDER_RECEIVED_ID = "provider_received_id"
F_ACCOUNT_ID = "account_id"
F_COMPANY_ID = "company_id"
F_CAMPAIGN_ID = "campaign_id"
F_LEAD_ID = "lead_id"
F_CONTACT_ID = "contact_id"
F_THREAD_ID = "thread_id"
F_DIRECTION = "direction"
F_SMTP_MESSAGE_ID = "smtp_message_id"
F_IN_REPLY_TO = "in_reply_to"
F_REFERENCES = "references"
F_BINDING_STATUS = "binding_status"
F_BINDING_REASON = "binding_reason"
F_LEGACY_UNVERIFIED = "legacy_unverified"
F_SOURCE = "source"
F_RAW_REF = "raw_ref"
F_BUYER_KEY = "buyer_key"

# 事实层记录允许出现的字段（写入前校验，防止再漂移）
EVENT_FIELDS = (
    F_SCHEMA_VERSION, F_EVENT_ID, F_EVENT_TYPE, F_OCCURRED_AT_UTC, F_INGESTED_AT_UTC,
    F_PROVIDER, F_PROVIDER_MESSAGE_ID, F_PROVIDER_RECEIVED_ID, F_ACCOUNT_ID,
    F_COMPANY_ID, F_CAMPAIGN_ID, F_LEAD_ID, F_CONTACT_ID, F_THREAD_ID, F_DIRECTION,
    F_SMTP_MESSAGE_ID, F_IN_REPLY_TO, F_REFERENCES, F_BINDING_STATUS, F_BINDING_REASON,
    F_BUYER_KEY, F_SOURCE, F_RAW_REF,
)

# ── 数据来源标记 ────────────────────────────────────────
SOURCE_LEGACY_PROXY = "legacy_proxy"   # 旧数据推断的时间戳/状态，非 provider 原始事件
SOURCE_PROVIDER = "provider"
SOURCE_SYNTHETIC = "synthetic"         # 合成样本（仅测试/对账用）
SOURCE_SMTP_OPTIMISTIC = "smtp_optimistic"  # SMTP 直发无投递回执：乐观 accepted，非 provider 原始事件
