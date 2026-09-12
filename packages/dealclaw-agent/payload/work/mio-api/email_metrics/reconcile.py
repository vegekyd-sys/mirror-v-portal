#!/usr/bin/env python3
"""email_metrics.reconcile — 新旧口径对账报告。

用于回答：「同一个租户，为什么旧口径给 77，新口径给 69？」

报告内容（对齐 v1 文档第 6 条）：
  - 每个指标的 旧值 / 新值 / 差异
  - **差异原因**（未计入原因逐条列出）
  - `unassigned` / `ambiguous` 清单
  - 脱敏 event/message ID（可抽查）

**只读**：不修改任何存储，不写生产。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from . import schema as S
from .pseudonym import event_key, pseudonym
from .views import DEFAULT_REPORT_TZ, metrics_view


def old_metrics(outbound_records, inbound_records=(), signals=None,
                company_id: str | None = None) -> dict:
    """**复现现有生产口径**（含已知缺陷），仅用于对账，不作为新口径。

    已知缺陷：无日期过滤（「今日」= 全量）；回复只数带商机意图的 signal。
    """
    outbounds = [r for r in (outbound_records or [])
                 if not company_id or r.get(S.F_COMPANY_ID) == company_id]
    inbounds = [r for r in (inbound_records or [])
                if not company_id or r.get(S.F_COMPANY_ID) == company_id]
    replied = 0
    if signals is not None:
        replied = len({s.get("source_message_id") for s in signals
                       if s.get("source_message_id")
                       and s.get("signal_type") in S.OPPORTUNITY_SIGNAL_TYPES})
    else:
        replied = len(inbounds)
    return {
        "sent": len(outbounds),
        "delivered": sum(1 for o in outbounds
                         if (o.get("provider_status") or "") == S.EV_DELIVERED),
        "bounced": sum(1 for o in outbounds
                       if (o.get("provider_status") or "") == S.EV_BOUNCED),
        "replied": replied,
    }


_DIFF_REASONS = {
    "sent": "新口径 = Provider accepted；无 provider id 的 legacy_unverified 不计入",
    "delivered": "旧口径是全量 provider_status；新口径按终态投影 delivered_final",
    "bounced": "旧口径是全量 provider_status；新口径按终态投影（延迟退信归位）",
    "replied": "旧口径只数带商机意图的 signal；新口径把 inbound/唯一买家/线程/商机分开报",
}


def reconcile(replay_result, *, outbound_records=(), inbound_records=(), signals=None,
              company_id: str | None = None, campaign_id: str | None = None,
              date: str | None = None, date_range=None,
              report_timezone: str = DEFAULT_REPORT_TZ,
              legacy_unverified: int = 0) -> dict:
    old = old_metrics(outbound_records, inbound_records, signals, company_id=company_id)
    new = metrics_view(replay_result, company_id=company_id, campaign_id=campaign_id,
                       date=date, date_range=date_range,
                       report_timezone=report_timezone,
                       opportunity_signals=signals,
                       legacy_unverified=legacy_unverified)

    new_map = {
        "sent": new["sent"],
        "delivered": new["delivered_final"],
        "bounced": new["bounced"],
        "replied": new["unique_repliers"],
    }
    diff = []
    for metric, old_value in old.items():
        new_value = new_map[metric]
        diff.append({
            "metric": metric,
            "old": old_value,
            "new": new_value,
            "delta": new_value - old_value,
            "reason": _DIFF_REASONS[metric] if new_value != old_value else "",
        })

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "company_id": company_id or "",
        "campaign_id": campaign_id or "",
        "report_timezone": report_timezone,
        "range": new["range"],
        "old": old,
        "new": {
            "sent": new["sent"],
            "delivered_final": new["delivered_final"],
            "delivered_ever": new["delivered_ever"],
            "bounced": new["bounced"],
            "failed": new["failed"],
            "pending": new["pending"],
            "unknown": new["unknown"],
            "legacy_unverified": new["legacy_unverified"],
            "inbound_messages": new["inbound_messages"],
            "unique_repliers": new["unique_repliers"],
            "replied_threads": new["replied_threads"],
            "confirmed_opportunity_repliers": new["confirmed_opportunity_repliers"],
        },
        "diff": diff,
        "not_counted": {
            "legacy_unverified": {
                "count": new["legacy_unverified"],
                "reason": "无 provider id，不能映射为 accepted，不计入 sent",
            },
            "pending": {
                "count": new["pending"],
                "reason": "provider accepted 但无终态事件，投递结果未知",
            },
            "unknown": {
                "count": new["unknown"],
                "reason": "没有任何投递事件的孤立消息",
            },
        },
        "unassigned": [_ref(ev) for ev in replay_result.unassigned],
        "ambiguous": [_ref(ev) for ev in replay_result.ambiguous],
        "data_completeness": new["data_completeness"],
        "evidence": new["evidence"],
    }
    return report


def _ref(ev: dict) -> dict:
    return {
        "event_id": event_key(ev.get(S.F_EVENT_ID, "")),
        "message": pseudonym("msg", ev.get(S.F_PROVIDER_RECEIVED_ID, "")
                             or ev.get(S.F_PROVIDER_MESSAGE_ID, "")),
        "occurred_at_utc": ev.get(S.F_OCCURRED_AT_UTC, ""),
        "binding_reason": ev.get(S.F_BINDING_REASON, ""),
        "campaign_id": ev.get(S.F_CAMPAIGN_ID, ""),
        "counted": False,
    }


def render_markdown(report: dict) -> str:
    """人读版对账报告。数字与 `evidence` 里的脱敏 ID 一一对应。"""
    lines = [
        "# 邮件口径对账报告（旧 vs 新）",
        "",
        f"- 生成时间：{report['generated_at']}",
        f"- 企业：`{report['company_id'] or '(未指定)'}`"
        + (f" · 批次：`{report['campaign_id']}`" if report.get("campaign_id") else ""),
        f"- 业务时区：{report['report_timezone']}"
        + (f" · 区间：{report['range']['start']} → {report['range']['end']}"
           if report["range"]["start"] else " · 区间：全部"),
        "",
        "## 指标差异",
        "",
        "| 指标 | 旧口径 | 新口径 | 差异 | 原因 |",
        "|------|-------:|-------:|-----:|------|",
    ]
    for d in report["diff"]:
        lines.append(f"| {d['metric']} | {d['old']} | {d['new']} | {d['delta']:+d} | {d['reason'] or '—'} |")

    n = report["new"]
    lines += [
        "",
        "## 新口径明细（不强制凑平）",
        "",
        f"- 发送（Provider accepted）：{n['sent']}",
        f"- 送达（delivered_final）：{n['delivered_final']}"
        f" · 历史送达过（delivered_ever）：{n['delivered_ever']}",
        f"- 退信：{n['bounced']} · 失败：{n['failed']}"
        f" · pending：{n['pending']} · unknown：{n['unknown']}",
        f"- legacy_unverified（不计入 sent）：{n['legacy_unverified']}",
        f"- 回复：inbound {n['inbound_messages']} · 唯一买家 {n['unique_repliers']}"
        f" · 线程 {n['replied_threads']} · 商机确认 {n['confirmed_opportunity_repliers']}",
        "",
        "## 未计入原因",
        "",
    ]
    for key, item in report["not_counted"].items():
        lines.append(f"- {key}：{item['count']} —— {item['reason']}")
    lines += [
        "",
        f"## 未归属 / 待确认（未匹配不丢弃、也不计入批次）",
        "",
        f"- unassigned：{len(report['unassigned'])} 条",
        f"- ambiguous：{len(report['ambiguous'])} 条",
        "",
        "## 数据完整度",
        "",
        f"```json\n{json.dumps(report['data_completeness'], ensure_ascii=False, indent=2)}\n```",
        "",
        "## 脱敏证据（抽查用）",
        "",
    ]
    ev = report["evidence"]
    for key in ("sent", "delivered_final", "bounced", "pending", "inbound_messages"):
        ids = ev.get(key) or []
        lines.append(f"- {key}（{len(ids)}）: {', '.join(ids[:10]) or '—'}"
                     + (" …" if len(ids) > 10 else ""))
    if report["unassigned"] or report["ambiguous"]:
        lines += ["", "### 未归属明细", ""]
        for item in (report["unassigned"] + report["ambiguous"])[:20]:
            lines.append(f"- {item['message']} · {item['event_id']}"
                         f" · {item['binding_reason']} · 未计入")
    return "\n".join(lines) + "\n"
