#!/usr/bin/env python3
"""email_metrics.quality_metrics — 发信质量与用量（只读指标层，统一读取入口）。

目标：把**已经存在的信号**变成可见数字（退信率 / 投诉率 / 六个投递与互动指标），
**不新建存储、不加依赖、不新建服务**。所有数字都来自现有落点：

| 指标 | 现有落点 |
|------|----------|
| accepted   | `email-facts/outbound/*.md` 的 `resend_id`/`provider_message_id`（有 Provider 受理 id 才算） |
| delivered  | 同上，`provider_status == "delivered"`（经 adapter 映射为投递事件） |
| bounced    | 同上，`provider_status == "bounced"` |
| complained | 同上，`provider_status == "complained"`（webhook `email.complained` 写入） |
| unsubscribed | **没有落点**（如实返回 None + `gaps`，不编 0） |
| replied    | `email-facts/inbound/*.md`（`received_at` 业务日） |

硬约束（与 `email_metrics` 既有约定一致）：
  - **纯读取**：无文件写、无网络、无副作用；可单测、可注入 record 列表。
  - **租户隔离**：必须显式传 `enterprise_id`；记录按 `enterprise_ids.canonical_company_id`
    归一后过滤，跨租户数据不得进入结果。
  - **不返回假 0**：没采集的指标是 `None`（`unsubscribed`），并带 `gaps` 说明；
    数据源读不到时 `status="unavailable"`，数字一律 `None`。
  - **两套账分开**：`entitlement`（用户权益：还能发多少）与 `provider_cost`（Provider 成本：
    实际消耗）互不混用，字段与口径各自独立。

口径（必须写清楚，避免再一次「三处数字不一致」）：
  - 业务日按**租户时区**现算（`config.resolve_report_timezone`），字符日期 `YYYY-MM-DD`，
    `start`/`end` 闭区间。
  - 投递族（accepted/delivered/bounced/failed/complained）按**发送日**归属；
    回复（replied）按**到达日**归属。
  - 比率分母统一是 **accepted**（Provider 受理数），分子分别是 bounced / complained，
    分子分母取自同一时间窗同一渠道（同队列），不会用「今天发送数」当历史退信的分母。

渠道口径（`founder_direct` / `growth_send`）：
  - `growth_send`：outbound 事实的 `account_id` 为 GS 直发固定账号（`resend_gs`，
    见 `dc_record_outbound.py --account-id` 默认值）；
  - `founder_direct`：其余有账号的 outbound；
  - 无 `account_id` 或回复匹配不到原发件 → `unattributed`（不硬猜，也不静默丢弃）。
  这是**推断**而非显式字段：事实层没有 channel 字段，`dc_send_log` 有 channel 但只记发送、
  不含投递/退信事件，且已被标注为旧链路。详见 `gaps["channel"]`。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from . import schema as S
from .adapter import adapt_outbound
from .config import resolve_report_timezone
from .facts import to_local_date
from .pseudonym import buyer_key, normalize_email

SCHEMA_VERSION = 1

# ── 渠道 ────────────────────────────────────────────────
CHANNEL_FOUNDER_DIRECT = "founder_direct"
CHANNEL_GROWTH_SEND = "growth_send"
CHANNEL_UNATTRIBUTED = "unattributed"
CHANNELS = (CHANNEL_FOUNDER_DIRECT, CHANNEL_GROWTH_SEND, CHANNEL_UNATTRIBUTED)

# ── 指标 ────────────────────────────────────────────────
METRICS = ("accepted", "delivered", "bounced", "complained", "unsubscribed", "replied")
UNCOLLECTED_METRICS = ("unsubscribed",)
EXTRA_COUNTERS = ("failed", "pending", "messages", "legacy_unverified")

# GS 直发事实的固定账号（dc_record_outbound.py 的 --account-id 默认值）
GROWTH_SEND_ACCOUNT_IDS = ("resend_gs",)
# EmailStore.add_account 的默认日限额（发送闸门 smtp_send 用它判定）
DEFAULT_DAILY_SEND_LIMIT = 30

_TERMINAL_EVENTS = (S.EV_DELIVERED, S.EV_BOUNCED, S.EV_FAILED)

_BASIS = {
    "window": "start/end 为业务日（租户时区）闭区间；投递族按发送日、回复按到达日归属",
    "accepted": ("outbound 有 Provider 受理 id（resend_id / provider_message_id）才计入；"
                 "无 id 的旧记录标 legacy_unverified，不计入 accepted（沿用 email_metrics.adapter 规则）"),
    "bounce_rate": "bounced / accepted（同日同时段同渠道队列）",
    "complaint_rate": "complained / accepted（同日同时段同渠道队列）",
    "replied": "入站消息条数（去重后）；unique_repliers 为去重后的回复买家数",
}


# ── 小工具 ──────────────────────────────────────────────
def _as_iso(value) -> str:
    """now 允许传 datetime 或 ISO 串；缺省取当前 UTC。"""
    if value is None:
        return datetime.now(timezone.utc).isoformat()
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    return str(value)


def _canon_company_id(value) -> str:
    try:
        from enterprise_ids import canonical_company_id
        return canonical_company_id(str(value or ""))
    except ImportError:  # pragma: no cover - 独立运行时的兜底
        return str(value or "").strip()


def _in_range(day: str, start: str | None, end: str | None) -> bool:
    """业务日闭区间判定；无区间 → 全收。空 day（无时间戳）不在此处判定。"""
    if not day:
        return False
    if start and day < start:
        return False
    if end and day > end:
        return False
    return True


def _norm_ref(value) -> str:
    return (str(value) if value else "").strip().strip("<>").strip()


def channel_of_account(account_id: str | None) -> str:
    """账号 → 渠道；无账号不猜，归 unattributed。"""
    aid = (account_id or "").strip().lower()
    if not aid:
        return CHANNEL_UNATTRIBUTED
    if aid in GROWTH_SEND_ACCOUNT_IDS:
        return CHANNEL_GROWTH_SEND
    return CHANNEL_FOUNDER_DIRECT


def _record_time(rec: dict) -> str:
    return rec.get("created_at") or rec.get("sent_at") or ""


def _reply_time(rec: dict) -> str:
    return rec.get("received_at") or rec.get("created_at") or ""


def _zero_counts() -> dict:
    """全 0 计数桶（未采集指标恒为 None）。"""
    out = {m: (None if m in UNCOLLECTED_METRICS else 0) for m in METRICS}
    out.update({c: 0 for c in EXTRA_COUNTERS})
    out["unique_repliers"] = 0
    return out


def _empty_counts_unavailable() -> dict:
    """数据源不可用时的计数桶：全 None（不是 0）。"""
    out = {m: None for m in METRICS}
    out.update({c: None for c in EXTRA_COUNTERS})
    out["unique_repliers"] = None
    return out


def _rate(numerator: int, denominator: int):
    if not denominator:
        return None
    return round(numerator / denominator, 4)


# ── 数据源 ──────────────────────────────────────────────
def _default_store():
    from email_gateway.store import EmailStore
    return EmailStore()


def _load_records(*, enterprise_id, store=None, outbound_records=None,
                  inbound_records=None) -> tuple[list, list, str, Any]:
    """读原始记录。返回 (outbounds, inbounds, error, store)；error 非空 = 数据源不可用。"""
    out, inb = outbound_records, inbound_records
    s = store
    if out is not None and inb is not None:
        return list(out), list(inb), "", s
    try:
        if s is None:
            s = _default_store()
        if out is None:
            out = list(s.list_outbound_records(company_id=enterprise_id) or [])
        if inb is None:
            inb = list(s.list_inbound_records(company_id=enterprise_id) or [])
    except Exception as e:  # noqa: BLE001 — 数据源不可用必须显式上报，不能静默当 0
        return list(out or []), list(inb or []), f"{type(e).__name__}: {e}", s
    return list(out), list(inb), "", s


def _outbound_ref_index(out_records: list) -> dict:
    """出站引用索引：resend_id / local_message_id / smtp_message_id / thread_id → 记录。

    用于把一条入站回复挂回它回复的那封出站（据此判断渠道）。
    """
    idx: dict = {}
    for rec in out_records:
        for key in (rec.get("resend_id"), rec.get("local_message_id"),
                    rec.get("smtp_message_id"), rec.get("thread_id")):
            k = _norm_ref(key)
            if k:
                idx.setdefault(k, rec)
    return idx


def _match_outbound(inbound: dict, idx: dict) -> dict | None:
    refs = [_norm_ref(inbound.get("in_reply_to"))]
    refs += [_norm_ref(r) for r in (inbound.get("references") or [])]
    refs += [_norm_ref(inbound.get("thread_id")), _norm_ref(inbound.get("message_id"))]
    for ref in refs:
        if ref and ref in idx:
            return idx[ref]
    return None


def _replier_key(inbound: dict) -> str:
    """回复买家去重键：contact_id > lead_id > 买家邮箱（假名）> 线程 > 消息。"""
    for field in ("contact_id", "lead_id"):
        v = inbound.get(field)
        if v:
            return f"{field}:{v}"
    sender = normalize_email(inbound.get("sender"))
    if sender:
        return "buyer:" + buyer_key(sender)
    for field in ("thread_id", "message_id"):
        v = inbound.get(field)
        if v:
            return f"{field}:{v}"
    return ""


# ── 主入口 ──────────────────────────────────────────────
def metrics_view(enterprise_id: str, *, start: str | None = None, end: str | None = None,
                 tenant: str | None = None, report_timezone: str | None = None,
                 store=None, now=None, outbound_records=None, inbound_records=None,
                 accounts=None) -> dict:
    """发信质量与用量统一读取入口（纯读取，无副作用）。

    参数：
      enterprise_id  企业 id / slug（必填；按 canonical 归一后过滤，租户隔离）
      start / end    业务日闭区间 `YYYY-MM-DD`（租户时区），缺省 = 全时段
      tenant         租户 slug，用于解析口径与业务时区（`email_metrics.config`）
      store          EmailStore 实例（缺省自建；测试可注入）
      now            当前时间（datetime 或 ISO 串），用于算「今日」权益账
      outbound_records / inbound_records / accounts  直接注入记录（纯读取单测用）

    返回：channels / provider_health / entitlement / provider_cost / gaps / status。
    """
    ent = (enterprise_id or "").strip()
    if not ent:
        raise ValueError("metrics_view requires enterprise_id for tenant isolation")
    canon = _canon_company_id(ent)
    tz = report_timezone or resolve_report_timezone(tenant)
    now_iso = _as_iso(now)
    today = to_local_date(now_iso, tz)

    out_recs, in_recs, source_error, used_store = _load_records(
        enterprise_id=ent, store=store, outbound_records=outbound_records,
        inbound_records=inbound_records)

    if not source_error:
        # 租户隔离：两条流都必须落在本企业 canonical id 上
        out_recs = [r for r in out_recs if _canon_company_id(r.get("company_id")) == canon]
        in_recs = [r for r in in_recs if _canon_company_id(r.get("company_id")) == canon]
    else:
        out_recs, in_recs = [], []

    counts = {ch: _zero_counts() for ch in CHANNELS}
    repliers = {ch: set() for ch in CHANNELS}
    repliers_all: set = set()
    undated_outbound = 0
    undated_replies = 0
    unmatched_replies = 0

    # ── 出站族：accepted / delivered / bounced / complained ──
    for rec in out_recs:
        ch = channel_of_account(rec.get("account_id"))
        b = counts[ch]
        b["messages"] += 1
        adapted = adapt_outbound(rec)
        if adapted.get("unverified"):
            b["legacy_unverified"] += 1
            continue
        day = to_local_date(_record_time(rec), tz)
        if not day:
            undated_outbound += 1
            continue
        if not _in_range(day, start, end):
            continue
        b["accepted"] += 1
        kinds = {e.get(S.F_EVENT_TYPE) for e in (adapted.get("events") or [])}
        if S.EV_BOUNCED in kinds:
            b["bounced"] += 1
        elif S.EV_DELIVERED in kinds:
            b["delivered"] += 1
        elif S.EV_FAILED in kinds:
            b["failed"] += 1
        else:
            b["pending"] += 1
        # complained 不在 adapter 的投递事件映射里（见 gaps），直接读快照字段
        if (rec.get("provider_status") or "").strip().lower() == S.EV_COMPLAINED:
            b["complained"] += 1

    # ── 入站族：replied ──
    idx = _outbound_ref_index(out_recs)
    seen: set = set()
    for rec in in_recs:
        key = _norm_ref(rec.get("message_id") or rec.get("resend_received_id")
                        or rec.get("resend_id"))
        if key:
            if key in seen:
                continue
            seen.add(key)
        day = to_local_date(_reply_time(rec), tz)
        if not day:
            undated_replies += 1
            continue
        if not _in_range(day, start, end):
            continue
        matched = _match_outbound(rec, idx)
        if matched is None:
            unmatched_replies += 1
        ch = channel_of_account(matched.get("account_id")) if matched else CHANNEL_UNATTRIBUTED
        counts[ch]["replied"] += 1
        rk = _replier_key(rec)
        if rk:
            repliers[ch].add(rk)
            repliers_all.add(rk)
    for ch in CHANNELS:
        counts[ch]["unique_repliers"] = len(repliers[ch])

    # ── 汇总（all = 三个渠道之和）──
    all_counts = _zero_counts()
    for ch in CHANNELS:
        for metric in METRICS:
            if ch == CHANNEL_UNATTRIBUTED and metric != "replied":
                continue  # unattributed 只承载回复
            if all_counts[metric] is None:
                continue
            all_counts[metric] += counts[ch][metric] or 0
        for extra in EXTRA_COUNTERS:
            all_counts[extra] += counts[ch][extra] or 0
    all_counts["unique_repliers"] = len(repliers_all)

    channels = {ch: dict(counts[ch]) for ch in CHANNELS}
    channels["all"] = all_counts

    health = {
        "by_channel": {ch: _health_block(channels[ch]) for ch in ("all",) + CHANNELS},
        "basis": dict(_BASIS),
        "sample": {ch: {"accepted": channels[ch]["accepted"],
                        "bounced": channels[ch]["bounced"],
                        "complained": channels[ch]["complained"]}
                   for ch in ("all",) + CHANNELS},
    }
    health.update(_health_block(all_counts))

    if accounts is None and used_store is not None and not source_error:
        try:
            accounts = list(used_store.list_accounts(enterprise_id=ent) or [])
        except Exception:  # noqa: BLE001 — 账号不可达时权益账报缺口，不猜额度
            accounts = None

    entitlement = entitlement_view(enterprise_id=ent, accounts=accounts,
                                   outbound_records=out_recs, report_timezone=tz,
                                   today=today)
    provider_cost = provider_cost_view(outbound_records=out_recs,
                                       inbound_records=in_recs,
                                       accepted_in_range=all_counts["accepted"],
                                       entitlement=entitlement,
                                       range_filtered=bool(start or end))

    gaps = _gaps(undated_outbound=undated_outbound, undated_replies=undated_replies,
                 unmatched_replies=unmatched_replies,
                 legacy_unverified=all_counts["legacy_unverified"],
                 source_error=source_error)

    reasons: list[str] = []
    if source_error:
        status = "unavailable"
        reasons.append(f"source_unavailable:{source_error}")
    else:
        status = "ok"
        if all_counts["legacy_unverified"]:
            reasons.append(f"legacy_unverified:{all_counts['legacy_unverified']}")
        if undated_outbound:
            reasons.append(f"undated_outbound:{undated_outbound}")
        if undated_replies:
            reasons.append(f"undated_replies:{undated_replies}")
        if unmatched_replies:
            reasons.append(f"replies_unattributed:{unmatched_replies}")
        if reasons:
            status = "partial"

    result = {
        "schema_version": SCHEMA_VERSION,
        "metric_set": "send-quality-v1",
        "enterprise_id": ent,
        "company_id": canon,
        "report_timezone": tz,
        "range": {"start": start or "", "end": end or ""},
        "status": status,
        "reasons": reasons,
        "channels": channels,
        "metrics": {m: channels["all"][m] for m in METRICS},
        "provider_health": health,
        "entitlement": entitlement,
        "provider_cost": provider_cost,
        "gaps": gaps,
        "read_only": True,
    }
    if source_error:
        # 数据源不可用：绝不返回 0 冒充「没有退信」
        for ch in list(result["channels"]):
            result["channels"][ch] = _empty_counts_unavailable()
        result["metrics"] = {m: None for m in METRICS}
        result["provider_health"] = {
            "by_channel": {ch: _health_block(_empty_counts_unavailable())
                           for ch in ("all",) + CHANNELS},
            "basis": dict(_BASIS),
            "sample": {ch: {"accepted": None, "bounced": None, "complained": None}
                       for ch in ("all",) + CHANNELS},
            "bounce_rate": None,
            "complaint_rate": None,
        }
    return result


def _health_block(counts: dict) -> dict:
    accepted = counts.get("accepted")
    bounced = counts.get("bounced")
    complained = counts.get("complained")
    if accepted is None:
        return {"bounce_rate": None, "complaint_rate": None,
                "accepted": None, "bounced": None, "complained": None}
    return {
        "bounce_rate": _rate(bounced or 0, accepted),
        "complaint_rate": _rate(complained or 0, accepted),
        "accepted": accepted,
        "bounced": bounced,
        "complained": complained,
    }


# ── 账本一：用户权益（还能发多少）────────────────────────
def entitlement_view(*, enterprise_id: str, accounts, outbound_records: list,
                     report_timezone: str, today: str) -> dict:
    """用户权益账：本企业今天还能发多少。

    口径（与发送闸门 `email_gateway.smtp_send` 保持一致，避免「报表说能发、闸门却拒发」）：
      - 额度：企业下 enabled 账号的 `daily_send_limit` 之和（`add_account` 默认 30/账号）；
      - 已用：outbound 记录 `status == "sent"` 且**业务日 = 今天（租户时区）**的条数，
        与 `EmailStore.count_sent_today` 同口径（单测对齐）；
      - 另列 `accepted_today`（Provider 受理口径）供对账，不作为扣减依据。

    账号来源不可达 / 未配置账号 → `quota_per_day=None` + `reason`，**不猜额度**。
    """
    base = {
        "basis": "账号 daily_send_limit 之和；自然日按租户时区；与发送闸门口径一致",
        "report_timezone": report_timezone,
        "business_date": today,
        "default_per_account_limit": DEFAULT_DAILY_SEND_LIMIT,
        "accounts": [],
        "accounts_configured": 0,
        "quota_per_day": None,
        "sent_today": None,
        "remaining_today": None,
        "exhausted": None,
        "accepted_today": None,
        "reason": "",
    }
    if accounts is None:
        base["reason"] = "account_source_unavailable"
        return base

    enabled = [a for a in accounts if a.get("enabled", 1)]
    rows, quota, used = [], 0, 0
    for acct in enabled:
        aid = str(acct.get("account_id", ""))
        limit = int(acct.get("daily_send_limit") or DEFAULT_DAILY_SEND_LIMIT)
        sent = _count_sent_today(outbound_records, aid, report_timezone, today)
        rows.append({"account_id": aid,
                     "daily_send_limit": limit,
                     "sent_today": sent,
                     "remaining_today": limit - sent})
        quota += limit
        used += sent

    accepted_today = 0
    for rec in outbound_records:
        if to_local_date(_record_time(rec), report_timezone) != today:
            continue
        if adapt_outbound(rec).get("unverified"):
            continue
        accepted_today += 1

    base.update({
        "accounts": rows,
        "accounts_configured": len(enabled),
        "quota_per_day": quota,
        "sent_today": used,
        "remaining_today": quota - used,
        "exhausted": (used >= quota) if enabled else None,
        "accepted_today": accepted_today,
        "reason": "" if enabled else "no_accounts_configured",
    })
    return base


def _count_sent_today(outbound_records: list, account_id: str, tz: str, today: str) -> int:
    """与 `EmailStore.count_sent_today` 同口径的本地计数（单测已对齐两者）。"""
    n = 0
    for rec in outbound_records:
        if (rec.get("account_id") or "") != account_id:
            continue
        if (rec.get("status") or "") != "sent":
            continue
        if to_local_date(rec.get("created_at") or rec.get("sent_at"), tz) == today:
            n += 1
    return n


# ── 账本二：Provider 成本（实际消耗）────────────────────
def provider_cost_view(*, outbound_records: list, inbound_records: list,
                       accepted_in_range, entitlement: dict,
                       range_filtered: bool = False) -> dict:
    """Provider 成本账：接口留好，本地**没有**成本数据。

    本地链路只接 Resend 的 webhook 与 Receiving API，没有任何用量/账单接口的落点：
    API 调用量、配额消耗、账期金额、套餐上限都拿不到。这里把它们留成 `None`，
    只给「本地事实计数」作为代理量，并明确标注不是计费数字。
    """
    return {
        "available": False,
        "reason": "no_provider_usage_source",
        "reason_detail": ("本地没有接 Provider 用量/账单接口（Resend usage/billing 未接入），"
                          "API 调用量、配额消耗、账期金额无法获得。"),
        "expected_source": "Provider（Resend）用量/账单 API — 未接入",
        "fields": {
            "sends": None,
            "receives": None,
            "api_calls": None,
            "quota_consumed": None,
            "plan_limit": None,
            "spend_amount": None,
            "spend_currency": None,
            "billing_period": None,
        },
        "local_proxies": {
            "note": "本地事实计数，不是 Provider 计费数字，不能当成本用",
            "accepted_in_range": accepted_in_range,
            "range_filtered": bool(range_filtered),
            "outbound_records_loaded": len(outbound_records),
            "inbound_records_loaded": len(inbound_records),
            "accounts_configured": entitlement.get("accounts_configured"),
            "daily_send_limit_total": entitlement.get("quota_per_day"),
        },
    }


# ── 缺口说明（如实报，不编数）───────────────────────────
def _gaps(*, undated_outbound: int, undated_replies: int, unmatched_replies: int,
          legacy_unverified: int, source_error: str = "") -> dict:
    return {
        "unsubscribed": {
            "collected": False,
            "reason": ("全链路没有任何地方把「退订」写成事实：EmailStore 的 provider_status 只可能被"
                       "delivered/bounced/complained/failed 写入，email-facts 没有退订事件；"
                       "`dc_iq_engine` 只在审计日志里记 `iq.unsubscribed`（无企业级查询接口），"
                       "旧 send_log 的 unsubscribed 已随 send_log 退役。"),
            "impact": "unsubscribed 计数恒为 None（不是 0），退订率无法计算",
            "where_to_fix": ("退订落地需要一个写点：webhook/回信解析出退订意图时写 "
                             "provider_status=unsubscribed 或独立 engagement 事件"),
        },
        "complained": {
            "collected": True,
            "source": "email-facts outbound `provider_status == \"complained\"`（webhook email.complained）",
            "partial_gap": ("email_metrics.adapter 只把 delivered/bounced/failed 映射成投递事件，"
                            "complained 不进 v1 事实层 → 本指标直接读快照字段，v1 视图里看不到投诉"),
        },
        "channel": {
            "collected": False,
            "method": ("事实层无 channel 字段：按 outbound `account_id` 推断 "
                       "（`resend_gs` → growth_send，其余有账号 → founder_direct，无账号 → unattributed）"),
            "confidence": "medium",
            "risk": ("GS 直发若改传 --account-id，或 FD 复用同一账号，渠道归属会漂移；"
                     "`dc_send_log` 有 channel 字段但只记发送、不含投递事件，且已属旧链路"),
            "where_to_fix": "在 outbound 事实里显式落 channel 字段（写入方：dc_record_outbound / dc_email_send）",
        },
        "provider_cost": {
            "collected": False,
            "reason": "本地无 Provider 用量/账单接口落点",
        },
        "counts": {
            "source_error": source_error,
            "undated_outbound": undated_outbound,
            "undated_replies": undated_replies,
            "replies_unattributed": unmatched_replies,
            "legacy_unverified": legacy_unverified,
        },
    }


# ── 人读渲染 ────────────────────────────────────────────
def format_quality_line(view: dict, *, prefix: str = "") -> str:
    """一行摘要（供 CLI / 日报贴用）。None 显示「未采集」，不显示 0。"""
    def _fmt(value):
        return "未采集" if value is None else str(value)

    def _pct(value):
        return "n/a" if value is None else f"{value * 100:.2f}%"

    chs = view.get("channels") or {}

    def _ch(name: str) -> str:
        c = chs.get(name) or {}
        return (f"发{_fmt(c.get('accepted'))}/送{_fmt(c.get('delivered'))}"
                f"/退{_fmt(c.get('bounced'))}/诉{_fmt(c.get('complained'))}"
                f"/回{_fmt(c.get('replied'))}")

    health = view.get("provider_health") or {}
    ent = view.get("entitlement") or {}
    remaining = ent.get("remaining_today")
    quota = ent.get("quota_per_day")
    quota_txt = ("未配置账号" if quota is None else f"{_fmt(ent.get('sent_today'))}/{quota}，剩 {_fmt(remaining)}")
    status = view.get("status")
    line = (f"{prefix}[{status}] FD {_ch(CHANNEL_FOUNDER_DIRECT)} | GS {_ch(CHANNEL_GROWTH_SEND)} | "
            f"退信率 {_pct(health.get('bounce_rate'))} 投诉率 {_pct(health.get('complaint_rate'))} "
            f"(样本 accepted={_fmt(health.get('accepted'))}) | 今日额度 {quota_txt}")
    gaps = view.get("gaps") or {}
    missing = [k for k, v in gaps.items()
               if isinstance(v, dict) and v.get("collected") is False]
    if missing:
        line += f" | 未采集: {','.join(sorted(missing))}"
    return line


# 语义别名：避免与 `views.metrics_view`（replay 口径）混淆时用全名导入
send_quality_view = metrics_view

__all__ = ["metrics_view", "send_quality_view", "entitlement_view", "provider_cost_view",
           "format_quality_line", "channel_of_account", "SCHEMA_VERSION",
           "CHANNEL_FOUNDER_DIRECT", "CHANNEL_GROWTH_SEND", "CHANNEL_UNATTRIBUTED",
           "CHANNELS", "METRICS"]
