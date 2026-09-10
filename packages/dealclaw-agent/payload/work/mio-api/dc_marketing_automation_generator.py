#!/usr/bin/env python3
"""
dc_marketing_automation_generator.py — 展自动营销「正文生成器」（agent 驱动）

把 dc_marketing_automation_send 的 generator 接成实体：走 OpenClaw agent turn，
由**出海精灵小元**按对应 skill 的口径生成正文。

数据流：
    task（含 content_route / 买家 / 公司 / 展会）
      → load_skill_principles()  读对应 SKILL.md（内容口径，原样复用，不新增模板）
      → build_prompt()           组装提示（口径 + 上下文 + 输出 JSON 契约）
      → runner()                 默认 `openclaw agent --agent dealclaw ... --json`
      → extract_reply()          取 result.payloads[].text
      → parse_content()          解析 {"subject","text"}

职责边界：
  - 内容口径 100% 来自 skill（invitation / growth-send），本模块**不写模板**。
  - runner 可注入，便于测试 / 换 LLM。
  - 生成失败返回空 text，交由 send_one 的 empty_content 守卫拦截（不裸发）。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

DEFAULT_AGENT_ID = "dealclaw"
DEFAULT_TIMEOUT = 180
MAX_PRINCIPLES_CHARS = 12000

# content_route → skill 目录
SKILL_DIRS = {
    "dealclaw-exhibition-invitation": "dealclaw-exhibition-invitation",
    "dealclaw-email-growth-send": "dealclaw-email-growth-send",
}

ACTION_LABELS = {
    "first_invite": "首邀（首次邀请买家来展位）",
    "second_invite": "二次邀约（已邀约未到场，再邀请）",
    "onsite_followup": "到场跟进（展位已见面，跟进）",
    "missed_meeting_reengage": "到场再触达（到场但未商洽，再约）",
}


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


# ─────────────────────────────────────────────────────────────
# 1. 读 skill 内容口径（原样复用）
# ─────────────────────────────────────────────────────────────

def load_skill_principles(content_route: str, workspace_root: Optional[str] = None) -> str:
    """读 content_route 对应 skill 的 SKILL.md 全文（内容口径）。找不到返回空串。"""
    d = SKILL_DIRS.get(content_route)
    if not d:
        return ""
    root = Path(workspace_root) if workspace_root else _workspace_root()
    p = root / "skills" / d / "SKILL.md"
    if not p.exists():
        return ""
    try:
        return p.read_text(encoding="utf-8")[:MAX_PRINCIPLES_CHARS]
    except OSError:
        return ""


# ─────────────────────────────────────────────────────────────
# 2. 组装提示
# ─────────────────────────────────────────────────────────────

def build_prompt(task: dict, principles: str) -> str:
    """组装生成提示：skill 口径 + 任务上下文 + 严格 JSON 输出契约。"""
    action = task.get("action", "")
    return (
        "你是出海精灵小元。请为下面这封展会营销邮件生成内容。\n\n"
        f"【内容口径】严格遵循 skill: {task.get('content_route', '')}\n"
        f"{principles}\n\n"
        "【任务上下文】\n"
        f"- 动作：{ACTION_LABELS.get(action, action)}\n"
        f"- 买家邮箱：{task.get('buyer_email', '')}\n"
        f"- 公司：{task.get('company_name', '')}\n"
        f"- 展会：{task.get('exhibition_name', '')}\n"
        f"- 建议标题：{task.get('suggested_subject', '')}\n\n"
        "【输出要求】\n"
        "只输出一个 JSON 对象，不要解释、不要 markdown 代码块：\n"
        '{"subject": "邮件标题", "text": "纯文本正文"}\n'
        "- 严格遵守上面的内容口径（含反垃圾约束；growth-send 不套死模板）。\n"
        "- text 为纯文本，不要 HTML。\n"
    )


# ─────────────────────────────────────────────────────────────
# 3. 调用 agent（默认 openclaw CLI）
# ─────────────────────────────────────────────────────────────

def _default_runner(agent_id: str, prompt: str, timeout: int) -> str:
    """默认 runner：`openclaw agent --agent <id> --thinking off --message-file <tmp> --json`。

    不加 --deliver（不往渠道发消息，只取回复）。
    """
    fd, path = tempfile.mkstemp(suffix=".txt", prefix="ma-prompt-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(prompt)
        r = subprocess.run(
            ["openclaw", "agent", "--agent", agent_id, "--thinking", "off",
             "--message-file", path, "--json"],
            capture_output=True, text=True, timeout=timeout,
        )
        return r.stdout or ""
    except subprocess.TimeoutExpired:
        return ""
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def extract_reply(stdout: str) -> str:
    """从 `openclaw agent --json` 输出取回复文本：result.payloads[].text。"""
    try:
        d = json.loads(stdout or "")
    except (json.JSONDecodeError, TypeError):
        return ""
    res = d.get("result") if isinstance(d, dict) else None
    if not isinstance(res, dict):
        return ""
    for p in (res.get("payloads") or []):
        if isinstance(p, dict) and p.get("text"):
            return str(p["text"])
    return ""


# ─────────────────────────────────────────────────────────────
# 4. 解析正文
# ─────────────────────────────────────────────────────────────

def parse_content(reply: str) -> dict:
    """从模型回复解析 {subject, text}。容忍代码块；解析失败时整段当 text。"""
    t = (reply or "").strip()
    if not t:
        return {}
    # 去 markdown 代码块包裹
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9]*\s*\n?", "", t)
        t = re.sub(r"\n?\s*```\s*$", "", t).strip()
    for candidate in (t, (re.search(r"\{.*\}", t, re.S).group(0)
                          if re.search(r"\{.*\}", t, re.S) else "")):
        if not candidate:
            continue
        try:
            d = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(d, dict):
            text = d.get("text") or d.get("body") or ""
            subject = d.get("subject") or ""
            if text:
                return {"subject": subject, "text": str(text)}
    # 兜底：整段当正文（模型被要求只输出 JSON；非 JSON 时大概率就是正文）
    return {"subject": "", "text": t}


# ─────────────────────────────────────────────────────────────
# 5. generator 入口（可直接传给 send_one / run_send_cycle）
# ─────────────────────────────────────────────────────────────

def openclaw_generator(
    task: dict,
    *,
    agent_id: str = DEFAULT_AGENT_ID,
    workspace_root: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
    runner: Optional[Callable[[str, str, int], str]] = None,
) -> dict:
    """按 content_route 复用 skill 口径生成正文。返回 {subject, text}。

    runner(agent_id, prompt, timeout) -> stdout(str)，默认走 openclaw CLI，可注入。
    生成失败 → text 为空，交由 send_one 拦截（不裸发）。
    """
    runner = runner or _default_runner
    principles = load_skill_principles(task.get("content_route", ""), workspace_root)
    prompt = build_prompt(task, principles)
    stdout = runner(agent_id, prompt, timeout)
    reply = extract_reply(stdout)
    content = parse_content(reply)
    if content and not content.get("subject"):
        content["subject"] = task.get("suggested_subject", "")
    return content or {"subject": task.get("suggested_subject", ""), "text": ""}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="展自动营销正文生成器（agent 驱动，调试用）")
    ap.add_argument("--content-route", required=True)
    ap.add_argument("--action", default="")
    ap.add_argument("--buyer-email", default="")
    ap.add_argument("--company-name", default="")
    ap.add_argument("--exhibition-name", default="")
    ap.add_argument("--agent-id", default=DEFAULT_AGENT_ID)
    args = ap.parse_args()

    out = openclaw_generator({
        "content_route": args.content_route, "action": args.action,
        "buyer_email": args.buyer_email, "company_name": args.company_name,
        "exhibition_name": args.exhibition_name,
    }, agent_id=args.agent_id)
    print(json.dumps(out, ensure_ascii=False, indent=2))
