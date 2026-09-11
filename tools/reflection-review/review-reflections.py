#!/usr/bin/env python3
"""review-reflections.py — 生成 reflection 审核候选（分发前测试母体工具，不进 payload）

位置：tools/reflection-review/（**测试母体工具**，不属于 payload 制品）。
payload 只保留两个 writer（write-reflection.py / write-business-reflection.py）与空 memory 目录。

目标模型：**分发前「测试母体」学习；分发后独立分身本地学习**。
本脚本只读两类 reflection、分类成候选，**绝不改代码/Skill/知识库**。

安全：**所有类别都必须脱敏**（邮箱/open_id/电话/URL/域名/长数字 ID）；
tenant_only 只输出**脱敏摘要**（不含租户专属细节；细节仅本地分身可见）。

输出：`data/reflection-review/candidates/candidates-<YYYY-MM-DD>.{md,json}`（默认不进 Git）。

固定 5 分类与去向：
  bug → 代码 + 回归测试；skill_improvement → Skill/规则；
  industry_knowledge → 脱敏后落通用知识；tenant_only → 不进 payload；ignore → 忽略。
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
# industry_knowledge 仅限「行业/市场/产品/认证/渠道/买家行为」领域知识
INDUSTRY_HINTS = ("买家行为", "采购行为", "采购", "渠道", "分销", "经销", "零售商", "批发",
                  "认证", "标准", "合规", "hs code", "关税", "清关", "语种",
                  "行业", "市场", "产品类目", "类目", "买家类型", "制造商", "品牌商", "工程商")
# skill_improvement：Agent 如何表达/分析/排序/执行（Daily Brief/Advisor 的 playbook）
AGENT_METHOD_HINTS = ("表达", "措辞", "文案", "叙事", "简洁", "格式", "展示", "呈现",
                      "排序", "优先级", "分析", "口径", "汇报", "报告", "建议", "执行",
                      "输出", "早晚报", "日报", "推送", "挑出", "选人", "怎么写", "怎么说")

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}")
_OPENID_RE = re.compile(r"\bou_[0-9a-f]{16,}\b")
_PHONE_RE = re.compile(r"(?<!\d)(?:\+?\d[\d\s-]{7,}\d)(?!\d)")
_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_DOMAIN_RE = re.compile(r"\b(?:[a-z0-9-]+\.)+(?:com|cn|io|net|org|co|biz|info|br|de|uk|jp|in|vn|id|mx|za|ae|sa|pl|tr|eg|ru)\b", re.IGNORECASE)
_LONGID_RE = re.compile(r"\b\d{9,}\b")


def mask_pii(text: str) -> str:
    """所有类别统一脱敏：邮箱 / open_id / 电话 / URL / 域名 / 长数字 ID。"""
    s = str(text or "")
    s = _EMAIL_RE.sub("<email>", s)
    s = _OPENID_RE.sub("<open_id>", s)
    s = _URL_RE.sub("<url>", s)
    s = _PHONE_RE.sub("<phone>", s)
    s = _DOMAIN_RE.sub("<domain>", s)
    s = _LONGID_RE.sub("<id>", s)
    return s


def _has_any(text: str, hints) -> bool:
    t = (text or "").lower()
    return any(h.lower() in t for h in hints)


def classify_agent(entry: dict) -> tuple[str, str]:
    failed = str(entry.get("what_failed") or "")
    worked = str(entry.get("what_worked") or "")
    nextt = str(entry.get("next_time") or "")
    tags = " ".join(entry.get("tags") or []) if isinstance(entry.get("tags"), list) else str(entry.get("tags") or "")
    if failed.strip() and _has_any(failed, BUG_HINTS):
        return "bug", "agent 层 what_failed 含缺陷特征"
    if _has_any(worked + " " + nextt + " " + tags, SKILL_HINTS):
        return "skill_improvement", "agent 层含可复用流程/规则特征（what_worked/next_time/tags）"
    return "ignore", "agent 层仅信息性，无缺陷也无可复用规则"


def classify_business(entry: dict) -> tuple[str, str]:
    t = str(entry.get("type") or "")
    blob = f"{entry.get('what') or ''} {entry.get('how') or ''}"
    # 语义优先级：先判「Agent 如何表达/分析/排序/执行」→ skill_improvement（不是领域知识）
    if _has_any(blob, AGENT_METHOD_HINTS):
        return "skill_improvement", "Agent 如何表达/分析/排序/执行 → Skill/规则/playbook"
    if _has_any(blob, TENANT_HINTS):
        return "tenant_only", f"业务层含租户专属选择（{t or 'memory'}：目标市场/产品/排除/偏好）"
    if _has_any(blob, INDUSTRY_HINTS):
        return "industry_knowledge", "行业/市场/产品/认证/渠道/买家行为领域知识"
    return "tenant_only", f"业务层未识别为领域知识，默认留租户层（{t or 'memory'}）"


def _tenant_summary(entry: dict) -> str:
    """tenant_only 的脱敏摘要：不含租户专属细节。"""
    t = str(entry.get("type") or "memory")
    return f"租户专属（{t}）：细节已脱敏，仅本地分身可见"


def _iter_agent(workspace: Path, since: str = "") -> list[dict]:
    d = workspace / "memory" / "reflections"
    out = []
    if not d.exists():
        return out
    for p in sorted(d.glob("*.jsonl")):
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if since and str(e.get("created_at") or "")[:10] < since:
                continue
            e["_source_ref"] = f"agent:{p.name}#{i}"
            out.append(e)
    return out


def _iter_business(workspace: Path, since: str = "") -> list[dict]:
    p = workspace / "memory" / "projects" / "dealclaw" / "reflections.jsonl"
    out = []
    if not p.exists():
        return out
    for line_no, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if since and str(e.get("ts") or "")[:10] < since:
            continue
        e["_source_ref"] = f"business:reflections.jsonl#{line_no}"
        out.append(e)
    return out


def _confidence(cls: str) -> str:
    return {"bug": "high", "skill_improvement": "medium", "industry_knowledge": "medium"}.get(cls, "low")


def _review_item(*, cls: str, reason: str, summary: str, change: str, ref: str) -> dict:
    """统一输出（需求 4）：summary / agent_judgment / suggested_destination / suggested_change /\n    evidence_refs / confidence。classification 仅作**建议**，Agent 可重分类或拆分。"""
    return {
        "summary": summary,
        "agent_judgment": f"建议 {cls}（{reason}）；可结合上下文重分类或拆分",
        "classification": cls,  # 仅建议，不强制
        "suggested_destination": TARGETS[cls],
        "suggested_change": change,
        "evidence_refs": [ref] if ref else [],
        "confidence": _confidence(cls),
    }


def build_candidates(workspace: Path, since: str = "") -> list[dict]:
    cands: list[dict] = []
    for e in _iter_agent(workspace, since):
        cls, reason = classify_agent(e)
        cands.append(_review_item(
            cls=cls, reason=reason, summary=mask_pii(e.get("context") or ""),
            change=mask_pii(str(e.get("next_time") or e.get("what_failed") or "")),
            ref=e.get("_source_ref", "")))
    for e in _iter_business(workspace, since):
        cls, reason = classify_business(e)
        if cls == "tenant_only":
            summary, change = _tenant_summary(e), ""
        else:
            summary, change = mask_pii(e.get("what") or ""), mask_pii(str(e.get("how") or ""))
        cands.append(_review_item(cls=cls, reason=reason, summary=summary, change=change,
                                  ref=e.get("_source_ref", "")))
    return cands


def render_md(cands: list[dict], generated_at: str) -> str:
    lines = ["# Reflection 审核候选（分发前测试母体）", "",
             f"> 生成：{generated_at} · 共 {len(cands)} 条 · **只读候选，本文件不自动改系统**",
             "> 安全：所有类别已脱敏（邮箱/open_id/电话/URL/域名/长ID）；tenant_only 只给脱敏摘要。", "",
             "> 分类：bug → 代码+回归测试；skill_improvement → Skill/规则；",
             "> industry_knowledge → 脱敏后落通用知识；tenant_only → 不进 payload；ignore → 忽略。", ""]
    for cls in CLASSES:
        group = [c for c in cands if c["classification"] == cls]
        lines.append(f"## {cls}（{len(group)}）→ {TARGETS[cls]}")
        if not group:
            lines.append("- （无）")
        for c in group:
            line = f"- [{c['source']}] {c['summary']}"
            if c["detail"]:
                line += f"｜{c['detail']}"
            lines.append(line)
            lines.append(f"  - 理由：{c['reason']}")
            if c["proposed_payload"]:
                lines.append(f"  - 脱敏后拟落通用知识：{c['proposed_payload']}")
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 reflection 审核候选（不改系统）")
    ap.add_argument("--workspace", default="", help="workspace 根（含 memory/；默认脚本上两级）")
    ap.add_argument("--out", default="", help="候选输出目录（默认 {workspace}/data/reflection-review/candidates）")
    ap.add_argument("--since", default="", help="只看该日期(YYYY-MM-DD)之后的 reflection")
    ap.add_argument("--json", action="store_true", help="额外打印 JSON 摘要")
    args = ap.parse_args()

    ws = Path(args.workspace).expanduser() if args.workspace else Path(__file__).resolve().parents[2]
    out_dir = (Path(args.out).expanduser() if args.out
               else ws / "data" / "reflection-review" / "candidates")
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
    print(f"[review-reflections] 分类统计：{counts}（只生成候选，不改系统；默认不进 Git）")
    if args.json:
        print(json.dumps({"counts": counts, "md": str(md_path), "json": str(json_path)},
                         ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
