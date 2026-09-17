#!/usr/bin/env python3
"""dc_email_selfcheck — 邮件链「存在证明」自检（发信落事实 / 回信匹配 / 通知投递）。

为什么有它（2026-09-16 田耕郡口径）：这两天邮件链反复坏在**静默失效**——
字段被 store 白名单丢弃、SMTP 直发的事实从没落过库、回调收到了却没落进事实层。
共同点是「缺失被吞掉而不是报错」，客户总是第一个发现的人。
所以每个关键环节都要留**存在证明**，并且能**一条命令自检**、能告警。

检查三条链路（全部只读，不写任何数据）：
  1. 发信落事实：窗口内的出站事实是否有归属（account_id）、是否有可回信匹配的
     Message-ID（smtp_message_id / local_message_id）、是否记了发信会话
     （origin_notify_target）；以及落到 _unmatched/ 的（无归属）出站数量。
  2. 回信匹配：窗口内入站事实的 binding_status 分布（matched / unmatched / 其它），
     未匹配的原因直方图（failure_reason）。未匹配占比过高 → 告警。
  3. 通知投递：窗口内 notifications/sent.md 的投递结果（status / last_error），
     失败逐条列出。投递失败必须可见，不得静默。
  4. 漏推对账（2026-09-16 补）：窗口内 **归属成功(matched)的回信数** vs
     **通知里 kind=signal_item 且已 sent 的条数**，落差 > 0 → degraded，
     并把「匹配了但没通知」的 message_id / 发件人列出来（提示可能是漏推）。

输出：人读摘要 + `--json` 结构化结果；退出码 0=全通 / 1=降级 / 2=断链（供 cron 告警）。

用法::

    python3 dc_email_selfcheck.py                 # 最近 24h
    python3 dc_email_selfcheck.py --hours 72 --json
    python3 dc_email_selfcheck.py --data-dir /data/workspace/work/mio-api/data
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

STATUS_OK = "ok"
STATUS_DEGRADED = "degraded"
STATUS_BROKEN = "broken"

EXIT_CODES = {STATUS_OK: 0, STATUS_DEGRADED: 1, STATUS_BROKEN: 2}

# 降级阈值
UNMATCHED_DEGRADE_RATIO = 0.5      # 未匹配占比 ≥50% 视为降级
OUTBOUND_NO_ACCOUNT_DEGRADE = 1    # 有出站事实但没有任何归属 → 降级
DEFAULT_HOURS = 24

# 漏推对账：推送层使用的通知 kind / 按口径静默标记（与 dc_signal_push 对齐）
SIGNAL_ITEM_KIND = "signal_item"
DEDUPE_PREFIX = "signal-push:"
SILENT_STATUS = "silent_intent_blocked"
MISSING_SAMPLE_LIMIT = 20


def _default_data_dir() -> Path:
    env = os.environ.get("DC_DATA_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent / "data"


def _parse_ts(value) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _iter_json_lines(path: Path):
    """逐行解析 JSON；坏行跳过（自检本身不能因为脏数据崩掉）。"""
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def _first_json(path: Path) -> dict:
    for obj in _iter_json_lines(path):
        return obj
    return {}


def _md_facts(root: Path, since: datetime, *, ts_fields=("created_at", "sent_at", "received_at")) -> list[dict]:
    """扫事实层 Markdown 快照（每个文件首行 JSON），按时间窗过滤。上限保护。"""
    out: list[dict] = []
    if not root.exists():
        return out
    for path in sorted(root.rglob("*.md")):
        obj = _first_json(path)
        if not obj:
            continue
        when = None
        for field in ts_fields:
            when = _parse_ts(obj.get(field))
            if when:
                break
        if when is None or when < since:
            continue
        obj["_path"] = str(path)
        out.append(obj)
    return out


def check_outbound(data_dir: Path, since: datetime) -> dict:
    """发信落事实：有没有事实、有没有归属、有没有 Message-ID、有没有记录发信会话。"""
    root = data_dir / "email-facts" / "outbound"
    facts = [f for f in _md_facts(root, since) if not str(f.get("_path", "")).split("/outbound/")[-1].startswith("_unmatched/")]
    unmatched_dir = list((root / "_unmatched").rglob("*.md")) if (root / "_unmatched").exists() else []

    total = len(facts)
    with_account = sum(1 for f in facts if str(f.get("account_id") or "").strip())
    with_msgid = sum(1 for f in facts if str(f.get("smtp_message_id") or "").strip())
    with_local_msgid = sum(1 for f in facts if str(f.get("local_message_id") or "").strip())
    with_origin = sum(1 for f in facts if str(f.get("origin_notify_target") or "").strip())

    status = STATUS_OK
    problems: list[str] = []
    if total == 0:
        # 窗口内没发信不一定算坏（可能只是没发）；明确说明而不是判红
        status = STATUS_OK
        problems.append("窗口内没有出站事实（可能确实没发信）")
    else:
        if with_account == 0:
            status = STATUS_DEGRADED
            problems.append(f"出站事实 {total} 条，但没有任何一条带 account_id —— 回信会匹配不上")
        if with_msgid == 0 and with_local_msgid == 0:
            status = STATUS_DEGRADED
            problems.append("出站事实没有任何 Message-ID（smtp_message_id / local_message_id 全空）")
    if unmatched_dir:
        status = STATUS_DEGRADED if status == STATUS_OK else status
        problems.append(f"另有 {len(unmatched_dir)} 条出站事实落在 _unmatched/（无归属）")

    return {
        "status": status,
        "total": total,
        "with_account_id": with_account,
        "with_smtp_message_id": with_msgid,
        "with_local_message_id": with_local_msgid,
        "with_origin_notify_target": with_origin,
        "unmatched_dir_count": len(unmatched_dir),
        "problems": problems,
    }


def check_reply_match(data_dir: Path, since: datetime) -> dict:
    """回信匹配：入站事实的匹配率与未匹配原因。"""
    root = data_dir / "email-facts" / "inbound"
    facts = _md_facts(root, since)
    total = len(facts)
    matched = sum(1 for f in facts if str(f.get("binding_status") or "").strip() == "matched")
    unmatched = sum(1 for f in facts if str(f.get("binding_status") or "").strip() == "unmatched")
    other = total - matched - unmatched

    reasons: dict[str, int] = {}
    for f in facts:
        if str(f.get("binding_status") or "").strip() != "matched":
            reason = str(f.get("failure_reason") or "unspecified").strip() or "unspecified"
            reasons[reason] = reasons.get(reason, 0) + 1

    status = STATUS_OK
    problems: list[str] = []
    if unmatched:
        ratio = unmatched / total if total else 0
        if ratio >= UNMATCHED_DEGRADE_RATIO:
            status = STATUS_DEGRADED
        problems.append(f"未匹配 {unmatched} 条（占 {ratio:.0%}）" + (f"，主因：{max(reasons, key=reasons.get)}" if reasons else ""))
    return {
        "status": status,
        "total": total,
        "matched": matched,
        "unmatched": unmatched,
        "other": other,
        "unmatched_reasons": dict(sorted(reasons.items(), key=lambda kv: -kv[1])),
        "problems": problems,
    }


def check_notifications(data_dir: Path, since: datetime) -> dict:
    """通知投递：投出去没有、失败原因是什么。"""
    path = data_dir / "notifications" / "sent.md"
    records = list(_iter_json_lines(path)) if path.exists() else []
    windowed = [r for r in records if (_parse_ts(r.get("sent_at") or r.get("created_at")) or since) >= since]
    sent = sum(1 for r in windowed if str(r.get("status") or "") == "sent")
    failed = [r for r in windowed if str(r.get("status") or "") not in ("sent", "")]
    pending = len(windowed) - sent - len(failed)

    status = STATUS_OK
    problems: list[str] = []
    if failed:
        status = STATUS_DEGRADED
        problems.append(f"{len(failed)} 条通知投递失败（未送达）")
    samples = [
        {
            "notification_id": r.get("notification_id", ""),
            "title": str(((r.get("payload") or {}).get("title")) or "")[:40],
            "error": str(r.get("last_error") or "")[:160],
        }
        for r in failed[:5]
    ]
    return {
        "status": status,
        "total": len(windowed),
        "sent": sent,
        "failed": len(failed),
        "pending": pending,
        "failed_samples": samples,
        "problems": problems,
    }


def _candidate_id_for(company_id: str, message_id: str) -> str:
    """与 ``dc_signal_push._candidate_id`` 同一公式（本地复算）。

    为什么不 import：自检要在任何环境（含只有 Markdown 快照、模块路径不全）都能算对；
    公式一经改动由 ``tests/test_email_selfcheck.py`` 的等式断言兜住（不会静默漂移）。
    """
    return hashlib.sha256("|".join(["candidate", company_id or "", message_id or ""])
                          .encode("utf-8")).hexdigest()


def _notification_candidate_id(rec: dict) -> str:
    """从通知记录里取 candidate_id（payload.candidate_id 优先，兜底 dedupe_key）。"""
    cid = str(((rec.get("payload") or {}).get("candidate_id")) or "").strip()
    if cid:
        return cid
    key = str(rec.get("dedupe_key") or "")
    return key[len(DEDUPE_PREFIX):] if key.startswith(DEDUPE_PREFIX) else ""


def _push_history(data_dir: Path, since: datetime) -> list[dict]:
    """读推送层 history（按「信」决策留痕）。"""
    out: list[dict] = []
    root = data_dir / "signal-push" / "history"
    for path in sorted(root.glob("*.md")) if root.exists() else []:
        for rec in _iter_json_lines(path):
            when = _parse_ts(rec.get("at"))
            if when is not None and when < since:
                continue
            out.append(rec)
    return out


def _push_candidates(data_dir: Path, since: datetime) -> dict[str, dict]:
    """读 push candidate 快照：candidate_id → 记录（窗口内）。"""
    out: dict[str, dict] = {}
    root = data_dir / "signal-push" / "by-id"
    for path in sorted(root.glob("*.md")) if root.exists() else []:
        obj = _first_json(path)
        if not obj:
            continue
        when = _parse_ts(obj.get("created_at"))
        if when is not None and when < since:
            continue
        cid = str(obj.get("candidate_id") or "").strip()
        if cid:
            out.setdefault(cid, obj)
    return out


def check_push_reconcile(data_dir: Path, since: datetime) -> dict:
    """漏推对账（2026-09-16 客户口径）：匹配成功的回信 vs 实际通知数。

    推送口径已改成「以信为单位、不漏推」，但最后一层仍可能断：candidate 没生成、
    生成了没 publish、publish 了没 dispatch。只靠客户回报 = 漏推永远后知后觉，
    所以这里拿两个可核对的事实做差：

      左：窗口内 ``email-facts/inbound`` 里 **binding_status=matched** 的回信；
      右：``notifications/sent.md`` 里 **kind=signal_item 且 status=sent** 的记录，
          按 candidate_id 归位（candidate_id 由 company_id + 回信 message_id 稳定推出）。

    落差 > 0 → degraded，并把「匹配了但没通知」的 message_id / 发件人列出来（可能是漏推）。
    intent ∈ {自动回复, 拒绝} 按口径本就静默，它们由推送层写 silent 留痕，这里剔除，
    否则自检会永远喊狼。
    """
    inbound_root = data_dir / "email-facts" / "inbound"
    matched = []
    for fact in _md_facts(inbound_root, since):
        if str(fact.get("binding_status") or "").strip() != "matched":
            continue
        mid = str(fact.get("message_id") or "").strip()
        if not mid:
            continue
        matched.append({
            "message_id": mid,
            "sender": _address_of(fact.get("sender") or ""),
            "company_id": str(fact.get("company_id") or "").strip(),
            "received_at": str(fact.get("received_at") or fact.get("created_at") or ""),
        })

    silent_ids = {str(rec.get("source_message_id") or "").strip()
                  for rec in _push_history(data_dir, since)
                  if str(rec.get("status") or "") == SILENT_STATUS}
    candidates = _push_candidates(data_dir, since)

    notified: set[str] = set()
    notify_failed = 0
    for name, source in (("sent", "sent.md"), ("failed", "failed.md")):
        for rec in _iter_json_lines(data_dir / "notifications" / source):
            if str(rec.get("kind") or "") != SIGNAL_ITEM_KIND:
                continue
            when = _parse_ts(rec.get("sent_at") or rec.get("created_at") or rec.get("updated_at"))
            if when is not None and when < since:
                continue
            cid = _notification_candidate_id(rec)
            if not cid:
                continue
            if str(rec.get("status") or "") == "sent":
                notified.add(cid)
            elif name == "failed":
                notify_failed += 1

    expected = [r for r in matched if r["message_id"] not in silent_ids]
    missing = []
    without_candidate = 0
    for row in expected:
        cid = _candidate_id_for(row["company_id"], row["message_id"])
        if cid in notified:
            continue
        has_candidate = cid in candidates
        if not has_candidate:
            without_candidate += 1
        missing.append({**row, "candidate_id": cid, "has_candidate": has_candidate})

    status = STATUS_DEGRADED if missing else STATUS_OK
    problems: list[str] = []
    if missing:
        problems.append(
            f"漏推对账：窗口内匹配成功回信 {len(expected)} 封，已通知 {len(expected) - len(missing)} 封，"
            f"差 {len(missing)} 封（其中未生成 candidate {without_candidate} 封）—— 疑似漏推")
    elif not matched:
        problems.append("窗口内没有匹配成功的回信（无可对账样本）")
    if notify_failed:
        problems.append(f"另有 {notify_failed} 条 signal_item 通知投递失败（见 notify_delivery）")
    return {
        "status": status,
        "matched_replies": len(matched),
        "silent_by_policy": len([r for r in matched if r["message_id"] in silent_ids]),
        "expected_push": len(expected),
        "notified": len(expected) - len(missing),
        "missing": len(missing),
        "missing_without_candidate": without_candidate,
        "notify_failed": notify_failed,
        "candidates_seen": len(candidates),
        "missing_samples": [
            {"message_id": m["message_id"], "sender": m["sender"],
             "company_id": m["company_id"], "has_candidate": m["has_candidate"]}
            for m in missing[:MISSING_SAMPLE_LIMIT]
        ],
        "problems": problems,
    }


ADDRESS_RE = __import__("re").compile(r"<([^>]+)>")
FIX_LOG_NAME = "_selfcheck-fixes.jsonl"


def _address_of(raw: str) -> str:
    """从 ``Name <a@b>`` / ``a@b`` 里取地址（小写）。"""
    text = str(raw or "").strip()
    match = ADDRESS_RE.search(text)
    addr = match.group(1) if match else text
    return addr.strip().strip("<>").lower()


def _load_accounts(data_dir: Path) -> dict[str, str]:
    """address(小写) -> account_id。"""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from email_gateway.store import EmailStore  # noqa: PLC0415

        accounts = EmailStore(data_dir).list_accounts() or []
    except Exception:  # noqa: BLE001 - 自检/自愈不能因为读不到账号而崩
        return {}
    out: dict[str, str] = {}
    for acc in accounts:
        addr = str(acc.get("email_address") or "").strip().lower()
        account_id = str(acc.get("account_id") or "").strip()
        if addr and account_id:
            out[addr] = account_id
    return out


def heal_outbound_attribution(data_dir: Path, *, apply: bool = False) -> dict:
    """自愈类 1：把 ``outbound/_unmatched/`` 里能按发件地址认回账号的事实补上归属。

    动作**内部、幂等、可回滚**：补 ``account_id`` 并把文件挪进
    ``outbound/<account_id>/<YYYY-MM>/``（不改内容语义，只加归属字段）。
    ``apply=False``（默认）只算不改 —— 先把「能修多少」摆出来。
    """
    root = data_dir / "email-facts" / "outbound" / "_unmatched"
    accounts = _load_accounts(data_dir)
    fixable: list[dict] = []
    skipped: list[dict] = []
    fixed: list[dict] = []
    log_path = data_dir / "email-facts" / FIX_LOG_NAME

    for path in sorted(root.rglob("*.md")) if root.exists() else []:
        obj = _first_json(path)
        if not obj:
            skipped.append({"path": str(path), "reason": "unreadable"})
            continue
        addr = _address_of(obj.get("sender") or "")
        account_id = accounts.get(addr, "")
        if not account_id:
            skipped.append({"path": str(path), "reason": "no_account_for_sender", "sender": addr})
            continue
        when = _parse_ts(obj.get("sent_at") or obj.get("created_at")) or datetime.now(timezone.utc)
        target_dir = data_dir / "email-facts" / "outbound" / account_id / when.strftime("%Y-%m")
        entry = {"path": str(path), "account_id": account_id, "to": str(target_dir / path.name)}
        fixable.append(entry)
        if not apply:
            continue
        try:
            obj["account_id"] = account_id
            obj["attribution_fixed_by"] = "email-selfcheck"
            obj["attribution_fixed_at"] = datetime.now(timezone.utc).isoformat()
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / path.name
            target.write_text(json.dumps(obj, ensure_ascii=False) + "\n", encoding="utf-8")
            path.unlink()
            with log_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(),
                                     "action": "outbound_attribution", **entry}, ensure_ascii=False) + "\n")
            fixed.append(entry)
        except OSError as exc:  # noqa: BLE001
            skipped.append({"path": str(path), "reason": f"write_failed:{type(exc).__name__}"})

    return {
        "kind": "outbound_attribution",
        "applied": bool(apply),
        "fixable": len(fixable),
        "fixed": len(fixed),
        "skipped": len(skipped),
        "skip_reasons": _tally(r.get("reason", "") for r in skipped),
        "samples": fixable[:5],
        "log": str(log_path) if apply else "",
    }


def _tally(values) -> dict:
    out: dict[str, int] = {}
    for value in values:
        out[value] = out.get(value, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def needs_human(result: dict) -> list[str]:
    """哪些问题**不该自动修**（必须人/必须确认）—— 告警里要明说。"""
    out: list[str] = []
    notify = result["links"]["notify_delivery"]
    if notify["failed"]:
        out.append(f"通知投递失败 {notify['failed']} 条：需人看通道/账号（例：{notify['failed_samples'][0]['error'][:60] if notify['failed_samples'] else ''}）")
    reconcile = (result["links"].get("push_reconcile") or {})
    if reconcile.get("missing"):
        sample = (reconcile.get("missing_samples") or [{}])[0]
        out.append(f"疑似漏推 {reconcile['missing']} 封回信（例：{sample.get('message_id', '')} / "
                   f"{sample.get('sender', '')}）：需人到收信与通知两侧核因，不自动补发")
    reply = result["links"]["reply_match"]
    if reply["unmatched"]:
        out.append(f"回信未匹配 {reply['unmatched']} 条：先由自愈重跑兜底收敛；仍配不上需人工判断")
    outbound = result["links"]["outbound_facts"]
    if outbound["with_smtp_message_id"] == 0 and outbound["total"]:
        out.append("出站事实缺真实 Message-ID：需从 Provider 反查回填（外部调用，需确认）")
    return out


def heal_reply_match(data_dir: Path, *, apply: bool = False,
                     hours: int = DEFAULT_HOURS) -> dict:
    """自愈类 4：回信未匹配 → **重跑兜底收敛**（同联系人 + 时间窗），只有**唯一命中**才认。

    为什么：未匹配里有一部分只是“当时没兜底”或“候选后来才齐”，重跑一次能配上。
    但若收敛结果仍是 ambiguous（多候选）→ **不猜、交给人**（乱配比不配更糟）。
    ``apply=False`` 只算不改。幂等：已 matched / 已 rebound 的记录不再动。
    """
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    root = data_dir / "email-facts" / "inbound"
    fixable: list[dict] = []
    skipped: list[dict] = []
    fixed: list[dict] = []
    log_path = data_dir / "email-facts" / FIX_LOG_NAME

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        from dc_email_controller import dc_webhook_handler as wh  # noqa: PLC0415
        from email_gateway import reply_attribution as ra  # noqa: PLC0415
        from email_gateway.store import EmailStore  # noqa: PLC0415

        store = EmailStore(data_dir)
    except Exception as exc:  # noqa: BLE001
        return {"kind": "reply_match", "applied": bool(apply), "error": f"{type(exc).__name__}: {exc}",
                "fixable": 0, "fixed": 0, "skipped": 0, "skip_reasons": {}, "samples": [], "log": ""}

    for path in sorted(root.rglob("*.md")) if root.exists() else []:
        obj = _first_json(path)
        if not obj:
            continue
        if str(obj.get("binding_status") or "") == "matched" or obj.get("rebound_by"):
            continue
        when = _parse_ts(obj.get("received_at") or obj.get("created_at"))
        if when and when < since:
            continue
        recipients = obj.get("recipients") or []
        if not isinstance(recipients, list):
            recipients = [recipients]
        to_email = str(recipients[0]) if recipients else ""
        try:
            acct = ra.resolve_mailbox(recipients, store=store) or {}
        except Exception:  # noqa: BLE001
            acct = {}
        account_id = str(acct.get("account_id") or "")
        if not account_id:
            skipped.append({"path": str(path), "reason": "no_recipient_account"})
            continue
        try:
            fb = wh._fallback_match_by_contact(store, account_id, str(obj.get("sender") or ""), to_email) or {}
        except Exception as exc:  # noqa: BLE001
            skipped.append({"path": str(path), "reason": f"fallback_error:{type(exc).__name__}"})
            continue
        if fb.get("status") != "matched":
            skipped.append({"path": str(path), "reason": str(fb.get("status") or "no_match")})
            continue
        outbound = fb.get("outbound") or {}
        entry = {"path": str(path), "account_id": account_id,
                 "outbound_id": str(outbound.get("resend_id") or outbound.get("message_id") or ""),
                 "method": str(fb.get("binding_method") or "fallback_replay")}
        fixable.append(entry)
        if not apply:
            continue
        try:
            obj.update({
                "binding_status": "matched",
                "matched_outbound_id": entry["outbound_id"],
                "binding_method": entry["method"],
                "binding_confidence": "low",
                "rebound_by": "email-selfcheck",
                "rebound_at": datetime.now(timezone.utc).isoformat(),
            })
            obj.pop("failure_reason", None)
            path.write_text(json.dumps(obj, ensure_ascii=False) + "\n", encoding="utf-8")
            with log_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(),
                                     "action": "reply_match", **entry}, ensure_ascii=False) + "\n")
            fixed.append(entry)
        except OSError as exc:  # noqa: BLE001
            skipped.append({"path": str(path), "reason": f"write_failed:{type(exc).__name__}"})

    return {
        "kind": "reply_match",
        "applied": bool(apply),
        "fixable": len(fixable),
        "fixed": len(fixed),
        "skipped": len(skipped),
        "skip_reasons": _tally(r.get("reason", "") for r in skipped),
        "samples": fixable[:5],
        "log": str(log_path) if apply else "",
    }


def run_selfcheck(data_dir: Path, hours: int = DEFAULT_HOURS) -> dict:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    links = {
        "outbound_facts": check_outbound(data_dir, since),
        "reply_match": check_reply_match(data_dir, since),
        "notify_delivery": check_notifications(data_dir, since),
        "push_reconcile": check_push_reconcile(data_dir, since),
    }
    order = {STATUS_BROKEN: 2, STATUS_DEGRADED: 1, STATUS_OK: 0}
    worst = STATUS_OK
    for result in links.values():
        if order[result["status"]] > order[worst]:
            worst = result["status"]
    return {
        "ok": worst == STATUS_OK,
        "status": worst,
        "data_dir": str(data_dir),
        "window_hours": hours,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "links": links,
    }


def render(result: dict) -> str:
    icon = {STATUS_OK: "✅", STATUS_DEGRADED: "⚠️", STATUS_BROKEN: "❌"}
    lines = [
        f"邮件链自检｜{icon[result['status']]} {result['status']}（窗口 {result['window_hours']}h）",
        f"数据目录：{result['data_dir']}",
    ]
    for name, link in result["links"].items():
        lines.append(f"\n{icon[link['status']]} {name}")
        for key, value in link.items():
            if key in ("status", "problems", "failed_samples", "unmatched_reasons",
                       "missing_samples"):
                continue
            lines.append(f"   {key}: {value}")
        if link.get("unmatched_reasons"):
            lines.append(f"   unmatched_reasons: {link['unmatched_reasons']}")
        for sample in link.get("failed_samples") or []:
            lines.append(f"   ✗ {sample['title'] or sample['notification_id']} :: {sample['error'][:120]}")
        for sample in link.get("missing_samples") or []:
            lines.append(f"   ✗ 匹配了但没通知：{sample['message_id']} / {sample['sender']}"
                         f"（{'已有候选未投递' if sample['has_candidate'] else '未生成候选'}）")
        for problem in link.get("problems") or []:
            lines.append(f"   ⚠ {problem}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="邮件链存在证明自检（发信/回信/通知）")
    ap.add_argument("--data-dir", default=str(_default_data_dir()))
    ap.add_argument("--hours", type=int, default=DEFAULT_HOURS)
    ap.add_argument("--json", action="store_true", help="输出结构化 JSON")
    ap.add_argument("--fix", action="store_true",
                    help="先自愈再复检（默认 dry-run：只算不改）")
    ap.add_argument("--apply", action="store_true",
                    help="与 --fix 同用：真的写入（幂等、留痕、可回滚）")
    args = ap.parse_args(argv)

    data_dir = Path(args.data_dir)
    heal = None
    if args.fix:
        heal = [
            heal_outbound_attribution(data_dir, apply=bool(args.apply)),
            heal_reply_match(data_dir, apply=bool(args.apply), hours=args.hours),
        ]

    result = run_selfcheck(data_dir, hours=args.hours)
    if heal is not None:
        result["heal"] = heal
        result["needs_human"] = needs_human(result)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(render(result))
        if heal is not None:
            mode = "已写入" if args.apply else "dry-run（未改动）"
            for item in heal:
                if item.get("error"):
                    print(f"\n🛠 自愈 {item['kind']}：不可用（{item['error']}）")
                    continue
                print(f"\n🛠 自愈 {item['kind']}（{mode}）：可修 {item['fixable']} / 已修 {item['fixed']} / 跳过 {item['skipped']}")
                if item["skip_reasons"]:
                    print(f"   跳过原因：{item['skip_reasons']}")
            for line in result.get("needs_human") or []:
                print(f"   需人工：{line}")
    # 修完复检：自愈后仍不健康才非 0（告警只报「修不动的」）
    return EXIT_CODES.get(result["status"], 1)


if __name__ == "__main__":
    raise SystemExit(main())
