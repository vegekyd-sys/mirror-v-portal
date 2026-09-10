#!/usr/bin/env python3
"""
dc_signal_push.py — P0-E3A Push 决策层（只 dry-run）

读取 email-signals/by-id → 判断是否值得通知 → 合并同一回复的多个信号 →
生成 push candidate → Markdown 持久化 → **不真实发送**。

决策规则（详见 build_candidates）：
  quote_request   → 实时 Push 候选
  sample_request  → 实时 Push 候选
  meeting_interest→ 实时 Push 候选，优先级最高
  missing_info    → 不单独推，与对应询盘合并（表现为“需要用户补资料”）
  no_reply_due    → 进下一次 morning plan，不实时推
  bounced         → 单封不实时推，进聚合；短期集中退信才生成风险候选
  delivered       → 只计数，不 Push

P0-E3A 只生成 proposed/suppressed，不进入 queued/sent。
不解决 open_id、不读通知路由、不调 dc_notify、不发飞书。
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

from _tenant_env import load_tenant_env

load_tenant_env()

_DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
ROOT = _DATA_DIR / "signal-push"
BY_ID = ROOT / "by-id"
HISTORY = ROOT / "history"
LOCKS = ROOT / "locks"
SNAPSHOT_HEADER = "# DealClaw Push Candidate"

OPPORTUNITY_TYPES = ("quote_request", "sample_request", "meeting_interest")
BOUNCE_RISK_THRESHOLD = int(os.environ.get("DC_BOUNCE_RISK_THRESHOLD", "3"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _day(dt: str | None = None) -> str:
    dt = dt or _now()
    return dt[:10] if len(dt) >= 10 else _now()[:10]


def _hash(s: str) -> str:
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()


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


def _candidate_id(company_id: str, source_message_id: str) -> str:
    return _hash("|".join(["candidate", company_id, source_message_id]))


def _by_id_path(cid: str) -> Path:
    return BY_ID / f"{_hash(cid)}.md"


def build_title(signal_types: list[str]) -> str:
    labels = {"quote_request": "报价", "sample_request": "样品", "meeting_interest": "展会见面"}
    parts = [labels[t] for t in signal_types if t in labels]
    if not parts:
        return "买家询盘"
    if len(parts) == 1:
        return f"买家想{parts[0]}"
    return "买家想" + "、".join(parts[:-1]) + "，并希望" + parts[-1]


def record_candidate(cand: dict) -> bool:
    cid = cand.get("candidate_id")
    if not cid:
        raise ValueError("candidate_id required")
    path = _by_id_path(cid)
    path.parent.mkdir(parents=True, exist_ok=True)
    cand.setdefault("created_at", _now())
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        _append_history({"candidate_id": cid, "status": "duplicate", "at": _now()})
        return False
    content = SNAPSHOT_HEADER + "\n\n" + json.dumps(cand, ensure_ascii=False) + "\n"
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    _append_history({"candidate_id": cid, "status": "proposed", "at": _now()})
    return True


def suppress_candidate(cid: str, reason: str) -> bool:
    path = _by_id_path(cid)
    with _file_lock(LOCKS / f"{_hash(cid)}.lock"):
        rec = _read_snapshot(path)
        if not rec:
            return False
        rec["status"] = "suppressed"
        rec["decision"] = "suppress"
        rec["suppress_reason"] = reason
        _write_snapshot(path, rec)
    _append_history({"candidate_id": cid, "status": "suppressed", "reason": reason, "at": _now()})
    return True


def get_candidate(cid: str) -> dict | None:
    return _read_snapshot(_by_id_path(cid))


def _update_candidate(cid: str, **fields) -> bool:
    path = _by_id_path(cid)
    with _file_lock(LOCKS / f"{_hash(cid)}.lock"):
        rec = _read_snapshot(path)
        if not rec:
            return False
        rec.update(fields)
        rec["updated_at"] = _now()
        _write_snapshot(path, rec)
    return True


_MISSING_CN = {"delivery_time": "交期", "price": "报价", "moq": "起订量",
               "sample_policy": "样品政策", "payment_terms": "付款条款",
               "certificate": "证书", "specification": "规格", "catalog": "目录",
               "booth_number": "展位号", "contact_person": "联系人", "other": "其他"}


def format_candidate_message(cand: dict) -> str:
    """用户可见消息（不展示 signal_id/intent/confidence/JSON/内部状态/引擎名）。

    P0-E4：提示回复草稿已准备好 + 缺字段，等用户确认发送。
    """
    if cand.get("category") == "bounce":
        return cand.get("title") or "退信提醒"
    title = cand.get("title") or "买家询盘"
    missing = cand.get("missing_fields") or []
    if missing:
        cn = "、".join(_MISSING_CN.get(m, m) for m in missing)
        return f"{title}。\n回复草稿已准备好，但还缺{cn}信息，等你确认发送。"
    return f"{title}。\n回复草稿已准备好，等你确认发送。"


def _push_enabled(company_id: str) -> tuple[bool, str]:
    """安全开关：真实发送必须同时满足 DC_SIGNAL_PUSH_* 与 DC_NOTIFY_*。

    DC_NOTIFY_* 默认开启（未配置即可发）；DC_SIGNAL_PUSH_* 仍默认关闭。
    DC_SIGNAL_PUSH_AUTOMATION_MODE=live 是信号推送统一开关（P0-E3C.2）；
    兼容旧 DC_SIGNAL_PUSH_MODE=feishu + DC_SIGNAL_PUSH_ENABLED=1。
    """
    automation = os.getenv("DC_SIGNAL_PUSH_AUTOMATION_MODE", "").strip().lower()
    if automation == "live":
        signal_ok = True
    else:
        mode = os.getenv("DC_SIGNAL_PUSH_MODE", "")
        enabled = os.getenv("DC_SIGNAL_PUSH_ENABLED", "") == "1"
        signal_ok = (mode == "feishu" and enabled)
    allowed = {x.strip() for x in os.getenv("DC_SIGNAL_PUSH_ALLOWED_COMPANIES", "").split(",") if x.strip()}
    notify_mode = os.getenv("DC_NOTIFY_SENDER_MODE", "feishu")
    notify_enabled = os.getenv("DC_NOTIFY_SEND_ENABLED", "1") == "1"
    _notify_allowed_raw = os.getenv("DC_NOTIFY_ALLOWED_COMPANIES", "").strip()
    notify_allowed = ({x.strip() for x in _notify_allowed_raw.split(",") if x.strip()}
                      if _notify_allowed_raw else None)
    if not signal_ok or notify_mode != "feishu" or not notify_enabled:
        return False, "push_disabled"
    if allowed and company_id not in allowed:
        return False, "not_whitelisted"
    if notify_allowed is not None and company_id not in notify_allowed:
        return False, "not_whitelisted"
    return True, ""


def publish_candidate(candidate_id: str, dry_run: bool = None) -> dict:
    """把 proposed candidate 交给 dc_notify（signal_item）投递，并回写状态。

    - route_missing/invalid → 保持 proposed + last_error，不标 queued。
    - dry-run / 开关未开 / 非白名单 → 保持 proposed（forced_dry_run）。
    - publish 成功 → queued；真实发送由 dc_notify.dispatch 完成（另有状态回写）。
    不得绕过 dc_notify 直接 message.send。
    """
    cand = get_candidate(candidate_id)
    if not cand:
        return {"status": "error", "error": "candidate not found", "candidate_id": candidate_id}
    if cand.get("status") != "proposed":
        return {"status": "skip", "candidate_id": candidate_id, "candidate_status": cand.get("status")}

    from dc_notify import NotifyEngine
    engine = NotifyEngine()
    route = engine.resolve_notification_route(cand.get("company_id", ""))
    message = format_candidate_message(cand)

    if route.get("status") != "ok":
        _update_candidate(candidate_id, status="proposed",
                          last_error=route.get("error", ""), route_status=route.get("status"))
        return {"status": route.get("status"), "candidate_id": candidate_id,
                "error": route.get("error"), "route": route, "message_preview": message}

    ok, reason = _push_enabled(cand.get("company_id", ""))
    if not ok:
        _update_candidate(candidate_id, status="proposed",
                          last_error=reason, route_status="ok")
        return {"status": "forced_dry_run", "forced_dry_run": True,
                "candidate_id": candidate_id, "reason": reason,
                "route": route, "message_preview": message}
    if dry_run is True:
        _update_candidate(candidate_id, status="proposed",
                          last_error="dry_run", route_status="ok")
        return {"status": "dry_run", "forced_dry_run": False,
                "candidate_id": candidate_id, "reason": "dry_run",
                "route": route, "message_preview": message}

    res = engine.publish(
        cand.get("company_id", ""), "signal_item",
        payload={"candidate_id": candidate_id, "title": cand.get("title"), "message": message},
        dedupe_key=f"signal-push:{candidate_id}", slot="realtime")
    if res.get("status") in ("published", "duplicate"):
        _update_candidate(candidate_id, status="queued",
                          notification_id=res.get("notification_id"))
    else:
        _update_candidate(candidate_id, status="failed", last_error=str(res.get("error", "publish failed")))
    return {"status": res.get("status"), "candidate_id": candidate_id,
            "notification_id": res.get("notification_id"), "route": route,
            "message_preview": message}


def mark_candidate_sent(candidate_id: str, message_id: str) -> bool:
    return _update_candidate(candidate_id, status="sent", message_id=message_id, sent_at=_now())


def mark_candidate_failed(candidate_id: str, error: str, attempts: int = 1) -> bool:
    return _update_candidate(candidate_id, status="failed", last_error=error,
                             attempts=attempts, next_retry_at=_now())


# ── P0-E3C.1 自动触发 ──────────────────────────────────────
# 单租户：信号推送只处理当前租户 supplier id（tenant-env 优先，.env 兜底）。
SHADOW_COMPANY = os.getenv("MIO_CDP_SUPPLIER_ID", "testco")


def _automation_mode() -> str:
    return os.getenv("DC_SIGNAL_PUSH_AUTOMATION_MODE", "off").strip().lower()


def _enabled_after() -> str:
    return os.getenv("DC_SIGNAL_PUSH_ENABLED_AFTER", "").strip()


def _route_verified(company_id: str) -> bool:
    try:
        from dc_notify import NotifyEngine
        return NotifyEngine().resolve_notification_route(company_id).get("status") == "ok"
    except Exception:
        return False


def _deliver_live(candidates: list[dict]) -> list[dict]:
    """live 模式：publish → dispatch → mark_sent 全链路（不再人工确认）。

    仅处理 publish 成功（published/duplicate）的 candidate；
    路由缺失/非白名单/开关未开 → publish_candidate 内部保持 proposed，这里跳过；
    dispatch 失败 → mark_candidate_failed。
    """
    from dc_notify import NotifyEngine
    engine = NotifyEngine()
    pushed = []
    for cand in candidates:
        cid = cand.get("candidate_id", "")
        company_id = cand.get("company_id", "")
        pr = publish_candidate(cid)
        if pr.get("status") not in ("published", "duplicate"):
            continue
        nid = pr.get("notification_id", "")
        dr = engine.dispatch(company_id, slot="realtime")
        message_id = ""
        for rr in dr.get("results", []):
            if rr.get("status") == "sent" and (not nid or rr.get("notification_id") == nid):
                message_id = rr.get("message_id", "")
        if message_id:
            mark_candidate_sent(cid, message_id)
            pushed.append({"candidate_id": cid, "notification_id": nid, "message_id": message_id})
        elif any(rr.get("status") == "failed" for rr in dr.get("results", [])):
            mark_candidate_failed(cid, "dispatch failed")
    return pushed


def evaluate_for_push(signal_ids: list[str], mode: str = None) -> dict:
    """对本次新生成的 signal 做 Push 决策（off/shadow/live）。

    - off：不生成 candidate。
    - shadow：真实信号生成 candidate（proposed），但不 publish/dc_notify/dispatch。
    - live：生成 candidate（可进真实链路，但本函数不 publish）。

    防历史爆发：无 DC_SIGNAL_PUSH_ENABLED_AFTER 时 shadow/live 均拒绝；
    只处理 created_at >= enabled_after 的 signal。只处理 testco。
    """
    from . import dc_email_signals as sig
    mode = (mode or _automation_mode()).strip().lower()
    if mode == "off":
        return {"mode": "off", "candidates": [], "reason": "automation off", "count": 0}

    enabled_after = _enabled_after()
    if not enabled_after:
        return {"mode": mode, "candidates": [], "reason": "enabled_after not configured",
                "rejected": True, "count": 0}

    eligible = []
    for sid in signal_ids:
        s = sig.get_signal(sid)
        if not s:
            continue
        if (s.get("created_at") or s.get("occurred_at") or "") < enabled_after:
            continue
        if s.get("company_id") != SHADOW_COMPANY:
            continue  # 其他企业：不生成、不发送
        eligible.append(s)
    if not eligible:
        return {"mode": mode, "candidates": [], "reason": "no eligible testco signals", "count": 0}

    groups: dict[str, list[dict]] = {}
    for s in eligible:
        if s.get("signal_type") in OPPORTUNITY_TYPES + ("missing_info",):
            mid = s.get("source_message_id") or s.get("signal_id")
            groups.setdefault(mid, []).append(s)

    candidates = []
    route_ok = _route_verified(SHADOW_COMPANY)
    for mid, sigs in groups.items():
        cand = _build_opportunity(mid, sigs, "scale")
        if not cand:
            continue
        cand.update({
            "automation_mode": mode,
            "trigger": "signal_created",
            "trigger_signal_ids": [s["signal_id"] for s in sigs],
            "allowed_company": True,
            "route_verified": route_ok,
            "would_publish": True,
            "would_push_reason": "realtime opportunity",
            "blocked_reason": "" if mode == "live" else "shadow_mode",
            "evaluated_at": _now(),
        })
        record_candidate(cand)
        candidates.append(cand)
    pushed = _deliver_live(candidates) if (mode == "live" and route_ok) else []
    return {"mode": mode, "candidates": candidates, "count": len(candidates), "pushed": pushed}


def list_candidates(company_id: str = None, status: str = None) -> list[dict]:
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
            out.append(rec)
    out.sort(key=lambda r: r.get("created_at") or "")
    return out


def _build_opportunity(mid: str, sigs: list[dict], phase: str) -> dict | None:
    opp = [x for x in sigs if x["signal_type"] in OPPORTUNITY_TYPES]
    if not opp:
        return None  # 只有 missing_info（或无价值）→ 不推
    signal_types = [x["signal_type"] for x in sigs]
    priority = "highest" if any(x["signal_type"] == "meeting_interest" for x in opp) else "high"
    # 展会阶段只影响优先级，不扩大授权
    if phase == "pre_show" and any(x["signal_type"] == "meeting_interest" for x in opp):
        priority = "highest"
    missing = []
    for x in sigs:
        if x["signal_type"] == "missing_info":
            missing.extend(x.get("evidence", {}).get("missing_fields", []))
    company_id = sigs[0].get("company_id", "")
    campaign_id = sigs[0].get("campaign_id", "")
    excerpt = " ".join(x.get("evidence", {}).get("excerpt", "") for x in opp)[:240]
    return {
        "candidate_id": _candidate_id(company_id, mid),
        "company_id": company_id,
        "campaign_id": campaign_id,
        "source_message_id": mid,
        "category": "opportunity",
        "priority": priority,
        "signals": sorted(set(signal_types)),
        "title": build_title(signal_types),
        "evidence": excerpt,
        "missing_fields": sorted(set(missing)),
        "delivery_mode": "realtime",
        "decision": "push",
        "status": "proposed",
        "phase": phase,
    }


def _build_due(x: dict) -> dict:
    company_id = x.get("company_id", "")
    mid = x.get("source_message_id") or x.get("signal_id", "")
    return {
        "candidate_id": _candidate_id(company_id, "due:" + mid),
        "company_id": company_id,
        "campaign_id": x.get("campaign_id", ""),
        "source_message_id": mid,
        "category": "followup",
        "priority": "low",
        "signals": ["no_reply_due"],
        "title": "买家未回复，需跟进",
        "evidence": "",
        "missing_fields": [],
        "delivery_mode": "morning",
        "decision": "push",
        "status": "proposed",
    }


def _bounce_next_action(detail: str) -> str:
    """从退信 detail 的 [分类] 前缀给出下一步动作建议。"""
    d = detail or ""
    if d.startswith("[hard]"):
        return "标记无效邮箱，换联系人"
    if d.startswith("[soft]"):
        return "稍后重发（邮箱满/临时故障，等恢复）"
    if d.startswith("[content]"):
        return "改内容后重发（被反垃圾拦截）"
    return "人工确认原因"


def _build_bounce_action(x: dict) -> dict:
    """单封退信 → 主动推「原因 + 下一步动作」候选。"""
    company_id = x.get("company_id", "")
    mid = x.get("source_resend_id") or x.get("source_event_id") or x.get("signal_id", "")
    buyer = x.get("evidence", {}).get("buyer_email", "") or "买家"
    detail = x.get("evidence", {}).get("detail", "") or "退信"
    action = _bounce_next_action(detail)
    title = f"📧 退信：{buyer}\n原因：{detail}\n下一步：{action}"
    return {
        "candidate_id": _candidate_id(company_id, "bounce:" + mid),
        "company_id": company_id,
        "campaign_id": x.get("campaign_id", ""),
        "source_message_id": mid,
        "category": "bounce",
        "priority": "medium",
        "signals": ["bounced"],
        "title": title,
        "evidence": detail,
        "missing_fields": [],
        "delivery_mode": "realtime",
        "decision": "push",
        "status": "proposed",
    }


def _build_bounce_risk(company_id: str, bounced: list[dict]) -> dict | None:
    if len(bounced) < BOUNCE_RISK_THRESHOLD:
        return None
    cid = _candidate_id(company_id, "bounce-risk")
    return {
        "candidate_id": cid,
        "company_id": company_id,
        "campaign_id": "",
        "source_message_id": "",
        "category": "risk",
        "priority": "medium",
        "signals": ["bounced"],
        "title": f"短期集中退信 {len(bounced)} 封",
        "evidence": "",
        "missing_fields": [],
        "delivery_mode": "aggregate",
        "decision": "push",
        "status": "proposed",
    }


def build_candidates(company_id: str, campaign_id: str = None, phase: str = "scale") -> list[dict]:
    """从 active 信号生成 push candidate（dry-run）。delivered 只计数不 Push。"""
    from . import dc_email_signals as signals_mod
    active = signals_mod.list_signals(company_id, campaign_id=campaign_id, status="active")

    candidates: list[dict] = []
    # 回复机会信号：按 source_message_id 合并
    reply = [x for x in active if x["signal_type"] in OPPORTUNITY_TYPES + ("missing_info",)]
    groups: dict[str, list[dict]] = {}
    for x in reply:
        mid = x.get("source_message_id") or x.get("signal_id")
        groups.setdefault(mid, []).append(x)
    for mid, sigs in groups.items():
        cand = _build_opportunity(mid, sigs, phase)
        if cand:
            candidates.append(cand)

    # no_reply_due → morning
    for x in active:
        if x["signal_type"] == "no_reply_due":
            candidates.append(_build_due(x))

    # bounced → 每封主动判断下一步动作（单封也推）；集中退信另出风险候选
    bounced = [x for x in active if x["signal_type"] == "bounced"]
    for x in bounced:
        candidates.append(_build_bounce_action(x))
    risk = _build_bounce_risk(company_id, bounced)
    if risk:
        candidates.append(risk)

    return candidates


def run(company_id: str, campaign_id: str = None, phase: str = "scale") -> dict:
    """生成 + 持久化 push candidate；live 模式且路由通过时执行 publish→dispatch→mark_sent。"""
    candidates = build_candidates(company_id, campaign_id=campaign_id, phase=phase)
    recorded = []
    for cand in candidates:
        record_candidate(cand)
        recorded.append(cand)
    mode = _automation_mode()
    pushed = []
    if mode == "live" and recorded and _route_verified(company_id):
        pushed = _deliver_live(recorded)
    return {"candidates": recorded, "count": len(recorded), "mode": mode, "pushed": pushed}


def _cli():
    ap = argparse.ArgumentParser(description="DC Signal Push (dry-run)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="生成候选（live 模式下自动推送）")
    r.add_argument("--company-id", default=None)
    r.add_argument("--campaign-id")
    r.add_argument("--phase", default="scale", choices=["calibration", "scale", "sprint", "pre_show"])
    q = sub.add_parser("list", help="列出候选")
    q.add_argument("--company-id")
    q.add_argument("--status")
    args = ap.parse_args()
    if args.cmd == "run":
        cid = args.company_id or os.getenv("MIO_CDP_SUPPLIER_ID", "")
        if not cid:
            print(json.dumps({"error": "company-id 未提供且 MIO_CDP_SUPPLIER_ID 未配置"}, ensure_ascii=False))
            return 1
        out = run(cid, campaign_id=args.campaign_id, phase=args.phase)
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif args.cmd == "list":
        print(json.dumps(list_candidates(args.company_id, args.status), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
