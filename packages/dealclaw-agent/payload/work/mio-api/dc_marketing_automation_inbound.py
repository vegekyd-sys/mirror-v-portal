#!/usr/bin/env python3
"""
dc_marketing_automation_inbound.py — 展自动营销「入站」触发桥

买家回复 → 触发已有的 **dealclaw-smart-reply（DC-IQ 询盘处理引擎）** 处理。
本层只做「发现新回复 → 触发」，**不自己实现意图识别/回复**（那归 smart-reply）。

数据流：
    EmailStore.list_inbound_records()  读入站回复
      → select_new_replies()           按游标去重（只取新回复）
      → build_smart_reply_prompt()     组装处理提示（复用 smart-reply 口径）
      → trigger_smart_reply()          `openclaw agent --agent dealclaw` 触发
      → 记录游标

边界：
  - 安全闸由 smart-reply 守：资料不足 / 会议 / 拒绝 / 低置信度 → 断点通知，不自动回。
  - 游标（临时任务状态）落 `data/runtime/jobs/`，不写 memory。
  - runner 可注入（测试 / 自定义通道）。
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

STATE_FILENAME = "marketing-inbound-state.json"


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def _state_path(workspace_root: Optional[str] = None) -> Path:
    root = Path(workspace_root) if workspace_root else _workspace_root()
    return root / "data" / "runtime" / "jobs" / STATE_FILENAME


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_state(workspace_root: Optional[str] = None) -> dict:
    p = _state_path(workspace_root)
    if not p.exists():
        return {"seen_ids": [], "updated_at": None}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"seen_ids": [], "updated_at": None}
    if not isinstance(d, dict):
        return {"seen_ids": [], "updated_at": None}
    d.setdefault("seen_ids", [])
    return d


def save_state(workspace_root: Optional[str], state: dict) -> Path:
    p = _state_path(workspace_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    state = dict(state)
    state["updated_at"] = _now()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return p


def _reply_id(r: dict) -> str:
    return str(r.get("resend_id") or r.get("local_message_id") or r.get("id") or "")


def _sender_of(r: dict) -> str:
    for k in ("from", "sender", "from_email", "reply_to"):
        v = r.get(k)
        if isinstance(v, list):
            v = v[0] if v else ""
        if v:
            return str(v)
    return ""


def select_new_replies(records: list, seen_ids: set, limit: int = 50) -> list:
    """纯函数：从入站记录里挑出「未处理过」的回复（游标 + 批内同 id 双重去重）。"""
    out = []
    picked: set = set()
    for r in (records or []):
        if not isinstance(r, dict):
            continue
        rid = _reply_id(r)
        if not rid or rid in seen_ids or rid in picked:
            continue
        picked.add(rid)
        out.append({**r, "_id": rid})
        if len(out) >= limit:
            break
    return out


def build_smart_reply_prompt(reply: dict) -> str:
    """复用 dealclaw-smart-reply 口径的处理提示（本层不写回复内容）。"""
    return (
        "你是出海精灵小元。收到一封买家回复，请按 skill `dealclaw-smart-reply`（DC-IQ 询盘处理引擎）处理：\n"
        "1) 先过滤：自动回复/OOO/退信 → 静默丢弃，不通知；\n"
        "2) 识别意图并迁移买家状态（Stage0 未建联 → Stage5 销售跟进）；\n"
        "3) 资料充足 → 生成回复草稿（走 dc_reply_draft，不直接发）；"
        "资料不足 / 约会议 / 拒绝 / 低置信度 → 飞书断点通知用户；\n"
        "4) 到达 Stage4（预约会议）→ 交还用户，DC-IQ 退出。\n\n"
        "【本封回复】\n"
        f"- 发件人：{_sender_of(reply)}\n"
        f"- 主题：{reply.get('subject', '')}\n"
        f"- 正文：\n{reply.get('text') or reply.get('body') or ''}\n"
    )


def trigger_smart_reply(reply: dict, *, agent_id: str = "dealclaw",
                        timeout: int = 180,
                        runner: Optional[Callable[[str, str, int], str]] = None) -> dict:
    """触发 smart-reply（默认走 openclaw agent CLI）。返回触发结果。"""
    from dc_marketing_automation_generator import _default_runner, extract_reply

    runner = runner or _default_runner
    prompt = build_smart_reply_prompt(reply)
    stdout = runner(agent_id, prompt, timeout)
    return {
        "reply_id": reply.get("_id", ""),
        "triggered": True,
        "agent_output": extract_reply(stdout),
    }


def run_inbound_cycle(company_id: str, *, workspace_root: Optional[str] = None,
                      agent_id: str = "dealclaw", timeout: int = 180,
                      runner: Optional[Callable] = None, dry_run: bool = True,
                      limit: int = 50) -> dict:
    """扫入站回复 → 触发 smart-reply。dry_run=True 只列不触发。"""
    from email_gateway.store import EmailStore

    store = EmailStore()
    try:
        records = store.list_inbound_records(company_id=company_id)
    except Exception as e:  # noqa: BLE001
        return {"company_id": company_id, "error": f"{type(e).__name__}: {e}",
                "new_replies": 0, "results": []}

    state = load_state(workspace_root)
    seen = set(state.get("seen_ids", []))
    new = select_new_replies(records, seen, limit)

    results = []
    for r in new:
        if dry_run:
            results.append({"reply_id": r["_id"], "disposition": "would_trigger_dry_run"})
            continue
        out = trigger_smart_reply(r, agent_id=agent_id, timeout=timeout, runner=runner)
        results.append({"reply_id": r["_id"], "disposition": "triggered",
                        "agent_output_len": len(out.get("agent_output", ""))})
        state.setdefault("seen_ids", []).append(r["_id"])

    if not dry_run and new:
        save_state(workspace_root, state)

    return {
        "company_id": company_id,
        "dry_run": dry_run,
        "inbound_total": len(records),
        "new_replies": len(new),
        "results": results,
    }


def _cli() -> int:
    ap = argparse.ArgumentParser(description="展自动营销入站触发桥（回复 → smart-reply）")
    ap.add_argument("--company-id", required=True)
    ap.add_argument("--workspace-root", default="")
    ap.add_argument("--no-dry-run", action="store_true", help="真正触发（默认 dry_run）")
    ap.add_argument("--agent-id", default="dealclaw")
    ap.add_argument("--limit", type=int, default=50)
    args = ap.parse_args()

    result = run_inbound_cycle(
        args.company_id, workspace_root=args.workspace_root or None,
        agent_id=args.agent_id, dry_run=not args.no_dry_run, limit=args.limit)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
