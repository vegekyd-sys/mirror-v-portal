#!/usr/bin/env python3
"""email_metrics.legacy — 旧口径 Adapter（字段名兼容 + 业务时区「今日」）。

**旧路径（早晚报 / EmailProvider / 看板）统一走这里**，不许各写各的字段名。
线上 bug 的根因就是两套名字混用：落盘写 `record_type`，读的人看 `direction`；
入站存 `resend_received_id`，读的人看 `resend_id`。读错不报错 → 静默返回 0 / False。

本模块做三件事：

1. **字段名兼容**：`record_type` / `direction` / `dir` 都认；`out` / `in` 也认
   （`dc_memory_data.sync_emails_to_memory` 写的就是 `out` / `in`）。
   出站 provider id 认 `provider_message_id` / `resend_id` / `local_message_id`；
   入站 id 认 `provider_received_id` / `resend_received_id` / `resend_id`。
2. **业务时区取日**：`date` / `date_range` 一律按 `report_timezone`（默认
   Asia/Shanghai）从 UTC 时间现算业务日，禁止用 ISO 前 10 位当本地日期。
3. **旧口径数字**：发送（outbound 记录数）/ 送达 / 退信 / 入站 / 已回复买家。
   数字口径仍是旧的（含与 v1 的差异），只是不再因为读错字段而恒 0。

**只读**：不写任何存储。
"""
from __future__ import annotations

import json
from typing import Iterable

from . import schema as S
from .config import DEFAULT_REPORT_TZ
from .facts import to_local_date

# ── 方向别名 ────────────────────────────────────────────
_OUT_ALIASES = {"outbound", "out", "sent", "send", "o"}
_IN_ALIASES = {"inbound", "in", "received", "reply", "replied", "i"}

_RECIPIENT_FIELDS = ("recipients", "to", "recipient")
_STATUS_FIELDS = ("provider_status", "status")
_OUT_ID_FIELDS = (S.F_PROVIDER_MESSAGE_ID, "resend_id", "local_message_id")
_IN_ID_FIELDS = (S.F_PROVIDER_RECEIVED_ID, "resend_received_id", "resend_id", "message_id")
_TS_FIELDS_OUT = ("sent_at", "created_at", "updated_at")
_TS_FIELDS_IN = ("received_at", "sent_at", "created_at")
_REF_FIELDS = (S.F_IN_REPLY_TO, S.F_REFERENCES, S.F_THREAD_ID)
_AUTO_REPLY_FIELDS = ("auto_reply", "is_auto_reply", "auto_submitted")


def _first(record: dict, fields: Iterable[str]) -> str:
    for f in fields:
        v = record.get(f)
        if isinstance(v, str) and v.strip():
            return v
        if v not in (None, "", [], {}):
            return str(v)
    return ""


def norm_ref(value) -> str:
    """引用归一化：去空白与尖括号后再比对（`<id>` 与 `id` 必须能匹配）。"""
    return (str(value) if value else "").strip().strip("<>").strip()


def direction_of(record: dict, default: str = "") -> str:
    """`record_type` / `direction` / `dir` 任一给出的方向，归一为 outbound/inbound。

    认不出返回 `default`（从 `list_inbound_records` 拿到的记录缺方向时按入站算）。
    """
    for f in ("record_type", "direction", "dir"):
        v = str(record.get(f) or "").strip().lower()
        if not v:
            continue
        if v in _OUT_ALIASES:
            return S.DIRECTION_OUTBOUND
        if v in _IN_ALIASES:
            return S.DIRECTION_INBOUND
    return default


def is_inbound(record: dict, default: bool = False) -> bool:
    d = direction_of(record, S.DIRECTION_INBOUND if default else S.DIRECTION_OUTBOUND)
    return d == S.DIRECTION_INBOUND


def outbound_ids(record: dict) -> list[str]:
    """出站可被回复引用的全部 id（provider id / smtp Message-ID / 本地 id / 线程）。"""
    ids = [_first(record, _OUT_ID_FIELDS), _first(record, (S.F_SMTP_MESSAGE_ID,)),
           _first(record, (S.F_THREAD_ID, "local_message_id"))]
    other = record.get("source_resend_id") or ""
    if other:
        ids.append(str(other))
    return [norm_ref(i) for i in ids if norm_ref(i)]


def outbound_provider_id(record: dict) -> str:
    return norm_ref(_first(record, _OUT_ID_FIELDS))


def inbound_received_id(record: dict) -> str:
    return norm_ref(_first(record, _IN_ID_FIELDS))


def inbound_refs(record: dict) -> list[str]:
    """入站可用于匹配的引用：强引用（In-Reply-To / References / thread）+ 旧 id 兼容。"""
    refs: list[str] = []
    for f in _REF_FIELDS:
        v = record.get(f)
        if isinstance(v, (list, tuple)):
            refs.extend(norm_ref(x) for x in v)
        else:
            refs.append(norm_ref(v))
    # 兼容：入站实测把这些 id 写在 resend_received_id / source_resend_id / resend_id 上
    for f in (S.F_PROVIDER_RECEIVED_ID, "resend_received_id", "source_resend_id", "resend_id"):
        refs.append(norm_ref(record.get(f)))
    return [r for r in refs if r]


def recipients_of(record: dict) -> list[str]:
    v = _first_raw(record, _RECIPIENT_FIELDS)
    if isinstance(v, str):
        try:
            parsed = json.loads(v or "[]")
            if isinstance(parsed, list):
                return [str(x) for x in parsed]
        except json.JSONDecodeError:
            pass
        return [v] if v else []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    return []


def _first_raw(record: dict, fields: Iterable[str]):
    for f in fields:
        v = record.get(f)
        if v not in (None, "", [], {}):
            return v
    return ""


def buyer_email_of(record: dict) -> str:
    for r in recipients_of(record):
        if "@" in r:
            return r.strip().lower()
    return ""


def provider_status(record: dict) -> str:
    return str(_first(record, _STATUS_FIELDS) or "").strip().lower()


def is_auto_reply(record: dict) -> bool:
    for f in _AUTO_REPLY_FIELDS:
        if record.get(f):
            return True
    return False


# ── 时间 / 业务日 ───────────────────────────────────────
def record_ts(record: dict, *, inbound: bool) -> str:
    return _first(record, _TS_FIELDS_IN if inbound else _TS_FIELDS_OUT)


def business_date(ts, tz: str | None = None) -> str:
    """UTC 时间 → 业务日（默认 Asia/Shanghai）。"""
    return to_local_date(ts, tz or DEFAULT_REPORT_TZ)


def normalize_range(date=None, date_range=None) -> tuple[str | None, str | None]:
    if date_range:
        if isinstance(date_range, (list, tuple)) and len(date_range) == 2:
            return date_range[0], date_range[1]
        if isinstance(date_range, dict):
            return date_range.get("start"), date_range.get("end")
    if date:
        return date, date
    return None, None


def in_business_range(ts, *, date=None, date_range=None, tz: str | None = None) -> bool:
    start, end = normalize_range(date, date_range)
    if not start and not end:
        return True
    d = business_date(ts, tz)
    if not d:
        return False
    if start and d < start:
        return False
    if end and d > end:
        return False
    return True


# ── 归属（旧口径：强引用优先，匹配不到不硬挂）────────────
def outbound_index(outbound_records: Iterable[dict]) -> dict[str, str]:
    """引用 → 出站记录定位键。"""
    index: dict[str, str] = {}
    for i, rec in enumerate(outbound_records):
        key = outbound_provider_id(rec) or f"legacy_out_{i}"
        for ref in outbound_ids(rec):
            index.setdefault(ref, key)
    return index


def match_inbound(record: dict, index: dict[str, str]) -> str:
    """入站 → 它回复的那封出站（命中不了返回空串，**不硬挂**）。"""
    for ref in inbound_refs(record):
        hit = index.get(ref)
        if hit:
            return hit
    return ""


def reply_links(outbound_records: Iterable[dict],
                inbound_records: Iterable[dict]) -> dict[str, list[dict]]:
    """出站定位键 → 回复它的入站记录（只含人工回复）。"""
    outbounds = list(outbound_records)
    index = outbound_index(outbounds)
    links: dict[str, list[dict]] = {}
    for ib in inbound_records:
        if is_auto_reply(ib):
            continue
        hit = match_inbound(ib, index)
        if hit:
            links.setdefault(hit, []).append(ib)
    return links


def _replier_key(record: dict) -> str:
    """唯一回复买家去重键：lead/contact > 邮箱 > 入站 id（旧口径不做假名）。"""
    for f in (S.F_LEAD_ID, S.F_CONTACT_ID, "customer_id"):
        v = record.get(f)
        if v:
            return f"{f}:{v}"
    email = buyer_email_of(record)
    if email:
        return f"email:{email}"
    rid = inbound_received_id(record)
    return f"in_{rid}" if rid else ""


# ── 旧口径指标 ──────────────────────────────────────────
def legacy_metrics(outbound_records, inbound_records, *, company_id: str | None = None,
                   campaign_id: str | None = None, date: str | None = None,
                   date_range=None, tz: str | None = None) -> dict:
    """旧口径数字（字段名已兼容、日期已按业务时区过滤）。

    口径：`sent`/`delivered`/`bounced`/`failed`/`pending` = **按收件人数**计（1 封发给 N 个邮箱 = N），
    不数记录数；`replied` = 命中的入站消息数。
    它**不等于** v1 的 Provider accepted / 唯一回复买家，差异由 shadow 对账记录。
    """
    tz = tz or DEFAULT_REPORT_TZ
    outbounds, inbounds = [], []
    for rec in outbound_records or []:
        if company_id and rec.get(S.F_COMPANY_ID) not in ("", None) \
                and rec.get(S.F_COMPANY_ID) != company_id:
            continue
        if campaign_id and rec.get(S.F_CAMPAIGN_ID) != campaign_id:
            continue
        if not in_business_range(record_ts(rec, inbound=False), date=date,
                                 date_range=date_range, tz=tz):
            continue
        outbounds.append(rec)
    for rec in inbound_records or []:
        if company_id and rec.get(S.F_COMPANY_ID) not in ("", None) \
                and rec.get(S.F_COMPANY_ID) != company_id:
            continue
        if campaign_id and rec.get(S.F_CAMPAIGN_ID) != campaign_id:
            continue
        if not in_business_range(record_ts(rec, inbound=True), date=date,
                                 date_range=date_range, tz=tz):
            continue
        inbounds.append(rec)

    index = outbound_index(outbounds)
    replied_ids: set[str] = set()
    repliers: set[str] = set()
    auto_replies = 0
    unassigned: list[dict] = []
    reply_messages = 0
    for ib in inbounds:
        if is_auto_reply(ib):
            auto_replies += 1
            continue
        hit = match_inbound(ib, index)
        if not hit:
            unassigned.append(ib)
            continue
        replied_ids.add(hit)
        reply_messages += 1
        key = _replier_key(ib)
        if key:
            repliers.add(key)

    def _rcount(records) -> int:
        """按收件人数计（1 封发给 N 个邮箱 = N），不数记录数；收件人解析不到时按 1 计。"""
        return sum(max(1, len(recipients_of(o))) for o in records)

    return {
        "sent": _rcount(outbounds),
        "delivered": _rcount(o for o in outbounds if provider_status(o) == S.EV_DELIVERED),
        "bounced": _rcount(o for o in outbounds if provider_status(o) == S.EV_BOUNCED),
        "failed": _rcount(o for o in outbounds if provider_status(o) == S.EV_FAILED),
        "pending": _rcount(o for o in outbounds
                           if provider_status(o) not in (S.EV_DELIVERED, S.EV_BOUNCED,
                                                        S.EV_FAILED)),
        "inbound_messages": len(inbounds),
        "reply_messages": reply_messages,
        "unique_repliers": len(repliers),
        "auto_replies": auto_replies,
        "unassigned_inbound": len(unassigned),
        "replied_outbound_ids": sorted(replied_ids),
        "_outbounds": outbounds,
        "_inbounds": inbounds,
        "_unassigned": unassigned,
    }


def replied_outbound_ids(outbound_records, inbound_records, **kwargs) -> set[str]:
    """已被人工回复的出站定位键集合（EmailProvider 的「已回复不入待跟进」用它）。"""
    return set(legacy_metrics(outbound_records, inbound_records, **kwargs)["replied_outbound_ids"])


def has_reply(outbound: dict, outbound_records, inbound_records, **kwargs) -> bool:
    """单封出站是否已被人工回复（旧口径，兼容两套字段名）。"""
    ids = set(outbound_ids(outbound))
    if not ids:
        return False
    return bool(ids & replied_outbound_ids(outbound_records, inbound_records, **kwargs))
