#!/usr/bin/env python3
"""
dc_reply_draft.py — P0-E4 回复草稿（机会 Push → 草稿 → 用户确认 → 发出回复 → 线索更新）

职责：
  1. 机会 candidate 生成后，读原始 inbound + 复用 dc_iq_engine.generate_reply 生成回复草稿；
  2. 草稿持久化到 pending-replies Markdown（by-id 唯一事实源）；
  3. 自然语言确认解析（发送/修改/无意图）；
  4. 草稿修改（只更新 text，状态保持 pending_confirmation）；
  5. 用户确认后经 Founder Direct/SmtpSender 发送，回写 outbound + touch_number + 状态。

不自动发送；不自动回复买家；不新增 Skill；复用现有 IQ / 发送能力。
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

HEADER = "# DealClaw Reply Draft"


def _root() -> Path:
    return Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))) / "pending-replies"


def _by_id_dir() -> Path:
    return _root() / "by-id"


def _history_dir() -> Path:
    return _root() / "history"

DRAFT_TTL_SECONDS = int(os.environ.get("DC_DRAFT_TTL_SECONDS", "86400"))  # 默认 24h

# 发送所必需的关键资料：缺失这些字段不得发送
SEND_CRITICAL_FIELDS = {"price", "moq", "payment_terms", "certificate"}

# 自然语言发送意图
SEND_PHRASES = ["发送", "确认回复", "发出去", "可以回", "按这个发", "就这么发", "确认发送", "发吧"]
# 修改意图（优先于发送判断；"改成X再发"应判为修改）
MODIFY_KEYWORDS = ["改短", "改长", "加上", "补充", "不要提", "去掉", "删", "换成", "改成",
                   "修改", "润色", "口吻", "语气", "简短", "精简"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(s: str) -> str:
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()


def _draft_id(company_id: str, related_reply_id: str) -> str:
    return _hash("|".join(["draft", company_id or "", related_reply_id or ""]))


def _path(draft_id: str) -> Path:
    return _by_id_dir() / f"{_hash(draft_id)}.md"


def _read(path: Path) -> dict | None:
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


def _write(path: Path, rec: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = HEADER + "\n\n" + json.dumps(rec, ensure_ascii=False) + "\n"
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _append_history(rec: dict) -> None:
    p = _history_dir() / f"{_now()[:10]}.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def record_draft(draft: dict) -> bool:
    """幂等写入草稿。同 draft_id 只写一次。"""
    did = draft.get("draft_id")
    if not did:
        raise ValueError("draft_id required")
    path = _path(did)
    path.parent.mkdir(parents=True, exist_ok=True)
    draft.setdefault("created_at", _now())
    draft.setdefault("status", "pending_confirmation")
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    content = HEADER + "\n\n" + json.dumps(draft, ensure_ascii=False) + "\n"
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    _append_history({"draft_id": did, "status": "created", "at": _now()})
    return True


def get_draft(draft_id: str) -> dict | None:
    return _read(_path(draft_id))


def update_draft(draft_id: str, **fields) -> bool:
    path = _path(draft_id)
    rec = _read(path)
    if not rec:
        return False
    rec.update(fields)
    rec["updated_at"] = _now()
    _write(path, rec)
    _append_history({"draft_id": draft_id, "status": fields.get("status", rec.get("status")), "at": _now()})
    return True


def list_drafts(company_id: str = None, status: str = None) -> list[dict]:
    out = []
    d = _by_id_dir()
    if d.exists():
        for p in d.glob("*.md"):
            rec = _read(p)
            if not rec:
                continue
            if company_id and rec.get("company_id") != company_id:
                continue
            if status and rec.get("status") != status:
                continue
            out.append(rec)
    out.sort(key=lambda r: r.get("created_at") or "")
    return out


# ── 草稿生成 ──────────────────────────────────────────────
def generate_draft_text(reply_text: str, buyer: str = "", intent: str = "", profile: dict = None) -> str:
    """复用 dc_iq_engine.generate_reply 生成回复草稿文本。失败退回通用模板。"""
    try:
        from dc_iq_engine import generate_reply, get_next_stage
        stage = get_next_stage(0, intent) if intent else 2
        txt = generate_reply(intent or "表达兴趣", stage, buyer=buyer, profile=profile or {})
        if txt:
            return txt
    except Exception:
        pass
    name = f", {buyer}" if buyer else ""
    return (f"Thanks for reaching out{name}. We'd be glad to help with your request "
            f"for quotation, samples and a meeting. Could you share a bit more about "
            f"your requirements so we can prepare the details?")


def generate_draft(*, company_id: str, campaign_id: str = "", lead_id: str = "",
                   contact_id: str = "", related_reply_id: str = "", reply_text: str = "",
                   buyer: str = "", buyer_email: str = "", subject: str = "",
                   missing_fields: list = None, account_id: str = "", touch_number: int = 0) -> dict:
    """根据机会回复生成一份 pending 草稿（不发送）。"""
    from dc_iq_engine import analyze_only
    a = analyze_only(reply_text or "")
    missing = list(missing_fields or [])
    # 合并 analyze_only 的 missing（去重）
    for m in (a.get("missing_fields") or []):
        if m not in missing:
            missing.append(m)
    did = _draft_id(company_id, related_reply_id)
    now = _now()
    return {
        "draft_id": did,
        "company_id": company_id,
        "campaign_id": campaign_id or "",
        "lead_id": lead_id or "",
        "contact_id": contact_id or "",
        "account_id": account_id or "",
        "buyer_email": buyer_email or "",
        "related_reply_id": related_reply_id or "",
        "subject": subject or f"Re: your inquiry",
        "text": generate_draft_text(reply_text or "", buyer=buyer, intent=a.get("intent", "")),
        "missing_fields": sorted(set(missing)),
        "status": "pending_confirmation",
        "created_at": now,
        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=DRAFT_TTL_SECONDS)).isoformat(),
        "updated_at": now,
        "message_id": "",
        "sent_at": "",
        "failure_reason": "",
        "next_action": "",
        "attempts": 0,
        "touch_number": int(touch_number or 0),
    }


# ── 自然语言确认解析 ──────────────────────────────────────
def parse_send_intent(text: str) -> str:
    """解析用户指令 → send | modify | none。"""
    t = (text or "").strip()
    if not t:
        return "none"
    if any(k in t for k in MODIFY_KEYWORDS):
        return "modify"
    if any(p in t for p in SEND_PHRASES):
        return "send"
    return "none"


def apply_edit(draft: dict, instruction: str) -> dict:
    """根据自然语言修改草稿 text。只返回新 text + 修改标记，不发送、不改状态。"""
    t = instruction.strip()
    new_text = draft.get("text", "")
    note = ""
    if any(k in t for k in ("改短", "短一点", "简短", "精简")):
        new_text = " ".join(new_text.split())[:160]
        note = "shortened"
    elif any(k in t for k in ("交期", "delivery")):
        if "delivery" not in new_text.lower():
            new_text += "\n\nCould you also share your delivery timeline / target date?"
        note = "added_delivery_time"
    elif any(k in t for k in ("不要提样品", "不要样品", "去掉样品")):
        new_text = new_text.replace("sample", "").replace("Sample", "").replace("samples", "")
        note = "removed_sample"
    elif any(k in t for k in ("老板", "口吻", "语气")):
        # 口吻调整：去掉客套前缀，更直接
        new_text = new_text.replace("Thanks for reaching out", "Hi").replace("We'd be glad to help", "We can help")
        note = "tone_adjusted"
    else:
        new_text = draft.get("text", "")
        note = "edited:" + t[:40]
    return {"text": new_text, "edit_note": note, "modified": new_text != draft.get("text", "")}


# ── 确认后发送 ────────────────────────────────────────────
def _is_expired(draft: dict) -> bool:
    try:
        exp = datetime.fromisoformat(draft.get("expires_at") or "")
        return datetime.now(timezone.utc) > exp
    except (ValueError, TypeError):
        return False


def _missing_critical(draft: dict) -> list[str]:
    return [m for m in (draft.get("missing_fields") or []) if m in SEND_CRITICAL_FIELDS]


def confirm_and_send(draft_id: str, confirmed_by: str = "", store=None) -> dict:
    """用户明确确认后发送草稿。返回结构化结果；失败不伪造 sent、不自动重发。"""
    draft = get_draft(draft_id)
    if not draft:
        return {"status": "error", "error": "draft not found", "draft_id": draft_id}
    if draft.get("status") != "pending_confirmation":
        return {"status": "skip", "draft_id": draft_id, "draft_status": draft.get("status")}

    if _is_expired(draft):
        update_draft(draft_id, status="expired", next_action="regenerate")
        return {"status": "expired", "draft_id": draft_id}

    critical = _missing_critical(draft)
    if critical:
        update_draft(draft_id, status="pending_confirmation",
                     failure_reason=f"missing_critical_fields:{','.join(critical)}",
                     next_action="provide_fields")
        return {"status": "blocked", "draft_id": draft_id, "reason": "missing_critical_fields",
                "missing": critical}

    if not draft.get("buyer_email"):
        update_draft(draft_id, status="failed", failure_reason="missing_buyer_email",
                     next_action="retry_after_review")
        return {"status": "failed", "draft_id": draft_id, "error": "missing buyer_email"}

    # 拒绝/排除买家拦截：买家已明确拒绝或已被排除，不再发送
    try:
        from dc_ls_store import LeadStore
        if LeadStore().is_buyer_blocked(
                draft.get("company_id", "") or draft.get("enterprise", ""),
                draft.get("buyer_email")):
            update_draft(draft_id, status="blocked", failure_reason="buyer_rejected",
                         next_action="stop")
            return {"status": "blocked", "draft_id": draft_id, "reason": "buyer_rejected"}
    except Exception:
        pass

    try:
        from email_gateway.smtp_send import SmtpSender
        from email_gateway.store import EmailStore
        st = store or EmailStore()
        # 找默认发件账号（无 account_id 时回退）
        account_id = draft.get("account_id", "")
        if not account_id:
            try:
                account_id = st.select_sender_account(
                    enterprise_id=draft.get("company_id", ""),
                    owner_open_id=confirmed_by)["account_id"]
            except Exception:
                raise RuntimeError("no sender account available")
        sender = SmtpSender(st)
        touch = int(draft.get("touch_number", 0)) + 1
        r = sender.send(
            account_id=account_id, confirmed_by=confirmed_by,
            to=[draft["buyer_email"]],
            subject=draft.get("subject") or "Re: your inquiry",
            text=draft.get("text", ""),
            reply_to=draft.get("reply_to") or "",
            company_id=draft.get("company_id", ""),
            campaign_id=draft.get("campaign_id", ""),
            lead_id=draft.get("lead_id", ""),
            contact_id=draft.get("contact_id", ""),
            touch_number=touch,
            content_version="reply",
            thread_id=draft.get("related_reply_id", "") or draft.get("related_reply_id", ""),
        )
        resend_id = r.get("resend_id") or ""
        update_draft(draft_id, status="sent", message_id=resend_id,
                     sent_at=_now(), touch_number=touch, failure_reason="", next_action="")
        # P0-E4：写 audit log + 线索触达状态
        try:
            from dc_audit import AuditLog
            AuditLog().log(action="reply.send", user_open_id=confirmed_by,
                           enterprise=draft.get("company_id", ""),
                           target=draft.get("buyer_email", ""),
                           detail=f"reply draft sent touch={touch}")
        except Exception:
            pass
        try:
            from heartbeat_data import upsert_lead_status
            upsert_lead_status(buyer=draft.get("buyer_email", ""),
                               contact=draft.get("contact_id", ""),
                               status="replied", last_touch=_now(), last_reply=_now())
        except Exception:
            pass
        return {"status": "sent", "draft_id": draft_id, "resend_id": resend_id,
                "touch_number": touch, "send_result": r}
    except Exception as e:
        update_draft(draft_id, status="failed", failure_reason=str(e)[:200],
                     next_action="retry_after_review")
        return {"status": "failed", "draft_id": draft_id, "error": str(e)[:200]}
