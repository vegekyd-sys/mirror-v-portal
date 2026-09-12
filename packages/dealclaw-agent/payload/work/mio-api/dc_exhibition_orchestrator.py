#!/usr/bin/env python3
"""
dc_exhibition_orchestrator.py — 展会经营编排器（影子路由阶段）

定位：用户只看到「展会助手」；底层 skill 独立、互不竞争触发。
本模块实现**影子路由**——只产出「用哪几个能力、按什么顺序、缺什么参数」的决策，
**不执行任何底层 skill、不发邮件、不写业务数据**。

  load_capabilities()  读能力注册表
  load_prompt()        读编排 Prompt
  load_cases()         读路由测试集（自然语言，重点模糊 + 复合）
  build_routing_prompt()  组装：编排 Prompt + 能力清单 + 单条 case
  shadow_route()       单条决策（router 可注入；默认走 openclaw agent）
  run_shadow()         批量跑 + 落决策记录（不执行）

路由依据：用户目标 + 当前展会 + 阶段 + Memory —— 不做关键词硬匹配。
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

DEFAULT_AGENT_ID = "dealclaw"
DEFAULT_TIMEOUT = 180


def _workspace_root() -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root)
    return Path(__file__).resolve().parents[2]


def orch_dir(workspace_root: Optional[str] = None) -> Path:
    root = Path(workspace_root) if workspace_root else _workspace_root()
    return root / "memory" / "projects" / "dealclaw" / "exhibitions" / "orchestrator"


def load_capabilities(workspace_root: Optional[str] = None) -> dict:
    p = orch_dir(workspace_root) / "capabilities.json"
    if not p.exists():
        return {"skills": [], "hard_rules": []}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {"skills": []}
    except (OSError, json.JSONDecodeError):
        return {"skills": [], "hard_rules": []}


def load_prompt(workspace_root: Optional[str] = None) -> str:
    """读「能力自述」（playbook.md）—— 这是 agent 的自我认知，不是路由规则。"""
    base = orch_dir(workspace_root).parent
    for name in ("playbook.md",):
        p = base / name
        if p.exists():
            try:
                return p.read_text(encoding="utf-8")
            except OSError:
                return ""
    return ""


def load_cases(path: Optional[str] = None, workspace_root: Optional[str] = None) -> list:
    p = Path(path) if path else (orch_dir(workspace_root) / "routing-cases.jsonl")
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


# ─────────────────────────────────────────────────────────────
# 组装提示
# ─────────────────────────────────────────────────────────────

def _compact_capabilities(caps: dict) -> str:
    lines = []
    for s in caps.get("skills", []):
        se = s.get("side_effect") or {}
        lines.append(
            f"- {s.get('id')}: can_do={s.get('can_do')}; requires={s.get('requires')}; "
            f"side_effect={{write:{se.get('write')}, send:{se.get('external_send')}}}; "
            f"outputs={s.get('outputs')}"
        )
    return "\n".join(lines)


def build_routing_prompt(case: dict, caps: dict, prompt_md: str) -> str:
    return (
        f"{prompt_md}\n\n"
        "## 当前可用能力（只按 can_do 匹配目标，不撞触发词）\n"
        f"{_compact_capabilities(caps)}\n\n"
        "## 待路由的用户请求\n"
        f"- 用户原话：{case.get('utterance', '')}\n"
        f"- 上下文：{json.dumps(case.get('context') or {}, ensure_ascii=False)}\n\n"
        "## 只输出 JSON（不要解释、不要代码块）：\n"
        '{"goal": "...", "context": {"exhibition": "", "stage": "", "missing_params": []}, '
        '"plan": [{"skill": "", "why": "", "order": 1, "requires_met": true, "missing": []}], '
        '"ask_user": [], "notes": ""}\n'
        "若触发硬规则（GDPR / 拒绝黑名单 / 未授权外发），plan 置空并在 notes 说明拦截原因。\n"
    )


def parse_decision(text: str) -> dict:
    import re
    t = (text or "").strip()
    if not t:
        return {}
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9]*\s*\n?", "", t)
        t = re.sub(r"\n?\s*```\s*$", "", t).strip()
    for cand in (t, (re.search(r"\{.*\}", t, re.S).group(0) if re.search(r"\{.*\}", t, re.S) else "")):
        if not cand:
            continue
        try:
            d = json.loads(cand)
            if isinstance(d, dict):
                return d
        except (json.JSONDecodeError, TypeError):
            continue
    return {"_unparsed": t[:800]}


# ─────────────────────────────────────────────────────────────
# 影子路由
# ─────────────────────────────────────────────────────────────

def _default_router(agent_id: str, prompt: str, timeout: int) -> str:
    from dc_marketing_automation_generator import _default_runner
    return _default_runner(agent_id, prompt, timeout)


def shadow_route(case: dict, *, caps: dict, prompt_md: str,
                 router: Optional[Callable[[str, str, int], str]] = None,
                 agent_id: str = DEFAULT_AGENT_ID, timeout: int = DEFAULT_TIMEOUT) -> dict:
    """单条 case → 路由决策（不执行任何能力）。"""
    from dc_marketing_automation_generator import extract_reply

    router = router or _default_router
    prompt = build_routing_prompt(case, caps, prompt_md)
    stdout = router(agent_id, prompt, timeout)
    reply = extract_reply(stdout)
    return {
        "case_id": case.get("id", ""),
        "utterance": case.get("utterance", ""),
        "tags": case.get("tags", []),
        "expect": case.get("expect", []),
        "decision": parse_decision(reply),
    }


def _planned_skills(decision: dict) -> list:
    return [str(p.get("skill") or "") for p in (decision.get("plan") or []) if isinstance(p, dict)]


def _norm_skills(ids) -> list:
    """归一化能力 id（去 dealclaw- 前缀）——测试集写短 id、模型可能写全 id。"""
    return sorted(str(x).replace("dealclaw-", "").strip() for x in (ids or []) if str(x).strip())


def run_shadow(*, cases_path: Optional[str] = None, workspace_root: Optional[str] = None,
               out_path: Optional[str] = None,
               router: Optional[Callable] = None, limit: Optional[int] = None,
               agent_id: str = DEFAULT_AGENT_ID) -> dict:
    """批量跑路由测试集，落决策记录（不执行）。"""
    caps = load_capabilities(workspace_root)
    prompt_md = load_prompt(workspace_root)
    cases = load_cases(cases_path, workspace_root)
    if limit:
        cases = cases[:limit]

    results = []
    for c in cases:
        r = shadow_route(c, caps=caps, prompt_md=prompt_md, router=router, agent_id=agent_id)
        got = _planned_skills(r["decision"])
        exp = list(r.get("expect") or [])
        r["match"] = (_norm_skills(got) == _norm_skills(exp))
        results.append(r)

    root = Path(workspace_root) if workspace_root else _workspace_root()
    out = Path(out_path) if out_path else (root / "data" / "runtime" / "jobs" / "exhibition-routing-shadow.jsonl")
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    matched = sum(1 for r in results if r.get("match"))
    total = len(results)
    return {
        "cases": total,
        "matched": matched,
        "mismatched": total - matched,
        "out_path": str(out),
        "results": results,
    }


def _cli() -> int:
    ap = argparse.ArgumentParser(description="展会经营编排器（影子路由，不执行）")
    ap.add_argument("--workspace-root", default="")
    ap.add_argument("--cases", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--list-caps", action="store_true", help="只列能力注册表")
    args = ap.parse_args()
    ws = args.workspace_root or None
    if args.list_caps:
        caps = load_capabilities(ws)
        print(json.dumps({"count": len(caps.get("skills", [])),
                          "skills": [s.get("id") for s in caps.get("skills", [])]},
                         ensure_ascii=False, indent=2))
        return 0
    r = run_shadow(cases_path=args.cases or None, workspace_root=ws,
                   out_path=args.out or None, limit=args.limit or None)
    print(json.dumps({k: v for k, v in r.items() if k != "results"}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
