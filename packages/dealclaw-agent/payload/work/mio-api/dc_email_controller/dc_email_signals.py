#!/usr/bin/env python3
"""
dc_email_signals.py — 七信号标准化与 Markdown 持久化（P0-E2）

职责（只生成、持久化、查询信号，不执行任何外部动作）：
  1. 接收结构化邮件事实（delivery 事件 / 回复正文 + IQ intent）。
  2. 标准化为七信号：delivered / bounced / quote_request / sample_request /
     meeting_interest / missing_info / no_reply_due。
  3. Markdown 持久化（by-id 唯一事实源 + history 审计 + 记录级 flock）。
  4. 幂等去重（稳定 signal_id 可重建）。
  5. 查询 active/resolved/suppressed 信号。
  6. 计算 no_reply_due（不执行跟进、不发送）。

禁止：Agent Push / 飞书通知 / 自动回复 / 自动跟进 / 改线索 / 改绑定 / 改 Cron。
不存 open_id、不存通知目标、不把 signal 当 action 执行。
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── 数据目录 ────────────────────────────────────────────────
_DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
ROOT = _DATA_DIR / "email-signals"
BY_ID = ROOT / "by-id"
HISTORY = ROOT / "history"
LOCKS = ROOT / "locks"

EXTRACTOR_VERSION = "p0-e2-v1"
SNAPSHOT_HEADER = "# DealClaw Email Signal"

# 默认跟进天数（fallback，策略不写死在模块里）
DEFAULT_DUE_DAYS = int(os.environ.get("DC_NO_REPLY_DUE_DAYS", "3"))

# ── 过滤：这些 intent 不产生机会信号 ──
BLOCKED_INTENTS = {"自动回复", "拒绝"}

# ── 术语 ───────────────────────────────────────────────────
_QUOTE_TERMS = ["quote", "quotation", "pricing", "price", "moq", "unit price",
                "payment terms", "delivery time", "报价", "价格", "单价", "交期",
                "付款条款", "最小起订量",
                # 西语 / 葡语价格词
                "precio", "precios", "cotización", "cotizacion", "cotação",
                "preço", "preços", "costo", "costos", "custo", "fob", "oem"]
_SAMPLE_TERMS = ["sample", "samples", "trial piece", "prototype", "样品", "样",
                 "muestra", "muestras", "amostra", "amostras"]
_MEETING_TERMS = ["meet", "meeting", "call", "schedule", "visit", "video", "zoom",
                  "teams", "booth", "见面", "会议", "电话", "视频", "参观", "展位", "预约",
                  "reunión", "reunion", "cita", "visita", "llamada", "reunião", "encontro",
                  "agendar", "coordinar",
                  # 2026-09-16 修复：买家【确认到展】的说法以前漏识别（回信通知失灵的一处）
                  "be back", "will come", "will be there", "see you", "attend", "stop by",
                  "会来", "到展", "到场", "到现场", "来展", "过来", "我会去", "我们会去"]
# catalogue/catalog 单独不算 quote_request
_CATALOGUE_ONLY = ["catalogue", "catalog", "brochure", "目录", "产品手册", "资料",
                   "catálogo", "catalogo", "catálogos", "folleto"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _day(dt: str | None = None) -> str:
    dt = dt or _now()
    return dt[:10] if len(dt) >= 10 else _now()[:10]


def _hash(s: str) -> str:
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()


# ── 文件读写（原子 + 锁）────────────────────────────────────
@contextmanager
def _file_lock(lock_path: Path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    f = open(lock_path, "a")
    try:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def _write_snapshot(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = SNAPSHOT_HEADER + "\n\n" + json.dumps(obj, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_snapshot(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    except OSError:
        return None
    return None


def _append_history(obj: dict) -> None:
    path = HISTORY / f"{_day()}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    with _file_lock(LOCKS / ".history.lock"):
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")


# ── 稳定幂等键 ─────────────────────────────────────────────
def stable_signal_id(signal_type: str, *parts: str) -> str:
    return _hash("|".join([signal_type, *parts]))


# ── 信号持久化 ─────────────────────────────────────────────
def _by_id_path(signal_id: str) -> Path:
    return BY_ID / f"{_hash(signal_id)}.md"


def record_signal(signal: dict) -> bool:
    """幂等写入单条信号。by-id 唯一；重复返回 False。"""
    signal_id = signal.get("signal_id")
    if not signal_id:
        raise ValueError("signal_id required")
    path = _by_id_path(signal_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    signal.setdefault("schema_version", 1)
    signal.setdefault("extractor_version", EXTRACTOR_VERSION)
    signal.setdefault("created_at", _now())
    signal.setdefault("status", "active")
    signal.setdefault("resolved_at", None)
    signal.setdefault("resolution_reason", None)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        _append_history({"signal_id": signal_id, "status": "duplicate", "at": _now()})
        return False
    content = SNAPSHOT_HEADER + "\n\n" + json.dumps(signal, ensure_ascii=False) + "\n"
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    _append_history({"signal_id": signal_id, "status": "created", "at": _now()})
    return True


def _set_signal_status(signal_id: str, status: str, reason: str) -> bool:
    path = _by_id_path(signal_id)
    with _file_lock(LOCKS / f"{_hash(signal_id)}.lock"):
        rec = _read_snapshot(path)
        if not rec:
            return False
        rec["status"] = status
        rec["resolved_at"] = _now()
        rec["resolution_reason"] = reason
        _write_snapshot(path, rec)
    _append_history({"signal_id": signal_id, "status": status, "reason": reason, "at": _now()})
    return True


def resolve_signal(signal_id: str, reason: str = "") -> bool:
    return _set_signal_status(signal_id, "resolved", reason)


def suppress_signal(signal_id: str, reason: str = "") -> bool:
    return _set_signal_status(signal_id, "suppressed", reason)


def query_signals(company_id: str = None, status: str = None, signal_type: str = None) -> list[dict]:
    out = []
    if BY_ID.exists():
        for p in BY_ID.glob("*.md"):
            rec = _read_snapshot(p)
            if not rec:
                continue
            if company_id and rec.get("company_id") != company_id:
                continue
            if status and rec.get("status") != status:
                continue
            if signal_type and rec.get("signal_type") != signal_type:
                continue
            out.append(rec)
    out.sort(key=lambda r: r.get("occurred_at") or r.get("created_at") or "")
    return out


# ── 回复信号分类 ───────────────────────────────────────────
def _truncate_excerpt(text: str, limit: int = 240) -> str:
    t = (text or "").strip()
    return t if len(t) <= limit else t[:limit]


def _matched(terms, tl):
    return [t for t in terms if t in tl]


def classify_reply_signals(text: str, intent: str = "", missing_fields: list = None,
                           confidence: float = None, source_message_id: str = "",
                           company_id: str = "", campaign_id: str = "", lead_id: str = "",
                           contact_id: str = "", thread_id: str = "",
                           requested_materials: list = None) -> list[dict]:
    """从回复正文 + IQ intent 提取机会信号。可同时产生多个信号。

    requested_materials 是 IQ 结构化输出，作为文本术语之外的补充线索。
    """
    missing_fields = missing_fields or []
    signals = []
    # 剥离 quoted reply / 原始邮件引用，只用本次新回复内容做信号分类
    try:
        from dc_iq_engine import strip_quoted_reply
        text = strip_quoted_reply(text or "")
    except Exception:
        pass
    if intent in BLOCKED_INTENTS:
        return signals  # 自动回复/拒绝/退订 → 无机会信号

    tl = (text or "").lower()
    rm = [x.lower() for x in (requested_materials or [])]

    quote_terms = _matched(_QUOTE_TERMS, tl)
    for extra in ("price", "moq"):
        if extra in rm and extra not in quote_terms:
            quote_terms.append(extra)
    if quote_terms:
        signals.append(_mk_signal(
            "quote_request", confidence or 0.9,
            {"matched_terms": quote_terms, "excerpt": _truncate_excerpt(text)},
            source_message_id, company_id, campaign_id, lead_id, contact_id, thread_id))

    sample_terms = _matched(_SAMPLE_TERMS, tl)
    if "sample" in rm and "sample" not in sample_terms:
        sample_terms.append("sample")
    if sample_terms:
        signals.append(_mk_signal(
            "sample_request", confidence or 0.85,
            {"matched_terms": sample_terms, "excerpt": _truncate_excerpt(text)},
            source_message_id, company_id, campaign_id, lead_id, contact_id, thread_id))

    meeting_terms = _matched(_MEETING_TERMS, tl)
    if meeting_terms:
        signals.append(_mk_signal(
            "meeting_interest", confidence or 0.85,
            {"matched_terms": meeting_terms, "excerpt": _truncate_excerpt(text)},
            source_message_id, company_id, campaign_id, lead_id, contact_id, thread_id))

    return signals


def _mk_signal(signal_type, confidence, evidence, source_message_id, company_id,
               campaign_id, lead_id, contact_id, thread_id):
    signal_id = stable_signal_id(signal_type, source_message_id, campaign_id)
    return {
        "signal_id": signal_id,
        "signal_type": signal_type,
        "status": "active",
        "company_id": company_id,
        "campaign_id": campaign_id,
        "lead_id": lead_id,
        "contact_id": contact_id,
        "thread_id": thread_id,
        "source_message_id": source_message_id,
        "confidence": confidence,
        "evidence": evidence,
        "occurred_at": _now(),
    }


def build_missing_info_signal(missing_fields: list, source_message_id: str = "",
                              company_id: str = "", campaign_id: str = "",
                              lead_id: str = "", contact_id: str = "", thread_id: str = "") -> list[dict]:
    """missing_info 是内部处理信号：仅当有结构化 missing_fields 时生成。"""
    if not missing_fields:
        return []
    signal_id = stable_signal_id("missing_info", source_message_id, campaign_id)
    return [{
        "signal_id": signal_id,
        "signal_type": "missing_info",
        "status": "active",
        "company_id": company_id,
        "campaign_id": campaign_id,
        "lead_id": lead_id,
        "contact_id": contact_id,
        "thread_id": thread_id,
        "source_message_id": source_message_id,
        "confidence": 1.0,
        "evidence": {"missing_fields": list(missing_fields)},
        "occurred_at": _now(),
    }]


# ── 传输信号（delivered / bounced）──────────────────────────
def record_delivery_signal(signal_type: str, resend_id: str, provider_event_id: str,
                           company_id: str = "", campaign_id: str = "", lead_id: str = "",
                           contact_id: str = "", thread_id: str = "", detail: str = "",
                           buyer_email: str = "") -> dict:
    """delivered/bounced 事实信号。无法绑 campaign_id 时保存但标 partial。"""
    signal_id = stable_signal_id(signal_type, resend_id, provider_event_id)
    evidence = {"detail": (detail or "")[:240]}
    if buyer_email:
        evidence["buyer_email"] = buyer_email
    signal = {
        "signal_id": signal_id,
        "signal_type": signal_type,
        "status": "active",
        "company_id": company_id,
        "campaign_id": campaign_id,
        "lead_id": lead_id,
        "contact_id": contact_id,
        "thread_id": thread_id,
        "source_resend_id": resend_id,
        "source_event_id": provider_event_id,
        "binding_status": "partial" if not campaign_id else "bound",
        "evidence": evidence,
        "occurred_at": _now(),
    }
    record_signal(signal)
    return signal


# ── 统一回复入口 ───────────────────────────────────────────
def process_reply(reply_text: str = None, message_id: str = "", thread_id: str = "",
                  company_id: str = "", campaign_id: str = "", lead_id: str = "",
                  contact_id: str = "", iq_intent: str = "", requested_materials: list = None,
                  missing_fields: list = None, confidence: float = None) -> dict:
    """统一回复信号入口：分类 + 持久化 + 返回。无法绑企业时不生成 Campaign 业务信号。"""
    text = reply_text or ""
    if not company_id:
        return {"signals": [], "skipped_reason": "unmatched_business_context"}
    signals = classify_reply_signals(
        text, intent=iq_intent, missing_fields=missing_fields, confidence=confidence,
        source_message_id=message_id, company_id=company_id, campaign_id=campaign_id,
        lead_id=lead_id, contact_id=contact_id, thread_id=thread_id,
        requested_materials=requested_materials)
    signals += build_missing_info_signal(
        missing_fields or [], source_message_id=message_id, company_id=company_id,
        campaign_id=campaign_id, lead_id=lead_id, contact_id=contact_id, thread_id=thread_id)
    for s in signals:
        record_signal(s)
    return {"signals": signals, "skipped_reason": None}


def analyze_reply(reply_text: str, buyer_domain: str = "", enterprise: str = "") -> dict:
    """调 dc_iq_engine.analyze_only() 纯分析（无副作用）。失败返回空。"""
    try:
        from dc_iq_engine import analyze_only
        return analyze_only(reply_text)
    except Exception:
        return {"intent": "", "confidence": None, "requested_materials": [], "missing_fields": []}


def get_signal(signal_id: str) -> dict | None:
    return _read_snapshot(_by_id_path(signal_id))


def replied_thread_ids() -> set:
    """返回所有已被回复信号绑定过的 thread_id（即 outbound.local_message_id）。

    用于 P0-E4 联系人匹配：多个相同联系人 outbound 时，只绑定「未完成」（无回复）的那条。
    """
    out = set()
    for rec in query_signals():
        tid = (rec.get("thread_id") or "").strip()
        if tid:
            out.add(tid)
    return out


def list_signals(company_id: str, campaign_id: str = None, status: str = "active",
                 signal_types: list = None, since: str = None) -> list[dict]:
    """P0-E3 前的只读查询接口：结果来自 Markdown，不重新调用 IQ。"""
    out = []
    for rec in query_signals(company_id=company_id, status=status):
        if campaign_id and rec.get("campaign_id") != campaign_id:
            continue
        if signal_types and rec.get("signal_type") not in signal_types:
            continue
        if since and (rec.get("occurred_at") or rec.get("created_at") or "") < since:
            continue
        out.append(rec)
    out.sort(key=lambda r: r.get("occurred_at") or r.get("created_at") or "")
    return out


# ── no_reply_due 评估 ──────────────────────────────────────
def evaluate_due(company_id: str, at: str = None, due_days: int = None,
                 due_for=None, store=None) -> list[dict]:
    """生成 no_reply_due 信号（不执行跟进、不发送）。

    条件：outbound 已 delivered、当前 >= due_at、同 thread/contact 无真实 inbound reply、
    未退订/未 complained/未 bounced、没有相同 active no_reply_due。

    due_for: 可选 `outbound -> (due_at, evidence_extra)`：让「到期」可按分层与轮次计算。
    多轮触达引擎（dc_touch_rounds）用它把 no_reply_due 语义扩成「第 N 轮到期」；
    **不传时行为与旧版逐字一致**（显式 followup_due_at 优先、否则 sent_at + due_days）。
    传了 due_for 时去重键从 contact_id 换成 (contact_id, local_message_id)，
    让同一买家的每一轮各有一条 no_reply_due（多轮场景必须按轮次区分）。
    """
    due_days = due_days if due_days is not None else DEFAULT_DUE_DAYS
    at_ts = _parse_ts(at) if at else time.time()

    from email_gateway.store import EmailStore
    store = store or EmailStore()
    outbounds = store.list_outbound_records(company_id=company_id)
    inbounds = store.list_inbound_records(company_id=company_id)

    active_due = query_signals(company_id=company_id, status="active",
                               signal_type="no_reply_due")
    if due_for:
        existing_due = {(s.get("contact_id"), s.get("source_message_id")): s
                        for s in active_due}
    else:
        existing_due = {s.get("contact_id"): s for s in active_due}
    produced = []
    for ob in outbounds:
        if ob.get("provider_status") != "delivered":
            continue
        sent_at = ob.get("sent_at") or ob.get("created_at", "")
        extra: dict = {}
        if due_for:
            try:
                resolved = due_for(ob)
                due_at, extra = resolved if isinstance(resolved, tuple) else (resolved, {})
            except Exception:  # noqa: BLE001 — 轮次解析失败回落到旧口径，不阻断出数
                due_at, extra = None, {}
            if not due_at:
                due_at = ob.get("followup_due_at") or _iso_add_days(sent_at, due_days)
        else:
            due_at = ob.get("followup_due_at")
            if not due_at:
                due_at = _iso_add_days(sent_at, due_days)
        due_ts = _parse_ts(due_at)
        if due_ts is None or at_ts < due_ts:
            continue  # due_at 未到
        contact_id = ob.get("contact_id", "")
        thread_id = ob.get("thread_id") or ob.get("local_message_id", "")
        # 同 thread/contact 有真实 inbound reply？
        if _has_reply(inbounds, thread_id, contact_id, ob.get("sent_at") or ob.get("created_at"),
                      outbound=ob):
            continue
        if due_for:
            if (contact_id, ob.get("local_message_id", "")) in existing_due:
                continue  # 该轮已有 active no_reply_due
        elif contact_id in existing_due:
            continue  # 已有 active no_reply_due
        signal_id = stable_signal_id("no_reply_due", company_id, contact_id,
                                     ob.get("local_message_id", ""), due_at)
        signal = {
            "signal_id": signal_id,
            "signal_type": "no_reply_due",
            "status": "active",
            "company_id": company_id,
            "campaign_id": ob.get("campaign_id", ""),
            "lead_id": ob.get("lead_id", ""),
            "contact_id": contact_id,
            "thread_id": thread_id,
            "source_message_id": ob.get("local_message_id", ""),
            "source_resend_id": ob.get("resend_id", ""),
            "confidence": 1.0,
            "evidence": {
                "due_policy": "default" if not ob.get("followup_due_at") else "explicit",
                "due_days": due_days,
                "due_at": due_at,
                **extra,
            },
            "occurred_at": _now(),
        }
        record_signal(signal)
        produced.append(signal)
    return produced


def _parse_ts(ts) -> float | None:
    if isinstance(ts, (int, float)):
        return float(ts)
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except (ValueError, OSError):
        return None


def _iso_add_days(iso: str, days: int) -> str:
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (dt + __import__("datetime").timedelta(days=days)).isoformat()
    except (ValueError, OSError):
        return (datetime.now(timezone.utc) + __import__("datetime").timedelta(days=days)).isoformat()


def _has_reply(inbounds: list[dict], thread_id: str, contact_id: str, sent_at: str,
               outbound: dict | None = None) -> bool:
    """是否已收到人工回复（停止 due 判定的判据）。

    保留旧 binding 路径；传了 outbound 时叠加与 dc_followup / 轮次引擎同一口径的
    引用匹配（In-Reply-To / References / thread），避免只按 thread 匹配漏掉真实回复。
    """
    if outbound is not None:
        try:
            from dc_touch_rounds import has_reply as _round_has_reply
            if _round_has_reply(outbound, inbounds):
                return True
        except Exception:  # noqa: BLE001 — 归属判定失败不阻断出数
            pass
    for ib in inbounds:
        if ib.get("binding_status") != "bound":
            continue
        if thread_id and ib.get("thread_id") == thread_id:
            return True
        if contact_id and ib.get("contact_id") == contact_id and (ib.get("received_at") or "") >= sent_at:
            return True
    return False


# ── CLI ────────────────────────────────────────────────────
def _cli():
    ap = argparse.ArgumentParser(description="DC Email Signals")
    sub = ap.add_subparsers(dest="cmd", required=True)

    q = sub.add_parser("query", help="查询信号")
    q.add_argument("--company-id")
    q.add_argument("--status")
    q.add_argument("--signal-type")

    e = sub.add_parser("evaluate-due", help="生成 no_reply_due 信号")
    e.add_argument("--company-id", required=True)
    e.add_argument("--at", help="ISO 时间")
    e.add_argument("--due-days", type=int)

    args = ap.parse_args()
    if args.cmd == "query":
        print(json.dumps(query_signals(args.company_id, args.status, args.signal_type),
                         ensure_ascii=False, indent=2))
    elif args.cmd == "evaluate-due":
        produced = evaluate_due(args.company_id, at=args.at, due_days=args.due_days)
        print(json.dumps({"produced": len(produced), "signals": produced},
                         ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
