"""回信归属：把一封回信对应到「收件箱（账号）」和「人（owner）」。

目标（产品原话）：**从租户邮箱发出去的邮件可以收到回信，并且对应到收件箱和人。**

为什么要双口径（2026-09-15 实测教训）：
  · 只靠 ``In-Reply-To`` 精确匹配太脆——实测中 Resend 收信详情接口可能**不返回**
    ``In-Reply-To`` 头；头部缺失时任何精确匹配方案都会失效，回信变成"拉到了但认不出"。
  · 因此改为分层归属，确定性从高到低：

   1. ``in_reply_to``：有头部且能命中 outbound 事实 → 精确到"回的是哪一封"
   2. ``recipient``：按收件地址（回信发给哪个托管邮箱）定位**收件箱**→ 再到 ``owner``
   3. ``recipient_recent``：同收件箱下最近一次发给该发件人的外发（线程兜底）

  第 2/3 层不依赖任何邮件头部，保证"至少能对应到收件箱和人"，这正是本模块的存在意义。
"""

from __future__ import annotations

from typing import Any

METHOD_IN_REPLY_TO = "in_reply_to"
METHOD_RECIPIENT = "recipient"
METHOD_RECIPIENT_RECENT = "recipient_recent"
METHOD_NONE = "none"


def _norm(address: str) -> str:
    addr = str(address or "").strip()
    if "<" in addr and ">" in addr:
        addr = addr[addr.rfind("<") + 1:addr.rfind(">")]
    return addr.strip().strip("<>").strip().lower()


def _to_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [_norm(value)]
    if isinstance(value, (list, tuple)):
        return [_norm(v) for v in value]
    return []


def resolve_mailbox(recipients: list[str], *, store) -> dict:
    """按收件地址定位收件箱账号。返回账号记录（未命中返回 ``{}``）。"""
    wanted = {a for a in (_norm(r) for r in recipients) if a}
    if not wanted:
        return {}
    try:
        accounts = store.list_accounts() or []
    except Exception:  # noqa: BLE001
        return {}
    for acc in accounts:
        for key in ("email_address", "email", "address", "from_address"):
            if _norm(acc.get(key, "")) in wanted:
                return acc
    return {}


def refine_thread(in_reply_to: str, *, facts_dir: str = "") -> dict:
    """用 ``In-Reply-To`` 在 message-id 索引里定位具体外发事实（尽力而为，失败返回空）。"""
    mid = str(in_reply_to or "").strip()
    if not mid:
        return {}
    try:
        import hashlib
        import json
        from pathlib import Path

        base = Path(facts_dir) if facts_dir else Path(__file__).resolve().parent.parent / "data" / "email-facts"
        h = hashlib.sha256(mid.encode()).hexdigest()
        ipath = base / "indexes" / "message-id" / f"{h}.md"
        if not ipath.exists():
            return {}
        raw = ipath.read_text(encoding="utf-8")
        irec = json.loads(raw[raw.find("{"):raw.rfind("}") + 1])
        rel = irec.get("record_path") or ""
        if not rel:
            return {}
        rec_path = base / rel
        if not rec_path.exists():
            return {}
        rec_raw = rec_path.read_text(encoding="utf-8")
        rec = json.loads(rec_raw[rec_raw.find("{"):rec_raw.rfind("}") + 1])
        return {
            "outbound_ref": rel,
            "account_id": rec.get("account_id", ""),
            "subject": rec.get("subject", ""),
            "smtp_message_id": rec.get("smtp_message_id", ""),
            "resend_id": rec.get("resend_id", ""),
            # 发信会话：投递层优先把回信通知发回这里（旧记录缺字段 → 空串，走绑定回退）
            "origin_notify_target": rec.get("origin_notify_target", "") or "",
        }
    except Exception:  # noqa: BLE001
        return {}


def _recent_outbound_for_sender(sender: str, account_id: str, *, facts_dir: str = "") -> dict:
    """同收件箱下、最近一次发给该发件人的外发（线程兜底）。"""
    s = _norm(sender)
    if not s or not account_id:
        return {}
    try:
        import json
        from pathlib import Path

        base = Path(facts_dir) if facts_dir else Path(__file__).resolve().parent.parent / "data" / "email-facts"
        best = {}
        best_key = ""
        for p in (base / "outbound").glob("*/2026-*/*.md"):
            try:
                raw = p.read_text(encoding="utf-8")
                rec = json.loads(raw[raw.find("{"):raw.rfind("}") + 1])
            except Exception:  # noqa: BLE001
                continue
            if rec.get("account_id") != account_id:
                continue
            recips = {_norm(r) for r in (rec.get("recipients") or [])}
            if s not in recips:
                continue
            # 按真实发送时间选最新（不能用文件 mtime：数据修复会改写 mtime）
            key = str(rec.get("sent_at") or rec.get("created_at") or "")
            if not best or key > best_key:
                best_key = key
                best = {"outbound_ref": str(p.relative_to(base)), "subject": rec.get("subject", ""),
                        "sent_at": key,
                        "origin_notify_target": rec.get("origin_notify_target", "") or ""}
        return best
    except Exception:  # noqa: BLE001
        return {}


def attribute(
    *,
    recipients: Any,
    sender: str = "",
    in_reply_to: str = "",
    store,
    facts_dir: str = "",
) -> dict:
    """把一封回信归属到「收件箱 + 人」。**不抛异常**。

    返回
    ----
    ``{"attributed", "method", "account_id", "mailbox", "owner_open_id", "enterprise_id",
       "thread": {...}}``
    """
    out: dict[str, Any] = {
        "attributed": False, "method": METHOD_NONE, "account_id": "", "mailbox": "",
        "owner_open_id": "", "enterprise_id": "", "thread": {},
    }
    recips = _to_list(recipients)

    box = resolve_mailbox(recips, store=store)
    if box:
        out.update({
            "account_id": box.get("account_id", ""),
            "mailbox": box.get("email_address") or box.get("email") or "",
            "owner_open_id": box.get("owner_open_id", ""),
            "enterprise_id": box.get("enterprise_id", ""),
            "attributed": True,
            "method": METHOD_RECIPIENT,
        })

    thread = refine_thread(in_reply_to, facts_dir=facts_dir) if in_reply_to else {}
    if thread:
        out["thread"] = thread
        if out["attributed"]:
            out["method"] = METHOD_IN_REPLY_TO
        else:
            acc_id = thread.get("account_id", "")
            if acc_id:
                try:
                    acc = store.get_account(acc_id)
                except Exception:  # noqa: BLE001
                    acc = {}
                out.update({
                    "attributed": True, "method": METHOD_IN_REPLY_TO,
                    "account_id": acc_id,
                    "mailbox": acc.get("email_address") or acc.get("email") or "",
                    "owner_open_id": acc.get("owner_open_id", ""),
                    "enterprise_id": acc.get("enterprise_id", ""),
                })

    if out["attributed"] and not out["thread"] and out["account_id"]:
        recent = _recent_outbound_for_sender(sender, out["account_id"], facts_dir=facts_dir)
        if recent:
            out["thread"] = recent
            out["method"] = METHOD_RECIPIENT_RECENT
    return out
