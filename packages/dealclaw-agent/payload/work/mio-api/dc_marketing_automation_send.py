#!/usr/bin/env python3
"""
dc_marketing_automation_send.py — 展自动营销「内容生成 + 发送」桥接（最后一环）

把 dispatch 产出的 pending 草稿接上完整链路：

    pending 草稿（含 content_route）
      → build_content_task()   组装生成任务（买家/公司/展会/动作/skill 路由）
      → generator(task)        正文生成（**模型职责**；本模块不内置任何模板）
      → update_draft()         正文写回草稿
      → send_fn()              发送（默认 dc_reply_draft.confirm_and_send，含 buyer_blocked 拦截）
      → complete_automation()  发送成功 → 关闭 automation（execution_ref=resend_id）

职责边界（对齐 spec 约束 4/5）：
  - 本层不产正文：generator 必须注入（生产由 agent 轮 / LLM 提供，按对应 skill 生成）。
    - 邀约类 content_route=dealclaw-exhibition-invitation
    - 跟进类 content_route=dealclaw-email-growth-send
  - 硬护栏（时区窗口 / 退订 / buyer_blocked / 日限额）不在本层重写，由发送链路与发送前置检查负责。
  - requires_approval=True 的草稿**不自动发**，列为待确认。
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from dc_marketing_automation import complete_automation


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────
# 1. 列出 dispatch 产出的待发草稿
# ─────────────────────────────────────────────────────────────

def list_pending_marketing_drafts(company_id: str) -> list:
    """列出 dispatch 产出的 pending 草稿（带 automation_id 标记的即是）。"""
    from dc_email_controller.dc_reply_draft import list_drafts
    drafts = list_drafts(company_id=company_id, status="pending_confirmation")
    return [d for d in drafts if isinstance(d, dict) and d.get("automation_id")]


# ─────────────────────────────────────────────────────────────
# 2. 组装内容生成任务（给模型/agent 的结构化输入）
# ─────────────────────────────────────────────────────────────

def build_content_task(draft: dict) -> dict:
    """把草稿转成「内容生成任务」。

    只做事实组装，不写正文、不给模板。generator 据此按对应 skill 生成。
    """
    return {
        "draft_id": draft.get("draft_id", ""),
        "action": draft.get("automation_action", ""),
        "content_route": draft.get("content_route", ""),      # 指向负责生成内容的 skill
        "company_id": draft.get("company_id", ""),
        "company_name": draft.get("company_name", ""),
        "buyer_email": draft.get("buyer_email", ""),
        "exhibition_name": draft.get("exhibition_name", ""),
        "suggested_subject": draft.get("subject", ""),
        "requires_approval": bool(draft.get("automation_requires_approval", True)),
        "automation_id": draft.get("automation_id", ""),
    }


# ─────────────────────────────────────────────────────────────
# 3. 发送单条（默认走 confirm_and_send）
# ─────────────────────────────────────────────────────────────

def _default_send(draft_id: str, confirmed_by: str = "") -> dict:
    from dc_email_controller.dc_reply_draft import confirm_and_send
    return confirm_and_send(draft_id, confirmed_by=confirmed_by)


def send_via_email_channel(draft_id: str, confirmed_by: str = "", *,
                           channel: str = "GS", from_addr: str = "",
                           enterprise: str = "", receipt_target: str = "") -> dict:
    """营销发送通道：读草稿 → dc_email_send.send_batch（GS/FD，自动退订+追踪+批次回执）。

    对应两个营销 skill 记载的发送入口（`dc_email_send.py`），与回复用的
    confirm_and_send 区分。可作为 send_one 的 send_fn 注入。
    """
    from dc_email_controller.dc_reply_draft import get_draft, update_draft
    from dc_email_send import send_batch

    d = get_draft(draft_id)
    if not d:
        return {"status": "error", "error": "draft_not_found", "draft_id": draft_id}
    r = send_batch(
        channel=channel, from_addr=from_addr,
        to_list=[d.get("buyer_email", "")],
        subject=d.get("subject", ""), text=d.get("text", ""),
        html=d.get("html", "") or "", receipt_target=receipt_target,
        enterprise=enterprise or d.get("company_id", ""),
    )
    ok = bool(r.get("success"))
    resend_id = r.get("resend_id", "") or ""
    if ok:
        # 回写草稿状态，避免下一轮重复发送
        update_draft(draft_id, status="sent", message_id=resend_id,
                     sent_at=_now(), failure_reason="")
    return {
        "status": "sent" if ok else "failed",
        "resend_id": resend_id,
        "error": r.get("error", ""),
        "channel": channel,
    }


def send_one(company_id: str, draft_id: str, generator: Callable[[dict], Any], *,
             send_fn: Optional[Callable] = None,
             confirmed_by: str = "",
             workspace_root: Optional[str] = None) -> dict:
    """生成正文 → 写回草稿 → 发送 → 成功则关闭 automation。

    generator(task) 返回 str（正文）或 dict：{subject, text, html}。
    send_fn(draft_id, confirmed_by) 默认 confirm_and_send，可注入（测试/自定义通道）。
    """
    from dc_email_controller.dc_reply_draft import get_draft, update_draft

    send_fn = send_fn or _default_send
    draft = get_draft(draft_id)
    if not draft:
        return {"status": "error", "error": "draft_not_found", "draft_id": draft_id}
    if draft.get("status") != "pending_confirmation":
        return {"status": "skip", "draft_id": draft_id, "draft_status": draft.get("status")}

    task = build_content_task(draft)
    content = generator(task)
    if isinstance(content, str):
        content = {"text": content}
    if not isinstance(content, dict):
        return {"status": "error", "error": "bad_generator_output", "draft_id": draft_id}

    text = (content.get("text") or "").strip()
    if not text:
        return {"status": "error", "error": "empty_content", "draft_id": draft_id}

    subject = content.get("subject") or draft.get("subject") or ""
    update_draft(draft_id, subject=subject, text=text,
                 html=content.get("html", "") or "")

    res = send_fn(draft_id, confirmed_by=confirmed_by)
    if isinstance(res, dict) and res.get("status") == "sent":
        complete_automation(company_id, draft.get("automation_id", ""),
                            status="completed",
                            execution_ref=res.get("resend_id", "") or "",
                            workspace_root=workspace_root)
        return {**res, "draft_id": draft_id, "action": task["action"],
                "content_route": task["content_route"]}
    return {**({"status": "failed"} if not isinstance(res, dict) else res),
            "draft_id": draft_id}


# ─────────────────────────────────────────────────────────────
# 4. 批量编排
# ─────────────────────────────────────────────────────────────

def run_send_cycle(company_id: str, generator: Callable[[dict], Any], *,
                   send_fn: Optional[Callable] = None,
                   confirmed_by: str = "",
                   workspace_root: Optional[str] = None,
                   dry_run: bool = True) -> dict:
    """遍历 pending 草稿：requires_approval=False → 自动发；True → 列待确认。

    dry_run=True 时不生成正文、不发送，只列清单。
    """
    drafts = list_pending_marketing_drafts(company_id)
    results: list = []
    sent = pending_approval = failed = 0

    for d in drafts:
        did = d.get("draft_id", "")
        entry = {
            "draft_id": did,
            "action": d.get("automation_action", ""),
            "content_route": d.get("content_route", ""),
            "requires_approval": bool(d.get("automation_requires_approval", True)),
            "disposition": "",
        }
        if entry["requires_approval"]:
            entry["disposition"] = "pending_approval"
            pending_approval += 1
            results.append(entry)
            continue
        if dry_run:
            entry["disposition"] = "would_send_dry_run"
            results.append(entry)
            continue
        r = send_one(company_id, did, generator, send_fn=send_fn,
                     confirmed_by=confirmed_by, workspace_root=workspace_root)
        if r.get("status") == "sent":
            entry["disposition"] = "sent"
            entry["resend_id"] = r.get("resend_id", "")
            sent += 1
        else:
            entry["disposition"] = f"failed:{r.get('error') or r.get('reason') or r.get('status')}"
            failed += 1
        results.append(entry)

    return {
        "company_id": company_id,
        "dry_run": dry_run,
        "now": _now(),
        "pending_total": len(drafts),
        "sent": sent,
        "pending_approval": pending_approval,
        "failed": failed,
        "results": results,
    }


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

def _cli() -> int:
    ap = argparse.ArgumentParser(description="展自动营销：内容生成 + 发送桥接")
    ap.add_argument("--company-id", required=True)
    ap.add_argument("--list", action="store_true", help="只列待发草稿，不生成/不发送")
    args = ap.parse_args()

    if args.list:
        drafts = list_pending_marketing_drafts(args.company_id)
        print(json.dumps({"count": len(drafts),
                          "drafts": [build_content_task(d) for d in drafts]},
                         ensure_ascii=False, indent=2))
        return 0

    # 非 list 模式需要 generator（生产由 agent/LLM 提供），此处仅提示
    print(json.dumps({
        "hint": "正文生成需注入 generator（agent 轮 / LLM）。CLI 仅支持 --list；"
                "生产调用 run_send_cycle(company_id, generator, ...)。",
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
