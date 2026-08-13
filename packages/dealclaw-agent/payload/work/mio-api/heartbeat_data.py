#!/usr/bin/env python3
"""
heartbeat_data.py — DealClaw Heartbeat 数据写入层

现有引擎 → 本模块 → memory/heartbeat/ 下的 Markdown 表

用法:
    from heartbeat_data import (
        append_email_send,
        append_email_reply,
        upsert_lead_status,
        append_pending_reply,
        init_company_profile,
    )
"""

from __future__ import annotations

import os
from pathlib import Path
from datetime import datetime, timezone, timedelta

_WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
_HEARTBEAT_ROOT = Path(os.environ.get(
    "HEARTBEAT_MEMORY_ROOT",
    str(_WORKSPACE_ROOT / "memory" / "heartbeat"),
))
_MEMORY_ROOT = _WORKSPACE_ROOT / "memory"

_TZ = timezone(timedelta(hours=8))  # Asia/Shanghai


def _now() -> str:
    return datetime.now(_TZ).strftime("%Y-%m-%d %H:%M")


def _ensure_table(path: Path, headers: list[str]) -> None:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        header_row = "| " + " | ".join(headers) + " |"
        sep_row = "|" + "|".join(["---"] * len(headers)) + "|"
        path.write_text(
            f"# {path.stem.replace('-', ' ').title()}\n\n{header_row}\n{sep_row}\n",
            encoding="utf-8",
        )


def _append_row(path: Path, headers: list[str], values: dict[str, str], dedup_key: str = "", dedup_field: str = "") -> None:
    _ensure_table(path, headers)
    # 幂等去重
    if dedup_key and dedup_field:
        try:
            existing = path.read_text(encoding="utf-8")
            needle = f"| {values.get(dedup_field, '')} |"
            if needle in existing:
                return  # 已存在，跳过
        except Exception:
            pass
    row = "| " + " | ".join(values.get(h, "") for h in headers) + " |"
    with path.open("a", encoding="utf-8") as f:
        f.write(row + "\n")


# ── 发送日志 ──────────────────────────────────────────────

EMAIL_SENDS_HEADERS = [
    "sent_at", "message_id", "thread_id", "buyer", "contact",
    "channel", "status", "failure_reason",
]


def append_email_send(
    *,
    sent_at: str = "",
    message_id: str = "",
    thread_id: str = "",
    buyer: str = "",
    contact: str = "",
    channel: str = "email",
    status: str = "sent",
    failure_reason: str = "-",
) -> None:
    """
    dc-gs / dc-fd 发送成功后调用。
    """
    _append_row(
        _MEMORY_ROOT / "sends" / "email-sends.md",
        EMAIL_SENDS_HEADERS,
        {
            "sent_at": sent_at or _now(),
            "message_id": message_id,
            "thread_id": thread_id,
            "buyer": buyer,
            "contact": contact,
            "channel": channel,
            "status": status,
            "failure_reason": failure_reason,
        },
        dedup_key=message_id, dedup_field="message_id",
    )


# ── 回复日志 ──────────────────────────────────────────────

EMAIL_REPLIES_HEADERS = [
    "received_at", "thread_id", "message_id", "buyer", "contact",
    "subject", "intent", "value", "status", "notes",
]


def append_email_reply(
    *,
    received_at: str = "",
    thread_id: str = "",
    message_id: str = "",
    buyer: str = "",
    contact: str = "",
    subject: str = "",
    intent: str = "",
    value: str = "",
    status: str = "needs_reply",
    notes: str = "",
) -> None:
    """
    dc_webhook_poll / dc_iq_engine 处理完回复后调用。
    intent 由 classify_intent() 产出。
    """
    _append_row(
        _MEMORY_ROOT / "replies" / "email-replies.md",
        EMAIL_REPLIES_HEADERS,
        {
            "received_at": received_at or _now(),
            "thread_id": thread_id,
            "message_id": message_id,
            "buyer": buyer,
            "contact": contact,
            "subject": subject,
            "intent": intent,
            "value": value,
            "status": status,
            "notes": notes,
        },
        dedup_key=message_id, dedup_field="message_id",
    )


# ── 线索状态 ──────────────────────────────────────────────

LEAD_STATUS_HEADERS = [
    "buyer", "contact", "priority", "status", "last_touch", "last_reply", "notes",
]


def upsert_lead_status(
    *,
    buyer: str = "",
    contact: str = "",
    priority: str = "normal",
    status: str = "new",
    last_touch: str = "",
    last_reply: str = "",
    notes: str = "",
) -> None:
    """
    dc-find-buyers 入库 / 状态变更时调用。
    按 buyer+contact 双键 upsert：存在则更新，不存在则追加。
    """
    path = _MEMORY_ROOT / "leads" / "lead-status.md"
    _ensure_table(path, LEAD_STATUS_HEADERS)

    touch = last_touch or _now()
    reply = last_reply or (touch if status in {"replied", "interested", "needs_reply"} else "-")

    # 读取现有记录
    existing = []
    if path.exists():
        lines = path.read_text(encoding="utf-8").splitlines()
        in_body = False
        for line in lines:
            if line.startswith("|---"):
                in_body = True
                continue
            if in_body and line.startswith("|") and line.strip("|").strip():
                existing.append(line)

    # 查重
    key = f"| {buyer} | {contact} |"
    updated = False
    new_rows = []
    for row in existing:
        if row.startswith(key):
            updated = True
            new_rows.append(
                f"| {buyer} | {contact} | {priority} | {status} | {touch} | {reply} | {notes} |"
            )
        else:
            new_rows.append(row)

    if not updated:
        new_rows.append(
            f"| {buyer} | {contact} | {priority} | {status} | {touch} | {reply} | {notes} |"
        )

    # 重写
    header_block = f"# Lead Status\n\n| {' | '.join(LEAD_STATUS_HEADERS)} |\n|{'|'.join(['---'] * len(LEAD_STATUS_HEADERS))}|\n"
    path.write_text(header_block + "\n".join(new_rows) + "\n", encoding="utf-8")


# ── 待确认草稿 ────────────────────────────────────────────

PENDING_DRAFT_HEADERS = [
    "created_at", "buyer", "contact", "intent", "risk",
    "draft_path", "needs_user", "status",
]


def append_pending_reply(
    *,
    created_at: str = "",
    buyer: str = "",
    contact: str = "",
    intent: str = "",
    risk: str = "-",
    draft_path: str = "",
    needs_user: str = "true",
    status: str = "pending",
) -> None:
    """
    生成回复草稿后调用。提醒 heartbeat 有需要用户确认的动作。
    """
    _append_row(
        _MEMORY_ROOT / "drafts" / "pending-replies.md",
        PENDING_DRAFT_HEADERS,
        {
            "created_at": created_at or _now(),
            "buyer": buyer,
            "contact": contact,
            "intent": intent,
            "risk": risk,
            "draft_path": draft_path,
            "needs_user": needs_user,
            "status": status,
        },
        dedup_key=draft_path, dedup_field="draft_path",
    )


# ── 企业身份 ──────────────────────────────────────────────

def append_company_profile(
    *,
    company_id: str = "",
    company_name: str = "",
    products: str = "",
    target_markets: str = "",
    buyer_types: str = "",
    profile_version: str = "1",
    confirmed_at: str = "",
) -> None:
    """企业画像确认后调用。幂等: company_id+profile_version 去重。"""
    path = _MEMORY_ROOT / "company" / "profile.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    
    # 幂等检查
    if path.exists():
        existing = path.read_text(encoding="utf-8")
        key = f"profile_version: {profile_version}"
        if key in existing and f"company_id: {company_id}" in existing:
            return  # 已存在，跳过
    
    path.write_text(
        f"# Company Profile\n\n"
        f"company_id: {company_id}\n"
        f"company_name: {company_name}\n"
        f"products: {products}\n"
        f"target_markets: {target_markets}\n"
        f"buyer_types: {buyer_types}\n"
        f"profile_version: {profile_version}\n"
        f"confirmed_at: {confirmed_at or _now()}\n"
        f"timezone: Asia/Shanghai\n",
        encoding="utf-8",
    )


def init_company_profile(
    company_name: str = "",
    tenant_id: str = "",
    owner_user_id: str = "",
    timezone: str = "Asia/Shanghai",
) -> None:
    """项目首次使用时调用一次。"""
    append_company_profile(
        company_id=tenant_id or "default",
        company_name=company_name,
        profile_version="1",
    )


# ── CLI 测试 ──────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("用法: python3 heartbeat_data.py <test|init>")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "test":
        buyer = "Test Buyer"
        contact = "test@example.com"
        print("写测试数据...")

        append_email_send(buyer=buyer, contact=contact, message_id="test_msg_001")
        print("  ✅ email-sends")

        append_email_reply(
            buyer=buyer, contact=contact,
            message_id="test_msg_001", thread_id="test_th_001",
            subject="Test inquiry", intent="quote_request",
            value="high", notes="测试回复",
        )
        print("  ✅ email-replies")

        upsert_lead_status(
            buyer=buyer, contact=contact,
            priority="high", status="interested",
            notes="测试线索",
        )
        print("  ✅ lead-status")

        append_pending_reply(
            buyer=buyer, contact=contact,
            intent="quote_request", risk="缺交期",
            draft_path="drafts/test.md",
        )
        print("  ✅ pending-replies")

        print("\n[test] 数据写入函数验证完成（提醒脚本已移除）")

    elif cmd == "init":
        init_company_profile(
            company_name=sys.argv[2] if len(sys.argv) > 2 else "TestCo",
            tenant_id=sys.argv[3] if len(sys.argv) > 3 else "t001",
            owner_user_id=sys.argv[4] if len(sys.argv) > 4 else "ou_test",
        )
        print("✅ company/profile.md 已初始化")
