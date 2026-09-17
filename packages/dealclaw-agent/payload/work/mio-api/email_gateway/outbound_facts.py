"""Outbound 事实落地（收信匹配的唯一依据）。

为什么必须存在：收信侧判断「这封回复回的是哪封邮件」，唯一依据就是 outbound 事实。
任何发信路径（网关直发 / 统一入口 / 批量通道）只要漏落这一条，回信就会匹配不到
（``no_matching_outbound``），信号不生成、通知不弹——**而且不报错**，属于典型静默失效。

因此本模块是唯一的落事实实现，各发信路径统一调用，不要各写一份。

约定：
  · best-effort：失败只返回错误、不抛异常（发信已经成功，不能因为落事实失败而回滚）；
  · 发件账号必须精确匹配到本租户的 account，匹配不到**宁可不落**——用兜底账号会把回复
    串到别的账号或别的租户，比少写一条更糟。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _normalize_address(from_addr: str) -> str:
    addr = str(from_addr or "")
    if "<" in addr and ">" in addr:
        addr = addr[addr.rfind("<") + 1:addr.rfind(">")]
    return addr.strip().strip("<>").strip().lower()


def resolve_account_id(from_addr: str, enterprise_id: str, *, store) -> str:
    """按发件地址 + 租户精确解析 account_id；解析不到返回空串。"""
    addr = _normalize_address(from_addr)
    if not addr:
        return ""
    try:
        accounts = store.list_accounts(enterprise_id=enterprise_id) or []
    except Exception:  # noqa: BLE001
        return ""
    for acc in accounts:
        for key in ("email_address", "email", "address", "from_address"):
            if str(acc.get(key, "")).strip().lower() == addr:
                return str(acc.get("account_id") or "")
    return ""


def land_outbound_fact(
    *,
    from_addr: str,
    to_list: list[str],
    subject: str,
    resend_id: str = "",
    message_id: str = "",
    enterprise: str = "",
    origin_notify_target: str = "",
    send_channel: str = "founder_direct",
    store=None,
    now: str = "",
) -> dict[str, Any]:
    """落一条 outbound 事实。**不抛异常**，返回结构化结果。

    ``message_id`` 必须传**发送时真实生成的 RFC Message-ID**（形如
    ``<178945054690.xxx@mail.dealclaw.io>``）：回信是按 ``In-Reply-To`` 匹配的，
    而 ``In-Reply-To`` 里写的就是这个值。若只存本地生成 id，回信永远匹配不到——
    这正是 2026-09-15 那轮“拉到了但没认出来”的真正原因。
    未传时回退为本地 id（仅为兼容旧调用，不推荐）。

    ``origin_notify_target`` 是**发这封邮件的会话**（``oc_`` 群 / ``ou_`` 私聊）：
    买家回信默认投递回这里，而不是 account 级人工绑定。不传/为空时回信走
    旧的 account binding 回退链（向后兼容，旧调用方无需改动）。

    返回 ``{"ok", "account_id", "local_message_id", "error"}``。
    ``ok=False`` 时调用方应把 ``error`` 记录为可见告警（但不得回滚已完成的发送）。
    """
    try:
        if store is None:
            from email_gateway.store import EmailStore  # noqa: PLC0415

            store = EmailStore()
        account_id = resolve_account_id(from_addr, enterprise, store=store)
        if not account_id:
            return {"ok": False, "account_id": "", "local_message_id": "",
                    "error": "account_not_resolved（发件账号未匹配到本租户账号，宁可不落事实）"}
        ts = now or datetime.now(timezone.utc).isoformat()
        import uuid  # noqa: PLC0415

        record = {
            "account_id": account_id,
            "direction": "outbound",
            # 显式渠道标记：本条走 Founder Direct（GS 直发见 dc_record_outbound.py）。
            # quality_metrics 优先读它，不再靠 account_id 名推断。
            "send_channel": str(send_channel or "founder_direct"),
            "message_id": message_id or f"local_{uuid.uuid4().hex[:16]}",
            # store 规范化后真正保留的是 smtp_message_id（回信 In-Reply-To 匹配靠它）
            "smtp_message_id": message_id or "",
            "sender": from_addr,
            "recipients": list(to_list or []),
            "subject": subject,
            "company_id": enterprise,
            "resend_id": resend_id,
            "local_message_id": resend_id or "",
            "origin_notify_target": str(origin_notify_target or "").strip(),
            "provider_status": "accepted",
            "sent_at": ts,
            "created_at": ts,
        }
        store.insert_message(record)
        return {"ok": True, "account_id": account_id,
                "local_message_id": record["local_message_id"], "error": ""}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "account_id": "", "local_message_id": "",
                "error": f"{type(exc).__name__}: {exc}"}


def set_origin_notify_target(*, resend_id: str, notify_target: str, store=None) -> dict:
    """把「发信会话」补写到**已落库**的 outbound 事实。**不抛异常**。

    用途：GS（Resend 直发）的 outbound 事实由 node 侧 ``send.mjs`` →
    ``dc_record_outbound.py`` 落库，发信入口拿到 ``--receipt-target`` 时事实已存在，
    只能定点更新（重新 insert 会写出第二条事实）。

    返回 ``{"ok", "updated", "error"}``。``ok=False`` 时调用方只记告警，
    不得影响发送结果（发信已经成功）。
    """
    try:
        target = str(notify_target or "").strip()
        if not resend_id or not target:
            return {"ok": False, "updated": False,
                    "error": "missing resend_id or notify_target"}
        if store is None:
            from email_gateway.store import EmailStore  # noqa: PLC0415

            store = EmailStore()
        updated = bool(store.set_outbound_notify_target(resend_id, target))
        return {"ok": True, "updated": updated, "error": ""}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "updated": False, "error": f"{type(exc).__name__}: {exc}"}
