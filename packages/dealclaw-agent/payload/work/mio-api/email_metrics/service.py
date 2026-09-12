#!/usr/bin/env python3
"""email_metrics.service — 统一读入口（早晚报 / EmailProvider / 看板都走这里）。

口径由 `email_metrics.config` 决定，默认 `legacy`（线上行为不变）：

| 模式 | 用户可见 | v1 是否计算 | 差异处理 |
|------|----------|-------------|----------|
| `legacy` | 旧口径（字段名兼容修复 + 业务时区「今日」） | 否 | — |
| `shadow` | **同 legacy**（不改变用户可见输出） | 是 | 只记录差异（日志 + JSONL 落盘） |
| `v1` | `metrics_view`（唯一口径） | 是 | — |

v1 异常 / 数据不完整时的硬规则（对齐 v1 文档第 3、4 条）：
  - **不得返回假 0**：读不到数据源 → `status="unavailable"`，数字为 `None`（不是 0）；
  - 数据有已知缺口（未同步 / 缺 accepted / 无法确认的旧记录）→ `status="partial"`，
    数字仍在结构化返回里，但必须带 `reasons` 与可下钻 `evidence`（未归属 / 待确认清单）。

消费方降级（阶段 D2 第 2 条）：`partial` / `unavailable` 时，EmailProvider 与早晚报
渲染**隐藏邮件数字**（不得显示 0，显示「邮件数据暂不可用（原因）」），其余可信板块
（展会战报 / 今日会谈 / 其他 Provider）照常展示；同时在 context/plan 里带一个结构化
`data_quality_alert` 对象供运营侧消费——**只产出对象，不发送任何消息**。

D5 验收口径（仅口径声明，见 `docs/email-metrics-v1.md`）：
  - **未解释差异 = 0**；不要求新旧数字完全相同（差异只要能被 `reasons` 解释即可）；
  - 第一周指标用「已知异常发现率 / 问题可复现率 / 已确认代码 Bug 回归覆盖率」，
    不用「系统先发现 > 50%」这种无法证伪的说法。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from . import schema as S
from .adapter import adapt_all
from .config import (MODE_LEGACY, MODE_SHADOW, MODE_V1, SHADOW_DIR_ENV,
                     resolve_mode, resolve_report_timezone)
from .facts import replay, reply_links
from .legacy import legacy_metrics, normalize_range
from .pseudonym import event_key, pseudonym
from .views import metrics_view

logger = logging.getLogger(__name__)

STATUS_OK = "ok"
STATUS_PARTIAL = "partial"
STATUS_UNAVAILABLE = "unavailable"

_METRIC_KEYS = ("sent", "delivered", "bounced", "replied")

# 邮件数字不可信时展示的固定口径文案（隐藏数字，不隐藏原因）
HIDDEN_METRICS_HINT = "邮件数据暂不可用"

# 结构化告警对象名（运营侧按 object 字段路由，不依赖中文文案）
DATA_QUALITY_ALERT_OBJECT = "data_quality_alert"

_DIFF_REASONS = {
    "sent": "新口径 = Provider accepted（拿不到 provider 受理 id 的不计入）；旧口径 = outbound 记录条数",
    "delivered": "新口径 = 终态投影 delivered_final（延迟退信会翻）；旧口径 = provider_status 快照",
    "bounced": "新口径 = 终态投影（乱序/重复 webhook 归位）；旧口径 = provider_status 快照",
    "replied": "新口径 = 唯一回复买家（inbound/线程/商机分开报）；旧口径 = 入站消息数或信号数",
}


def _default_store():
    from email_gateway.store import EmailStore
    return EmailStore()


def _data_dir() -> Path:
    return Path(os.environ.get(
        "DC_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))


# ── shadow 落盘路径（按租户/企业隔离）────────────────────
_UNSAFE_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")
_GLOBAL_SEGMENT = "_global"


def safe_path_segment(value: str | None) -> str:
    """把 tenant/company 归一成**文件名安全**的一段，缺失/全非法 → `_global`。

    中文租户名、带 `/` 或空格的 id 都不能原样进路径（会跨目录或建出怪目录）。
    """
    s = _UNSAFE_SEGMENT.sub("_", str(value or "").strip()).strip("._-")
    return s[:64] or _GLOBAL_SEGMENT


def _shadow_dir(tenant: str | None = None, company_id: str | None = None) -> Path:
    """`<root>/<tenant>/<company>`；root 默认 `DC_DATA_DIR/email-metrics-shadow`。

    租户/企业分目录，避免多租户影子差异混在同一个文件里串数据。
    """
    env = (os.environ.get(SHADOW_DIR_ENV) or "").strip()
    root = Path(env) if env else _data_dir() / "email-metrics-shadow"
    return root / safe_path_segment(tenant) / safe_path_segment(company_id)


def _record_event_time(rec) -> str:
    """记录里可用的事件时间（用于算 source watermark 的最大事件时间）。"""
    for key in ("occurred_at_utc", "occurred_at", "sent_at", "received_at",
                "created_at", "timestamp"):
        v = (rec or {}).get(key)
        if v:
            return str(v)
    return ""


def stream_watermark(records: list | None) -> dict:
    """单流（outbound / inbound）水位：条数 + 最大事件时间 + 无时间记录数。"""
    recs = list(records or [])
    times = [t for t in (_record_event_time(r) for r in recs) if t]
    return {
        "count": len(recs),
        "max_event_time": max(times) if times else "",
        "without_time": len(recs) - len(times),
    }


def snapshot_hash(*, company_id: str, outbound_records: list | None,
                  inbound_records: list | None) -> str:
    """对「这一轮参与计算的输入快照」算 sha256（`sha256:<hex>`）。

    同一批输入 → 同一 hash（记录先规范化排序，与读表顺序无关），
    便于事后回答「这条差异是对着哪份输入算出来的」。
    """
    def _canon(recs) -> list:
        return sorted(json.dumps(r, sort_keys=True, ensure_ascii=False, default=str)
                      for r in (recs or []))

    blob = json.dumps({
        "company_id": company_id,
        "outbound": _canon(outbound_records),
        "inbound": _canon(inbound_records),
    }, sort_keys=True, ensure_ascii=False)
    return "sha256:" + hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ── 数据源 ──────────────────────────────────────────────
def load_source_records(*, company_id, store=None, outbound_records=None,
                        inbound_records=None) -> tuple[list, list, str]:
    """读原始记录。返回 (outbounds, inbounds, error)；error 非空 = 数据源不可用。"""
    out, inb = outbound_records, inbound_records
    if out is not None and inb is not None:
        return list(out), list(inb), ""
    try:
        s = store if store is not None else _default_store()
        if out is None:
            out = list(s.list_outbound_records(company_id=company_id) or [])
        if inb is None:
            inb = list(s.list_inbound_records(company_id=company_id) or [])
    except Exception as e:  # noqa: BLE001 — 数据源不可用必须显式上报，不能静默当 0
        logger.warning("[email_metrics] 邮件数据源读取失败：%s: %s", type(e).__name__, e)
        return list(out or []), list(inb or []), f"{type(e).__name__}: {e}"
    return list(out), list(inb), ""


# ── v1 可用性 ───────────────────────────────────────────
def v1_availability(v1: dict) -> tuple[str, list[str]]:
    """v1 数字的完整度判定：ok / partial（+原因清单）。"""
    reasons: list[str] = []
    c = dict(v1.get("data_completeness") or {})
    if c.get("partial"):
        reasons.append("partial_sync")
    missing = int(c.get("messages_missing_accepted") or 0)
    if missing:
        reasons.append(f"messages_missing_accepted:{missing}")
    unverified = int(v1.get("legacy_unverified") or 0)
    if unverified:
        reasons.append(f"legacy_unverified:{unverified}")
    unknown = int(c.get("unknown_events") or 0)
    if unknown:
        reasons.append(f"unknown_events:{unknown}")
    if not reasons and c.get("messages_accepted") in (0, None) \
            and int(v1.get("sent") or 0) == 0 and int(v1.get("inbound_messages") or 0) == 0:
        reasons.append("empty_source")
    return (STATUS_PARTIAL if reasons else STATUS_OK), reasons


def _evidence_unassigned(replay_result) -> list[dict]:
    """未归属 / 待确认回复的脱敏证据（可下钻，不含正文与邮箱）。"""
    out = []
    for ev in list(getattr(replay_result, "unassigned", []) or [])[:50]:
        out.append({
            "event_id": event_key(ev.get(S.F_EVENT_ID, "")),
            "message": pseudonym("msg", ev.get(S.F_PROVIDER_RECEIVED_ID, "")
                                 or ev.get(S.F_PROVIDER_MESSAGE_ID, "")),
            "occurred_at_utc": ev.get(S.F_OCCURRED_AT_UTC, ""),
            "binding_status": ev.get(S.F_BINDING_STATUS, ""),
            "binding_reason": ev.get(S.F_BINDING_REASON, ""),
            "campaign_id": ev.get(S.F_CAMPAIGN_ID, ""),
            "counted": False,
        })
    for ev in list(getattr(replay_result, "ambiguous", []) or [])[:50]:
        out.append({
            "event_id": event_key(ev.get(S.F_EVENT_ID, "")),
            "message": pseudonym("msg", ev.get(S.F_PROVIDER_RECEIVED_ID, "")
                                 or ev.get(S.F_PROVIDER_MESSAGE_ID, "")),
            "occurred_at_utc": ev.get(S.F_OCCURRED_AT_UTC, ""),
            "binding_status": S.BINDING_AMBIGUOUS,
            "binding_reason": ev.get(S.F_BINDING_REASON, ""),
            "campaign_id": ev.get(S.F_CAMPAIGN_ID, ""),
            "counted": False,
        })
    return out


def _v1_replied_ids(replay_result) -> set[str]:
    """v1 口径下「已被人工回复」的出站定位键（供待跟进过滤）。"""
    ids: set[str] = set()
    for key, evs in reply_links(replay_result).items():
        if any(not ev.get("auto_reply") for ev in evs):
            st = replay_result.messages.get(key)
            ids.add(key)
            if st is not None:
                if st.smtp_message_id:
                    ids.add(st.smtp_message_id)
                if st.thread_id:
                    ids.add(st.thread_id)
    ids.discard("")
    return ids


# ── shadow 差异记录 ─────────────────────────────────────
def build_shadow_diff(legacy_view: dict, v1_view: dict, *, v1_status: str,
                      reasons: list[str]) -> list[dict]:
    diff = []
    for metric in _METRIC_KEYS:
        old, new = legacy_view.get(metric), v1_view.get(metric)
        diff.append({
            "metric": metric,
            "legacy": old,
            "v1": new,
            "delta": (None if old is None or new is None else new - old),
            "reason": _DIFF_REASONS[metric] if old != new else "",
        })
    diff.append({"metric": "v1_status", "legacy": STATUS_OK, "v1": v1_status,
                 "delta": None, "reason": ",".join(reasons)})
    return diff


def record_shadow(payload: dict, *, tz: str, tenant: str | None = None,
                  company_id: str | None = None) -> dict:
    """shadow 差异落盘（JSONL，按业务日切分）。失败绝不影响调用方。

    路径：`DC_DATA_DIR/email-metrics-shadow/<tenant>/<company>/<YYYY-MM-DD>.jsonl`。
    """
    try:
        from .legacy import business_date
        day = business_date(datetime.now(timezone.utc).isoformat(), tz) or "unknown"
        d = _shadow_dir(tenant, company_id)
        d.mkdir(parents=True, exist_ok=True)
        path = d / f"{safe_path_segment(day)}.jsonl"
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        mismatched = [x["metric"] for x in payload.get("diff", [])
                      if x.get("reason") and x["metric"] in _METRIC_KEYS]
        logger.info("[email_metrics.shadow] consumer=%s company=%s 差异指标=%s v1=%s → %s",
                    payload.get("consumer", ""), payload.get("company_id", ""),
                    mismatched or "无", payload.get("v1_status", ""), path)
        return {"recorded": True, "path": str(path)}
    except Exception as e:  # noqa: BLE001
        logger.warning("[email_metrics.shadow] 差异落盘失败（不影响输出）：%s: %s",
                       type(e).__name__, e)
        return {"recorded": False, "error": f"{type(e).__name__}: {e}"}


# ── 统一读入口 ──────────────────────────────────────────
def read_email_metrics(*, company_id: str, tenant: str | None = None,
                       campaign_id: str | None = None, date: str | None = None,
                       date_range=None, report_timezone: str | None = None,
                       store=None, outbound_records=None, inbound_records=None,
                       opportunity_signals=None, leads=None, legacy_replied: int | None = None,
                       consumer: str = "", record_shadow_diff: bool = True) -> dict:
    """按当前口径返回邮件指标（唯一读入口）。

    返回结构（关键字段）：
      mode / status / reasons / metrics（visible 口径的数字）/ report_timezone / range
      legacy / v1  两套口径明细（v1 未启用时为 None）
      availability  partial|unavailable 的下钻证据（未归属、待确认、完整度）
      replied_outbound_ids / unassigned_*  供「已回复不入待跟进」等消费方使用
    """
    mode = resolve_mode(tenant, company_id)
    tz = report_timezone or resolve_report_timezone(tenant)
    start, end = normalize_range(date, date_range)

    out_records, in_records, source_error = load_source_records(
        company_id=company_id, store=store, outbound_records=outbound_records,
        inbound_records=inbound_records)

    base = {
        "mode": mode,
        "consumer": consumer,
        "company_id": company_id,
        "campaign_id": campaign_id or "",
        "report_timezone": tz,
        "range": {"start": start, "end": end},
        "legacy": None,
        "v1": None,
        "v1_status": None,
        "v1_reasons": [],
        "unassigned": [],
        "unassigned_count": 0,
        "shadow": {"recorded": False},
    }

    if source_error:
        base.update({
            "status": STATUS_UNAVAILABLE,
            "reasons": [f"source_unavailable:{source_error}"],
            "metrics": {k: None for k in _METRIC_KEYS},
            "availability": {"status": STATUS_UNAVAILABLE, "error": source_error,
                             "evidence": [], "unassigned": [], "ambiguous": []},
            "replied_outbound_ids": [],
            "unassigned_inbound": None,
            "auto_replies": None,
        })
        base["data_quality_alert"] = build_data_quality_alert(base, consumer=consumer)
        return base

    legacy = legacy_metrics(out_records, in_records, company_id=company_id,
                            campaign_id=campaign_id, date=date, date_range=date_range, tz=tz)
    legacy_view = {
        "sent": legacy["sent"],
        "delivered": legacy["delivered"],
        "bounced": legacy["bounced"],
        # 旧口径的 replied 由消费方给出（看板=/信号数，Provider=入站数），缺省取入站消息数
        "replied": legacy["inbound_messages"] if legacy_replied is None else int(legacy_replied),
        "pending": legacy["pending"],
        "failed": legacy["failed"],
        "inbound_messages": legacy["inbound_messages"],
        "reply_messages": legacy["reply_messages"],
        "unique_repliers": legacy["unique_repliers"],
    }
    base["legacy"] = legacy_view
    base["unassigned_count"] = legacy["unassigned_inbound"]

    v1_view = None
    v1_status = None
    v1_reasons: list[str] = []
    unassigned_evidence: list[dict] = []
    rejected_ids = set(legacy["replied_outbound_ids"])

    if mode in (MODE_SHADOW, MODE_V1):
        try:
            adapted = adapt_all(out_records, in_records)
            replay_result = replay(adapted["events"])
            v1_raw = metrics_view(
                replay_result, company_id=company_id, campaign_id=campaign_id,
                date=date, date_range=date_range, report_timezone=tz,
                opportunity_signals=opportunity_signals,
                legacy_unverified=adapted["stats"]["legacy_unverified"],
                leads=leads,
            )
            v1_status, v1_reasons = v1_availability(v1_raw)
            v1_view = {
                "sent": v1_raw["sent"],
                "delivered": v1_raw["delivered_final"],
                "bounced": v1_raw["bounced"],
                "replied": v1_raw["unique_repliers"],
                "delivered_ever": v1_raw["delivered_ever"],
                "failed": v1_raw["failed"],
                "pending": v1_raw["pending"],
                "unknown": v1_raw["unknown"],
                "legacy_unverified": v1_raw["legacy_unverified"],
                "inbound_messages": v1_raw["inbound_messages"],
                "unique_repliers": v1_raw["unique_repliers"],
                "replied_threads": v1_raw["replied_threads"],
                "confirmed_opportunity_repliers": v1_raw["confirmed_opportunity_repliers"],
                "followup": v1_raw["followup"],
            }
            unassigned_evidence = _evidence_unassigned(replay_result)
            v1_replied = _v1_replied_ids(replay_result)
            if mode == MODE_V1:
                rejected_ids = set(v1_replied)
            else:
                rejected_ids = set(rejected_ids) | v1_replied
            base.update({
                "v1": v1_view,
                "v1_status": v1_status,
                "v1_reasons": v1_reasons,
                "v1_completeness": dict(v1_raw.get("data_completeness") or {}),
                "v1_evidence": dict(v1_raw.get("evidence") or {}),
                "adapted_stats": adapted["stats"],
                "unassigned": unassigned_evidence,
                "unassigned_count": int(
                    (v1_raw.get("data_completeness") or {}).get("inbound_unassigned") or 0),
            })
        except Exception as e:  # noqa: BLE001 — v1 异常上报，绝不静默变 0
            v1_status = STATUS_UNAVAILABLE
            v1_reasons = [f"v1_error:{type(e).__name__}: {e}"]
            logger.error("[email_metrics] v1 口径计算失败：%s: %s", type(e).__name__, e)
            base.update({"v1_status": v1_status, "v1_reasons": v1_reasons,
                         "unassigned": [], "unassigned_count": 0})

    # 用户可见口径
    if mode == MODE_V1:
        if v1_view is None:
            base.update({
                "status": STATUS_UNAVAILABLE,
                "reasons": v1_reasons or ["v1_unavailable"],
                "metrics": {k: None for k in _METRIC_KEYS},
            })
        else:
            base.update({
                "status": v1_status,
                "reasons": v1_reasons,
                "metrics": {k: v1_view[k] for k in _METRIC_KEYS},
            })
    else:
        base.update({
            "status": STATUS_OK,
            "reasons": [],
            "metrics": {k: legacy_view[k] for k in _METRIC_KEYS},
            "v1_status": v1_status,
        })

    base["replied_outbound_ids"] = sorted(rejected_ids)
    base["unassigned_inbound"] = legacy["unassigned_inbound"]
    base["auto_replies"] = legacy["auto_replies"]
    base["availability"] = {
        "status": base["status"],
        "v1_status": v1_status,
        "reasons": list(base["reasons"]),
        "legacy": {"sent": legacy_view["sent"], "delivered": legacy_view["delivered"],
                   "bounced": legacy_view["bounced"], "replied": legacy_view["replied"],
                   "inbound_messages": legacy_view["inbound_messages"],
                   "reply_messages": legacy_view["reply_messages"],
                   "unique_repliers": legacy_view["unique_repliers"],
                   "unassigned_inbound": legacy["unassigned_inbound"],
                   "auto_replies": legacy["auto_replies"]},
        "evidence": {
            "legacy_unassigned": [
                {"message": pseudonym("msg", ib.get("message_id")
                                      or ib.get("resend_received_id") or ib.get("resend_id") or ""),
                 "occurred_at_utc": ib.get("received_at") or ib.get("created_at") or "",
                 "binding_reason": "legacy_no_reference", "counted": False}
                for ib in (legacy.get("_unassigned") or [])[:50]],
            "v1_unassigned_ambiguous": unassigned_evidence,
        },
    }

    if mode == MODE_SHADOW and record_shadow_diff and v1_view is not None:
        payload = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "consumer": consumer,
            "company_id": company_id,
            "tenant": tenant or "",
            "campaign_id": campaign_id or "",
            "report_timezone": tz,
            "range": {"start": start, "end": end},
            "mode": mode,
            "v1_status": v1_status,
            "v1_reasons": v1_reasons,
            "reasons": list(v1_reasons),
            # 输入快照指纹 + 数据水位：事后可回答「这条差异对着哪份输入算的」
            "snapshot_hash": snapshot_hash(company_id=company_id,
                                           outbound_records=out_records,
                                           inbound_records=in_records),
            "watermark": {
                "outbound": stream_watermark(out_records),
                "inbound": stream_watermark(in_records),
            },
            "legacy": legacy_view,
            "v1": v1_view,
            "completeness": base.get("v1_completeness", {}),
            "diff": build_shadow_diff(legacy_view, v1_view, v1_status=v1_status or STATUS_OK,
                                      reasons=v1_reasons),
        }
        base["shadow"] = record_shadow(payload, tz=tz, tenant=tenant, company_id=company_id)
        base["shadow"]["diff"] = payload["diff"]
        base["shadow"]["snapshot_hash"] = payload["snapshot_hash"]
    # 结构化数据质量告警（partial/unavailable 才有；只产出对象，不发送）
    base["data_quality_alert"] = build_data_quality_alert(base, consumer=consumer)
    return base


def metrics_hidden_hint(reasons: list[str] | None = None) -> str:
    """隐藏数字时的统文案：「邮件数据暂不可用（原因）」。"""
    text = "，".join(str(r) for r in (reasons or []) if str(r).strip()) or "数据不完整"
    return f"{HIDDEN_METRICS_HINT}（{text}）"


def build_data_quality_alert(metrics: dict, *, consumer: str = "") -> dict | None:
    """构造结构化数据质量告警对象（仅当邮件数字为 partial / unavailable 时）。

    返回 None = 数字可信，无需告警。

    **只产出对象，不发送任何消息**：本函数无 IO、无网络、无飞书写接口；
    调用方把它放进 context/plan，由运营侧自行消费（`auto_send=True` 永远是 False）。
    """
    status = metrics.get("status")
    if status not in (STATUS_PARTIAL, STATUS_UNAVAILABLE):
        return None
    reasons = [str(r) for r in (metrics.get("reasons") or [])]
    availability = dict(metrics.get("availability") or {})
    rng = dict(metrics.get("range") or {})
    return {
        "object": DATA_QUALITY_ALERT_OBJECT,
        "id": "email_metrics:%s:%s:%s" % (status, metrics.get("company_id", ""),
                                           rng.get("start") or ""),
        "scope": "email_metrics",
        "severity": "error" if status == STATUS_UNAVAILABLE else "warning",
        "status": status,
        "reason_code": ("email_metrics_unavailable" if status == STATUS_UNAVAILABLE
                        else "email_metrics_partial"),
        "reasons": reasons,
        "message": metrics_hidden_hint(reasons),
        "numbers_hidden": True,
        "hidden_fields": list(_METRIC_KEYS),
        "affected_renders": ["email_provider", "daily_brief", "daily_report"],
        "unaffected": ["opportunity", "exhibition"],
        "mode": metrics.get("mode"),
        "report_timezone": metrics.get("report_timezone"),
        "range": {"start": rng.get("start", ""), "end": rng.get("end", "")},
        "consumer": consumer or metrics.get("consumer", ""),
        "drilldown": {
            "source_error": availability.get("error", ""),
            "evidence": (availability.get("evidence") or {}),
            "v1_evidence": (metrics.get("v1_evidence") or {}),
        },
        "emitted_at": datetime.now(timezone.utc).isoformat(),
        "auto_send": False,
        "read_only": True,
    }


def format_metrics_line(m: dict, *, prefix: str = "") -> str:
    """把指标渲染成一行；邮件数字不可信时**既不显示 0，也不显示任何邮件数字**。

    partial / unavailable 一律隐藏数字并给原因：不可信的数字比没有数字更危险
    （运营会拿它去决策）。数字仍在结构化返回 `metrics` 里，只是不进人读渲染。
    """
    metrics = m.get("metrics") or {}
    status = m.get("status")
    if status in (STATUS_PARTIAL, STATUS_UNAVAILABLE) or metrics.get("sent") is None:
        return f"{prefix}{metrics_hidden_hint(list(m.get('reasons') or []))}"
    line = (f"{prefix}发送 {metrics.get('sent')} · 送达 {metrics.get('delivered')} · "
            f"回复 {metrics.get('replied')} · 退信 {metrics.get('bounced')}")
    return line
