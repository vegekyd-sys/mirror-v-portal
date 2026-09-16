#!/usr/bin/env python3
"""dc_daily_brief.py — 通用 Daily Brief Engine（契约 + 纯函数，不含 Provider 业务实现）

职责边界（本阶段只落契约与纯函数，不接 Provider 业务数据、不接 LLM）：
  1. 统一 BriefItem 数据契约（kind / item_key / action_key / dedupe_key / 事实 / 证据）
  2. item_key / action_key / dedupe_key 生成（action_key 仅 action，区分触达轮次）
  3. 排序（priority 固定映射 + due_at 时区感知升序）
  4. action 去重（action_key）与展示去重（dedupe_key，逾期不吞）
  5. 早报 plan 生成（top N action）+ 晚报 review 核销（只依据真实事件）
  6. daily memory 路径安全（tenant/company 隔离）+ 原子写入
  7. Provider 异常包装（collect 抛错 → ProviderResult.errors）
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol


# ── 常量 ──────────────────────────────────────────────
KINDS = {"action", "insight", "risk", "result"}
SOURCES = {"email", "exhibition", "leads", "opportunity", "kb"}
REVIEW_STATUSES = {"done", "partial", "unresolved", "skipped", "failed"}
EVIDENCE_TYPES = {"record", "snapshot", "query"}
COMPLETION_RULE_TYPES = {
    "reply_received", "delivery_confirmed", "draft_confirmed",
    "signal_resolved", "kb_updated", "followup_sent",
    "quote_sent", "sample_sent",
}

# priority 固定排序映射（规则 5：逾期 > 买家回复 > 承诺 > 临近截止 > 高匹配）
PRIORITY_ORDER = {
    "overdue": 0,
    "buyer_reply": 1,
    "commitment": 2,
    "deadline": 3,
    "match": 4,
}


# ── 契约 dataclass ────────────────────────────────────
@dataclass
class FactRef:
    """reason_facts 事实数组元素：带 fact_id 的事实快照。"""
    fact_id: str
    kind: str            # entity / number / goal / time / text
    value: Any


@dataclass
class EvidenceRef:
    """证据引用：type=record/snapshot/query；query 可表达「已检查但字段缺失」。"""
    type: str            # record / snapshot / query
    source: str          # 数据源名（email_facts / signal / kb / lead ...）
    id: str              # 引用 id（resend_id / signal_id / lead_id / doc_token ...）
    missing: str | None = None   # query 型：查了但字段缺失时填说明


@dataclass
class TargetRef:
    """目标引用（被操作对象）。"""
    type: str            # buyer / company / campaign / kb_doc ...
    id: str


@dataclass
class CompletionRule:
    """action 的完成判定规则（晚报只依据真实事件核销）。"""
    type: str            # reply_received / delivery_confirmed / draft_confirmed / signal_resolved / kb_updated
    params: dict = field(default_factory=dict)
    expected_count: int = 1


@dataclass
class BriefItem:
    item_key: str
    kind: str                    # action / insight / risk / result
    dedupe_key: str              # 可读展示去重键
    source: str
    scope: str                   # 业务场景（campaign_id 或 "global"），每 item 可不同
    category: str
    priority: str                # overdue / buyer_reply / commitment / deadline / match（仅 action 参与排序）
    title: str
    reason_facts: list[FactRef]  # 事实数组（LLM 唯一输入，不可改实体/数字/目标）
    reason: str                  # 表达（模板渲染核心数字/实体，LLM 润色）
    target_refs: list[TargetRef]
    evidence_refs: list[EvidenceRef]
    due_at: str | None           # 仅 kind=action 强制；带时区 ISO
    detail: dict = field(default_factory=dict)
    completion_rule: CompletionRule | None = None
    action_key: str | None = None   # 仅 action 使用
    policy_version: str | None = None  # 单独保存，不参与幂等


@dataclass
class BriefContext:
    tenant: str
    company: str
    report_type: str   # morning / evening
    date: str          # YYYY-MM-DD（企业本地时区）
    tz: str            # 时区，如 Asia/Shanghai
    as_of: str         # 带时区 ISO
    window_start: str  # 带时区 ISO
    window_end: str    # 带时区 ISO


@dataclass
class ProviderResult:
    name: str
    items: list[BriefItem]
    updated_at: str
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class Provider(Protocol):
    name: str

    def collect(self, context: BriefContext) -> ProviderResult: ...


# ── key 生成 ──────────────────────────────────────────
def _hash_key(parts: list[str]) -> str:
    return hashlib.sha256(":".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:16]


def make_item_key(*, tenant: str, company: str, scope: str, kind: str,
                  source: str, category: str, business_id: str, occurrence: str) -> str:
    """所有 item 通用标识。"""
    return _hash_key([tenant, company, scope, kind, source, category,
                      business_id, occurrence])


def make_action_key(*, tenant: str, company: str, scope: str, opportunity: str,
                    action_type: str, target_id: str, occurrence: str) -> str:
    """仅 action 使用。occurrence 区分不同触达轮次；policy_version 不参与（单独保存）。"""
    return _hash_key([tenant, company, scope, opportunity, action_type,
                      target_id, occurrence])


def make_dedupe_key(*, source: str, category: str, scope: str,
                    business_id: str, occurrence: str) -> str:
    """可读展示去重键。"""
    return f"{source}:{category}:{scope}:{business_id}:{occurrence}"


def normalize_targets(target_ids: list[str]) -> str:
    """多 target 规范化：排序去重后哈希，保证同集合稳定、异集合不误撞。"""
    uniq = sorted({str(t).strip() for t in target_ids if str(t).strip()})
    return hashlib.sha256(",".join(uniq).encode("utf-8")).hexdigest()[:16]


# ── 契约校验 ──────────────────────────────────────────
def validate_brief_item(item: BriefItem) -> list[str]:
    """返回违规项列表；空列表 = 合法。"""
    errs: list[str] = []
    if item.kind not in KINDS:
        errs.append(f"kind invalid: {item.kind!r}")
    if item.source not in SOURCES:
        errs.append(f"source invalid: {item.source!r}")
    if not item.item_key:
        errs.append("item_key empty")
    if not item.dedupe_key:
        errs.append("dedupe_key empty")
    if not item.title:
        errs.append("title empty")
    if not item.reason:
        errs.append("reason empty")
    if not item.reason_facts:
        errs.append("reason_facts empty")
    if not item.evidence_refs:
        errs.append("evidence_refs empty")
    for ev in item.evidence_refs:
        if ev.type not in EVIDENCE_TYPES:
            errs.append(f"evidence type invalid: {ev.type!r}")
        if not ev.source or not ev.id:
            errs.append(f"evidence source/id empty: {ev.type!r}")
    if item.kind == "action":
        if not item.due_at:
            errs.append("action missing due_at")
        if not item.action_key:
            errs.append("action missing action_key")
        if item.completion_rule is None:
            errs.append("action missing completion_rule")
        elif item.completion_rule.type not in COMPLETION_RULE_TYPES:
            errs.append(f"completion_rule.type invalid: {item.completion_rule.type!r}")
    return errs


# ── 排序 ──────────────────────────────────────────────
def _parse_iso_to_utc(iso: str | None) -> float | None:
    """带时区 ISO 字符串 → UTC 时间戳；无时区按 UTC；解析失败返回 None。"""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


def _now_iso() -> str:
    """当前时刻 UTC ISO（带时区）。"""
    return datetime.now(timezone.utc).isoformat()


def sort_items(items: list[BriefItem]) -> list[BriefItem]:
    """排序：priority 固定映射升序，同级按 due_at 时区感知升序（None 最后）。"""
    def key(it: BriefItem):
        p = PRIORITY_ORDER.get(it.priority, 99)
        ts = _parse_iso_to_utc(it.due_at)
        return (p, ts if ts is not None else float("inf"))
    return sorted(items, key=key)


# ── 去重 ──────────────────────────────────────────────
def dedupe_actions(items: list[BriefItem]) -> list[BriefItem]:
    """action 去重：同 action_key 只保留第一个；非 action 原样保留。"""
    seen: set[str] = set()
    out: list[BriefItem] = []
    for it in items:
        if it.kind != "action":
            out.append(it)
            continue
        if it.action_key in seen:
            continue
        seen.add(it.action_key)
        out.append(it)
    return out


def dedupe_display(items: list[BriefItem], reminded_dedupe_keys: set[str]) -> list[BriefItem]:
    """展示去重：dedupe_key 已提醒且非逾期的不重复展开；逾期项即使提醒过也保留（专项卡不吞逾期）。"""
    out: list[BriefItem] = []
    for it in items:
        if it.dedupe_key in reminded_dedupe_keys and it.priority != "overdue":
            continue
        out.append(it)
    return out


# ── 早报 plan / 晚报 review ───────────────────────────
def build_plan(items: list[BriefItem], max_actions: int = 3) -> dict:
    """早报：去重+排序后取 top N action，附带 insight/risk/result 上下文。"""
    actions = [it for it in items if it.kind == "action"]
    actions = sort_items(dedupe_actions(actions))[:max_actions]
    others = [it for it in items if it.kind != "action"]
    return {
        "actions": [asdict(a) for a in actions],
        "context": [asdict(o) for o in others],
        "created_at": _now_iso(),
        "revision": 0,  # write_plan 持久化时赋实际 revision
    }


# completion_rule evaluator 注册表：未知类型返回 False（核销落 unresolved + warning）
def _eval_reply_received(rule: dict, event: dict) -> bool:
    return event.get("kind") == "reply" and event.get("resend_id") == rule.get("params", {}).get("resend_id")


def _eval_delivery_confirmed(rule: dict, event: dict) -> bool:
    return (event.get("kind") == "delivery" and event.get("status") == "delivered"
            and event.get("resend_id") == rule.get("params", {}).get("resend_id"))


def _eval_draft_confirmed(rule: dict, event: dict) -> bool:
    return (event.get("kind") == "draft" and event.get("status") == "confirmed"
            and event.get("draft_id") == rule.get("params", {}).get("draft_id"))


def _eval_signal_resolved(rule: dict, event: dict) -> bool:
    return (event.get("kind") == "signal" and event.get("status") == "resolved"
            and event.get("signal_id") == rule.get("params", {}).get("signal_id"))


def _eval_kb_updated(rule: dict, event: dict) -> bool:
    return event.get("kind") == "kb" and event.get("doc_token") == rule.get("params", {}).get("doc_token")


def _eval_followup_sent(rule: dict, event: dict) -> bool:
    return event.get("kind") == "followup_sent"


def _eval_quote_sent(rule: dict, event: dict) -> bool:
    return event.get("kind") == "quote_sent"


def _eval_sample_sent(rule: dict, event: dict) -> bool:
    return event.get("kind") == "sample_sent"


EVALUATORS = {
    "reply_received": _eval_reply_received,
    "delivery_confirmed": _eval_delivery_confirmed,
    "draft_confirmed": _eval_draft_confirmed,
    "signal_resolved": _eval_signal_resolved,
    "kb_updated": _eval_kb_updated,
    "followup_sent": _eval_followup_sent,
    "quote_sent": _eval_quote_sent,
    "sample_sent": _eval_sample_sent,
}


def _event_key(event: dict) -> str:
    """事件稳定标识（去重计数用）。优先 event_id，否则按关键字段归一。"""
    eid = event.get("event_id")
    if eid:
        return f"id:{eid}"
    return "auto:" + json.dumps(
        (event.get("kind"), event.get("resend_id"), event.get("status"),
         event.get("draft_id"), event.get("signal_id"), event.get("doc_token")),
        sort_keys=True, default=str)


def _dedupe_events(events: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for e in events:
        k = _event_key(e)
        if k in seen:
            continue
        seen.add(k)
        out.append(e)
    return out


def _filter_stale_events(events: list[dict], plan_ts: float) -> list[dict]:
    """过滤早于 plan.created_at 的旧事件（旧事件不能核销新计划）。"""
    out = []
    for e in events:
        ts = _parse_iso_to_utc(e.get("occurred_at"))
        if ts is not None and ts < plan_ts:
            continue
        out.append(e)
    return out


def review_plan(plan: dict, events: list[dict]) -> dict:
    """晚报：逐项核销早报 action，只依据真实事件。

    - 事件按 event_key 去重，避免重复计数；
    - 只统计 plan.created_at 之后的事件（旧事件不能核销新计划）；
    - completion_rule.type 未知 → unresolved + warning。
    """
    plan_ts = _parse_iso_to_utc(plan.get("created_at"))
    events = _dedupe_events(events)
    if plan_ts is not None:
        events = _filter_stale_events(events, plan_ts)

    reviews = []
    warnings = []
    for action in plan.get("actions", []):
        akey = action.get("action_key")
        rule = action.get("completion_rule") or {}
        if rule.get("type") not in EVALUATORS:
            reviews.append({"action_key": akey, "status": "unresolved"})
            warnings.append(f"unknown completion_rule.type {rule.get('type')!r} for {akey}")
            continue
        aevents = [e for e in events if e.get("action_key") == akey]
        reviews.append({
            "action_key": akey,
            "status": _review_status(action, aevents),
        })
    return {"reviews": reviews, "warnings": warnings}


def _review_status(action: dict, events: list[dict]) -> str:
    rule = action.get("completion_rule") or {}
    evaluator = EVALUATORS.get(rule.get("type"))
    if evaluator is None:
        return "unresolved"
    expected = int(rule.get("expected_count", 1) or 1)
    done_count = sum(1 for e in events if evaluator(rule, e))
    if done_count >= expected:
        return "done"
    if done_count > 0:
        return "partial"
    if any(e.get("status") == "failed" for e in events):
        return "failed"
    if any(e.get("status") == "skipped" for e in events):
        return "skipped"
    return "unresolved"


# ── daily memory 路径安全 + 原子写入 ───────────────────
def safe_memory_dir(base: Path, tenant: str, company: str, date: str) -> Path:
    """构造 memory/daily/<tenant>/<company>/<date>/，防路径穿越与非法日期。"""
    for name, val in (("tenant", tenant), ("company", company), ("date", date)):
        if not val or val in (".", ".."):
            raise ValueError(f"invalid {name}: {val!r}")
        if "/" in val or "\\" in val or "\x00" in val:
            raise ValueError(f"invalid {name}: {val!r}")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError(f"invalid date: {date!r}")
    return base / tenant / company / date


def atomic_write_json(path: Path, data: dict) -> None:
    """原子写 JSON：临时文件 + os.replace，避免半写。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def next_revision(existing_plan: dict | None) -> int:
    """返回下一个 revision：首次 1，否则旧 revision + 1。"""
    if existing_plan and existing_plan.get("revision"):
        return int(existing_plan["revision"]) + 1
    return 1


def write_plan(path: Path, plan: dict, existing_plan: dict | None = None) -> dict:
    """持久化 plan 并赋 revision。已有 plan 时 revision 递增，不静默覆盖历史。"""
    plan = dict(plan)
    plan["revision"] = next_revision(existing_plan)
    atomic_write_json(path, plan)
    return plan


# ── 回信采购意图（2026-09-16 客户口径）──────────────────────
# 早晚报必须**推理**并列出两类回信，两类都不允许省：「有明确采购意图」/「已回信但未识别出
# 采购意图」。谁也不能只列一类——只列前者等于把“分类器没命中的真买家”静默丢掉。
PURCHASE_INTENT_SIGNALS = ("quote_request", "sample_request", "meeting_interest", "missing_info")
SIGNAL_LABELS = {
    "quote_request": "询价/报价请求",
    "sample_request": "样品请求",
    "meeting_interest": "见面/到展意向",
    "missing_info": "索要资料（我方缺字段）",
}
REPLY_SECTION_TITLE = "【回信采购意图】"
REPLY_LIST_LIMIT = 20


def _one_line(text: Any, limit: int = 160) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()[:limit]


def _signal_reason(signals: list[dict]) -> str:
    """判断理由：引用命中的信号与关键词（不编词、只用证据字段）。"""
    parts: list[str] = []
    for s in signals:
        if not isinstance(s, dict):
            continue
        label = SIGNAL_LABELS.get(str(s.get("signal_type") or ""), str(s.get("signal_type") or ""))
        ev = s.get("evidence") if isinstance(s.get("evidence"), dict) else {}
        terms = [str(t) for t in (ev.get("matched_terms") or []) if str(t).strip()]
        missing = [str(t) for t in (ev.get("missing_fields") or []) if str(t).strip()]
        if terms:
            label = f"{label}（关键词：{'、'.join(terms[:5])}）"
        elif missing:
            label = f"{label}（缺字段：{'、'.join(missing[:5])}）"
        parts.append(label)
    return "；".join(parts)


def classify_reply_purchase_intent(replies: list[dict], *,
                                   limit: int = REPLY_LIST_LIMIT) -> dict:
    """纯函数：按「信」判定采购意图，产出两类清单（两类都不许省）。

    replies 元素（字段可缺，缺按缺处理）：message_id / sender / sender_name /
    company_name / subject / excerpt（或 text）/ received_at / signals=[{signal_type, evidence}]。
    返回 ``{with_intent, without_intent, counts, limit}``；只做判定与整理，不发消息、不写数据。
    """
    with_intent: list[dict] = []
    without_intent: list[dict] = []
    for r in replies or []:
        if not isinstance(r, dict):
            continue
        signals = [s for s in (r.get("signals") or []) if isinstance(s, dict)]
        hit = [s for s in signals
               if str(s.get("signal_type") or "") in PURCHASE_INTENT_SIGNALS]
        row = {
            "message_id": str(r.get("message_id") or ""),
            "sender": str(r.get("sender") or ""),
            "sender_name": str(r.get("sender_name") or ""),
            "company_name": str(r.get("company_name") or ""),
            "subject": _one_line(r.get("subject"), 80),
            "excerpt": _one_line(r.get("excerpt") if r.get("excerpt") else r.get("text")),
            "received_at": str(r.get("received_at") or ""),
        }
        if hit:
            row["signals"] = sorted({str(s.get("signal_type")) for s in hit})
            row["reason"] = _signal_reason(hit)
            with_intent.append(row)
        else:
            row["signals"] = sorted({str(s.get("signal_type")) for s in signals})
            row["reason"] = (f"只命中了非采购类信号：{_signal_reason(signals)}"
                              if signals else "未命中任何采购信号")
            without_intent.append(row)
    key = lambda x: x.get("received_at") or ""
    with_intent.sort(key=key, reverse=True)
    without_intent.sort(key=key, reverse=True)
    return {
        "with_intent": with_intent,
        "without_intent": without_intent,
        "counts": {"with_intent": len(with_intent), "without_intent": len(without_intent),
                   "total": len(with_intent) + len(without_intent)},
        "limit": limit,
    }


def _reply_row_line(row: dict, *, manual: bool = False) -> str:
    who = row.get("company_name") or row.get("sender_name") or row.get("sender") or "未知买家"
    if row.get("sender") and row.get("sender") not in who:
        who = f"{who}（{row['sender']}）"
    bits = [who]
    if row.get("excerpt"):
        bits.append(f"原文：{row['excerpt']}")
    bits.append(f"依据：{row.get('reason') or ''}")
    if manual:
        bits.append("需人工判断是否回复")
    return " · ".join(bits)


def render_reply_intent_section(classified: dict, *, title: str = REPLY_SECTION_TITLE) -> str:
    """渲染回信采购意图段：两类标题与计数**无条件出现**（空就写「无」）。"""
    c = classified or {}
    wi = list(c.get("with_intent") or [])
    wo = list(c.get("without_intent") or [])
    try:
        limit = int(c.get("limit") or REPLY_LIST_LIMIT)
    except (TypeError, ValueError):
        limit = REPLY_LIST_LIMIT
    lines = [title, f"■ 有明确采购意图（{len(wi)} 封）"]
    if wi:
        lines += [f"  · {_reply_row_line(row)}" for row in wi[:limit]]
        if len(wi) > limit:
            lines.append(f"  · （另有 {len(wi) - limit} 封未展开）")
    else:
        lines.append("  · 无")
    lines.append(f"■ 已回信但未识别出采购意图（{len(wo)} 封）")
    if wo:
        lines += [f"  · {_reply_row_line(row, manual=True)}" for row in wo[:limit]]
        if len(wo) > limit:
            lines.append(f"  · （另有 {len(wo) - limit} 封未展开）")
    else:
        lines.append("  · 无")
    return "\n".join(lines)


# ── Provider 异常包装 ─────────────────────────────────
def safe_collect(provider: Provider, context: BriefContext) -> ProviderResult:
    """包装 Provider.collect：抛错 → errors，不崩。"""
    try:
        return provider.collect(context)
    except Exception as e:  # noqa: BLE001
        return ProviderResult(
            name=getattr(provider, "name", "?"),
            items=[],
            updated_at="",
            warnings=[],
            errors=[f"{type(e).__name__}: {e}"],
        )
