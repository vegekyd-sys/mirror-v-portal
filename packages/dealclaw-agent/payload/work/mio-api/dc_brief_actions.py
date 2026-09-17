#!/usr/bin/env python3
"""dc_brief_actions — 早晚报卡片按钮的回调接线（最轻量）。

按钮（由 `dc_brief_render.default_brief_actions()` 生成）：
  · ``brief:gen_draft``  → 为「今天该做第 N 轮」的买家生成**待确认草稿**（不发送）
  · ``brief:mark_done``  → 把某家标记为已处理（写决策日志，可回放）

硬规则（与全线一致）：
  1. **绝不自动发送**：本模块只生成草稿 / 记状态，发送永远由用户确认。
  2. 硬门槛不可绕：已回复 / 退信 / 拒绝 / 超轮次的买家，即使按钮点名也不动。
  3. 每次动作落一条决策日志（``touch-decisions.jsonl``），可审计。
  4. 认不出的动作**如实报错**，不静默吞掉。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

ACTION_PREFIX = "brief:"
ACTIONS = ("gen_draft", "mark_done")


def parse_action(value: str) -> dict:
    """``brief:gen_draft[:buyer]`` → ``{"action", "buyer", "raw"}``（认不出 action="" ）。"""
    raw = str(value or "").strip()
    if not raw.startswith(ACTION_PREFIX):
        return {"action": "", "buyer": "", "raw": raw}
    body = raw[len(ACTION_PREFIX):]
    parts = [p for p in body.split(":", 1)]
    action = parts[0].strip()
    buyer = parts[1].strip() if len(parts) > 1 else ""
    return {"action": action if action in ACTIONS else "", "buyer": buyer, "raw": raw}


def _due_rows(company_id: str, limit: int) -> tuple[list[dict], str]:
    """取今天该触达的买家（T1 优先）。取不到就返回空 + 原因，不猜。"""
    try:
        from dc_touch_rounds import build_touch_queue  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        return [], f"touch_queue_unavailable:{type(exc).__name__}"
    try:
        queue = build_touch_queue(company_id) or {}
    except Exception as exc:  # noqa: BLE001
        return [], f"touch_queue_failed:{type(exc).__name__}"
    rows = list(queue.get("due_rows") or [])
    rows.sort(key=lambda r: (str(r.get("tier") or "T2") != "T1", str(r.get("due_at") or "")))
    return rows[:limit], ""


def _draft_text(buyer: str, round_no: int, angle: str) -> str:
    """复用既有草稿生成器产出草稿文本（失败则给可读的占位提示，不假装成功）。"""
    try:
        from dc_email_controller.dc_reply_draft import generate_draft_text  # noqa: PLC0415

        text = generate_draft_text("", buyer=buyer, intent=angle or f"第 {round_no} 轮跟进")
        if str(text or "").strip():
            return str(text).strip()
    except Exception:  # noqa: BLE001
        pass
    return f"（{buyer}）第 {round_no} 轮跟进草稿：本轪角度「{angle or '价值强化'}」——待生成正文"


def handle_action(value: str, *, company_id: str = "", chat_id: str = "",
                  open_id: str = "", limit: int = 5, dry_run: bool = True,
                  data_dir=None) -> dict:
    """处理一次卡片按钮回调。**不抛异常**；返回结构化结果（ok / action / items / error）。"""
    parsed = parse_action(value)
    now = datetime.now(timezone.utc).isoformat()
    if not parsed["action"]:
        return {"ok": False, "action": "", "items": [], "at": now,
                "error": f"unknown action: {parsed['raw'] or '(empty)'}"}

    action = parsed["action"]
    if action == "mark_done":
        buyer = parsed["buyer"]
        if not buyer:
            return {"ok": False, "action": action, "items": [], "at": now,
                    "error": "mark_done 需要带上买家（brief:mark_done:<buyer>）"}
        if not dry_run:
            try:
                from dc_brief_render import record_decision  # noqa: PLC0415

                record_decision(data_dir, {"action": "brief_mark_done", "buyer": buyer,
                                           "company_id": company_id, "by": open_id or chat_id,
                                           "source": "brief_card"})
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "action": action, "items": [], "at": now,
                        "error": f"record_failed:{type(exc).__name__}"}
        return {"ok": True, "action": action, "items": [{"buyer": buyer}], "at": now, "error": ""}

    # gen_draft
    rows, reason = _due_rows(company_id, limit)
    if not rows:
        return {"ok": True, "action": action, "items": [], "at": now, "error": "",
                "note": f"今天没有该触达的买家（{reason}）" if reason else "今天没有该触达的买家"}

    items: list[dict] = []
    for row in rows:
        buyer = str(row.get("buyer") or row.get("company") or "")
        round_no = int(row.get("round") or 2)
        angle = str(row.get("angle") or "")
        item = {"buyer": buyer, "round": round_no, "angle": angle, "tier": row.get("tier") or "T2",
                "why": str(row.get("why") or row.get("reason") or ""),
                "draft": _draft_text(buyer, round_no, angle)}
        items.append(item)
        if not dry_run:
            try:
                from dc_brief_render import record_decision  # noqa: PLC0415

                record_decision(data_dir, {"action": "brief_gen_draft", "buyer": buyer,
                                           "round": round_no, "angle": angle,
                                           "company_id": company_id, "source": "brief_card"})
            except Exception:  # noqa: BLE001
                pass  # 日志失败不影响产出草稿
    return {"ok": True, "action": action, "items": items, "at": now, "error": "",
            "note": "草稿已生成，等用户确认后发送（不会自动发）"}


def _cli(argv: list[str] | None = None) -> int:  # pragma: no cover - 手工调试入口
    import argparse
    import json

    ap = argparse.ArgumentParser(description="早晚报卡片按钮回调")
    ap.add_argument("value", help="按钮值，如 brief:gen_draft 或 brief:mark_done:<buyer>")
    ap.add_argument("--company-id", default="")
    ap.add_argument("--apply", action="store_true", help="真的写决策日志（默认 dry-run）")
    args = ap.parse_args(argv)
    out = handle_action(args.value, company_id=args.company_id, dry_run=not args.apply)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_cli())
