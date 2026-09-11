#!/usr/bin/env python3
"""review-reflections.py — 生成 reflection 审核候选（不自动修改系统）

目标模型：**分发前「测试母体」学习；分发后独立分身本地学习**（不是多租户学习平台）。
本脚本在测试母体上读取两类 reflection，把它们分类成改进候选，人工/多租户门槛通过后
才由人落到对应位置。脚本本身**只读 + 只写候选文件**，绝不改代码/Skill/知识库。

输入（测试母体）：
  - agent 层：{workspace}/memory/reflections/*.jsonl
      （字段 context/what_worked/what_failed/next_time/tags/session_type/confidence/created_at）
  - 业务层：{workspace}/memory/projects/dealclaw/reflections.jsonl
      （字段 ts/type/what/how/user；type = preference/fact/pattern/correction）

输出（候选，非最终改动）：
  {out}/candidates-<YYYY-MM-DD>.md  +  .json

固定 5 分类与去向：
  bug                 → 代码 + 回归测试
  skill_improvement   → Skill / 规则
  industry_knowledge  → 脱敏后落通用知识（industry-knowledge.md）
  tenant_only         → 只留本地分身，不进 payload
  ignore              → 噪声/一次性，忽略

用法：
  python3 scripts/review-reflections.py [--workspace DIR] [--out DIR] [--since YYYY-MM-DD] [--json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

CLASSES = ("bug", "skill_improvement", "industry_knowledge", "tenant_only", "ignore")
TARGETS = {
    "bug": "代码 + 回归测试",
    "skill_improvement": "Skill / 规则",
    "industry_knowledge": "通用知识（industry-knowledge.md，脱敏后）",
    "tenant_only": "仅本地分身（不进 payload）",
    "ignore": "忽略",
}

BUG_HINTS = ("bug", "error", "crash", "fail", "broken", "regression", "报错", "异常",
             "失败", "失效", "不生效", "修", "缺陷", "坑", "错", "崩溃", "宕", "超时",
             "不可用", "漏", "丢")
SKILL_HINTS = ("skill", "workflow", "process", "script", "流程", "步骤", "复用", "自动",
               "脚本", "pipeline", "部署", "规则", "规范", "统一", "必须", "禁止", "先", "再")
TENANT_HINTS = ("只做", "不碰", "我的", "我们", "我司", "主打", "目标市场", "排除",
                "偏好", "语气", "报价策略", "我的产品", "不感兴趣", "本企业")
INDUSTRY_HINTS = ("买家", "展会", "国家", "认证", "hs", "语种", "行业", "市场", "巴西",
                  "墨西哥", "南非", "德国", "越南", "印尼", "经销商", "制造商", "品牌商",
                  "工程商", "交期", "moq", "关务", "清关", "税", "hs code")

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}")
_OPENID_RE = re.compile(r"\bou_[0-9a-f]{16,}\b")
_PHONE_RE = re.compile(r"(?<!\d)(?:\+?\d[\d\s-]{7,}\d)(?!\d)")


def _has_any(text: str, hints) -> bool:
    t = (text or "").lower()
    return any(h.lower() in t for h in hints)


def desensitize(text: str) -> str:
    """脱敏：去邮箱 / open_id / 电话（公司名等仍需人工复核）。"""
    s = _EMAIL_RE.sub("<email>", text or "")
    s = _OPENID_RE.sub("<open_id>", s)
    s = _PHONE_RE.sub("<phone>", s)
    return s


def classify_agent(entry: dict) -> tuple[str, str]:
    failed = str(entry.get("what_failed") or "")
    worked = str(entry.get("what_worked") or "")
    nextt = str(entry.get("next_time") or "")
    tags = " ".join(entry.get("tags") or []) if isinstance(entry.get("tags"), list) else str(entry.get("tags") or "")
    if failed.strip() and _has_any(failed, BUG_HINTS):
        return "bug", f"agent 层 what_failed 含缺陷特征：{failed[:40]}"
    if _has_any(worked + " " + nextt + " " + tags, SKILL_HINTS):
        return "skill_improvement", "agent 层含可复用流程/规则特征（what_worked/next_time/tags）"
    return "ignore", "agent 层仅信息性，无缺陷也无可复用规则"


def classify_business(entry: dict) -> tuple[str, str]:
    t = str(entry.get("type") or "")
    what = str(entry.get("what") or "")
    how = str(entry.get("how") or "")
    blob = f"{what} {how}"
    if t in ("preference", "correction"):
        return "tenant_only", f"业务层 {t}：租户个人偏好/纠正，不进共享层"
    if _has_any(blob, TENANT_HINTS):
        return "tenant_only", "业务层含租户专属选择（目标市场/产品/排除/偏好）"
    if _has_any(blob, INDUSTRY_HINTS):
        return "industry_knowledge", "业务层为行业级事实/规律且无租户专属标识"
    return "tenant_only", "业务层未识别为行业级，默认留租户层"


def _iter_agent(workspace: Path, since: str = "") -> list[dict]:
    d = workspace / "memory" / "reflections"
    out = []
    if not d.exists():
        return out
    for p in sorted(d.glob("*.jsonl")):
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if since and str(e.get("created_at") or "")[:10] < since:
                continue
            out.append(e)
    return out


def _iter_business(workspace: Path, since: str = "") -> list[dict]:
    p = workspace / "memory" / "projects" / "dealclaw" / "reflections.jsonl"
    out = []
    if not p.exists():
        return out
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if since and str(e.get("ts") or "")[:10] < since:
            continue
        out.append(e)
    return out


def build_candidates(workspace: Path, since: str = "") -> list[dict]:
    cands: list[dict] = []
    for e in _iter_agent(workspace, since):
        cls, reason = classify_agent(e)
        cands.append({
            "source": "agent", "classification": cls, "reason": reason,
            "summary": str(e.get("context") or ""),
            "detail": str(e.get("next_time") or e.get("what_failed") or ""),
            "raw": e, "proposed_target": TARGETS[cls],
            "proposed_payload": desensitize(str(e.get("next_time") or "")) if cls == "industry_knowledge" else "",
        })
    for e in _iter_business(workspace, since):
        cls, reason = classify_business(e)
        cands.append({
            "source": "business", "classification": cls, "reason": reason,
            "summary": str(e.get("what") or ""),
            "detail": str(e.get("how") or ""),
            "raw": e, "proposed_target": TARGETS[cls],
            "proposed_payload": desensitize(str(e.get("what") or "")) if cls == "industry_knowledge" else "",
        })
    return cands


def render_md(cands: list[dict], generated_at: str) -> str:
    lines = ["# Reflection 审核候选（分发前测试母体）", "",
             f"> 生成：{generated_at} · 共 {len(cands)} 条 · **只读候选，本文件不自动改系统**",
             "> 分类：bug → 代码+回归测试；skill_improvement → Skill/规则；",
             "> industry_knowledge → 脱敏后落通用知识；tenant_only → 不进 payload；ignore → 忽略。", ""]
    for cls in CLASSES:
        group = [c for c in cands if c["classification"] == cls]
        lines.append(f"## {cls}（{len(group)}）→ {TARGETS[cls]}")
        if not group:
            lines.append("- （无）")
        for c in group:
            lines.append(f"- [{c['source']}] {c['summary']}｜{c['detail']}".rstrip("｜"))
            lines.append(f"  - 理由：{c['reason']}")
            if c["proposed_payload"]:
                lines.append(f"  - 脱敏后拟落通用知识：{c['proposed_payload']}")
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 reflection 审核候选（不改系统）")
    ap.add_argument("--workspace", default="", help="workspace 根（默认脚本上两级）")
    ap.add_argument("--out", default="", help="候选输出目录（默认 {workspace}/memory/reflection-review）")
    ap.add_argument("--since", default="", help="只看该日期(YYYY-MM-DD)之后的 reflection")
    ap.add_argument("--json", action="store_true", help="额外打印 JSON 摘要")
    args = ap.parse_args()

    ws = Path(args.workspace).expanduser() if args.workspace else Path(__file__).resolve().parents[1]
    out_dir = Path(args.out).expanduser() if args.out else ws / "memory" / "reflection-review"
    out_dir.mkdir(parents=True, exist_ok=True)

    cands = build_candidates(ws, args.since)
    today = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
    generated_at = datetime.now(timezone.utc).isoformat()

    md_path = out_dir / f"candidates-{today}.md"
    md_path.write_text(render_md(cands, generated_at), encoding="utf-8")
    json_path = out_dir / f"candidates-{today}.json"
    json_path.write_text(json.dumps({"generated_at": generated_at, "candidates": cands},
                                    ensure_ascii=False, indent=2), encoding="utf-8")

    counts = {c: sum(1 for x in cands if x["classification"] == c) for c in CLASSES}
    print(f"[review-reflections] {len(cands)} 条候选 → {md_path}")
    print(f"[review-reflections] 分类统计：{counts}（只生成候选，不改系统）")
    if args.json:
        print(json.dumps({"counts": counts, "md": str(md_path), "json": str(json_path)},
                         ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
