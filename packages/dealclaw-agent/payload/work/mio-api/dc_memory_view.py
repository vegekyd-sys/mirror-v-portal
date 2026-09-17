#!/usr/bin/env python3
"""dc_memory_view.py — 记忆的「显化层」读取器（只读，绝不回写）

背景（2026-09-17 田耕郡）：
「我需要你让用户感受到反思和更懂，这部分需要显化出来。日常任务大家能感受到你越来越好，
 但是给用户使用，还是要积极地不断汇报的。」

所以本模块只做一件事：**把记忆读出来，变成人看得见的东西**。
- 给文档看的：facts / rules / reflections → markdown 段落（`dc_kb_publish` 调）
- 给用户看的：`learning_digest()` → 一条「我更懂你了」汇报（`dc_learning_digest` 推）

铁律：
1. **只读**——展示层不得回写 canonical（单一事实源、单向）。
2. **缺失留空、不编**——读不到就返回空，不造内容。
3. **可审计**——每条都带来源与时间。

用法::

    python3 dc_memory_view.py facts --company-id 100000834234
    python3 dc_memory_view.py digest --company-id 100000834234 --open-id ou_xxx
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

IST = timezone(timedelta(hours=8))  # 展示用北京时间

REFLECTION_LABEL = {
    "fact": "记住了一件事",
    "pattern": "总结出一条规律",
    "preference": "记下了你的偏好",
    "rule": "立了一条长期规则",
    "lesson": "踩坑教训",
}


def workspace_root() -> Path:
    env = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    return Path(env) if env else BASE.parents[1]


def facts_path(company_id: str) -> Path:
    return workspace_root() / "memory" / "company" / str(company_id) / "facts.md"


def rules_path(company_id: str) -> Path:
    return workspace_root() / "memory" / "company" / str(company_id) / "rules.md"


def reflections_path() -> Path:
    return workspace_root() / "memory" / "projects" / "dealclaw" / "reflections.jsonl"


def resolve_company_id(*candidates: str) -> str:
    """挑一个真的有记忆的 id。

    文档层的 `enterprise` key 与记忆层的 supplier_id 可能不同名，所以按候选顺序试，
    真的存在 facts.md / rules.md 的那个先用；都不存在则退第一个候选（缺失留空、不编）。
    """
    ids = [str(c).strip() for c in candidates if str(c or "").strip()]
    env = os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()
    if env and env not in ids:
        ids.append(env)
    for cid in ids:
        if facts_path(cid).exists() or rules_path(cid).exists():
            return cid
    return ids[0] if ids else ""


def _parse_ts(raw: str) -> datetime | None:
    text = str(raw or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    for cut in (text, text[:19]):
        try:
            dt = datetime.fromisoformat(cut)
            return dt if dt.tzinfo else dt.replace(tzinfo=IST)
        except ValueError:
            continue
    return None


def _fmt_day(raw: str) -> str:
    dt = _parse_ts(raw)
    return dt.astimezone(IST).strftime("%m-%d") if dt else str(raw or "").strip()


# ── 读取：企业事实（canonical facts.md）─────────────────────────
def read_facts(company_id: str, limit: int = 0) -> list[dict]:
    """读 memory/company/<id>/facts.md 的事实行。表头固定：字段|值|来源|时间。"""
    path = facts_path(company_id)
    if not path.exists():
        return []
    rows: list[dict] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line.startswith("|") or line.startswith("|---") or "字段 | 值" in line:
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) < 2 or not cells[0] or not cells[1]:
                continue
            rows.append({
                "field": cells[0],
                "value": cells[1],
                "source": cells[2] if len(cells) > 2 else "",
                "date": cells[3] if len(cells) > 3 else "",
            })
    except OSError:
        return []
    return rows[-limit:] if limit and limit > 0 else rows


# ── 读取：长期规则（rules.md）────────────────────────────────
def read_rules(company_id: str) -> list[dict]:
    """读 rules.md。行格式：`- [state | 日期 | 来源] 规则正文`。"""
    path = rules_path(company_id)
    if not path.exists():
        return []
    out: list[dict] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line.startswith("-"):
                continue
            body = line.lstrip("-").strip()
            state, date, source, text = "active", "", "", body
            if body.startswith("[") and "]" in body:
                meta, text = body[1:].split("]", 1)
                parts = [p.strip() for p in meta.split("|")]
                state = parts[0] if parts else "active"
                date = parts[1] if len(parts) > 1 else ""
                source = parts[2] if len(parts) > 2 else ""
                text = text.strip()
            if not text:
                continue
            out.append({"state": state, "date": date, "source": source, "text": text})
    except OSError:
        return []
    return out


# ── 读取：业务反思（reflections.jsonl）───────────────────────
def read_reflections(limit: int = 5, *, user: str = "", since: datetime | None = None) -> list[dict]:
    """读业务反思（倒序取最近 limit 条）。user 非空时只取该用户的（无 user 字段的通用条目也保留）。"""
    path = reflections_path()
    if not path.exists():
        return []
    items: list[dict] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(rec, dict) or not str(rec.get("what") or "").strip():
                continue
            rec_user = str(rec.get("user") or "").strip()
            if user and rec_user and rec_user != user:
                continue
            ts = _parse_ts(rec.get("ts"))
            if since and ts and ts < since:
                continue
            items.append({
                "ts": str(rec.get("ts") or ""),
                "type": str(rec.get("type") or "pattern"),
                "what": str(rec.get("what") or "").strip(),
                "how": str(rec.get("how") or "").strip(),
            })
    except OSError:
        return []
    items.sort(key=lambda r: r["ts"])
    return items[-limit:] if limit and limit > 0 else items


# ── 渲染：文档段落 ──────────────────────────────────────────
def render_facts_block(company_id: str, limit: int = 30) -> list[str]:
    """主题页「📌 企业事实」段落（固定表头，缺失留空不编）。"""
    rows = read_facts(resolve_company_id(company_id), limit=limit)
    if not rows:
        return []
    lines = ["---", "", "## 📌 企业事实（我记住的）", "",
             "> 由 V 自动沉淀，格式固定：`字段 | 值 | 来源 | 时间`。修正会新增「更正」行，不改旧行。", "",
             "| 字段 | 值 | 来源 | 时间 |", "|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['field']} | {r['value']} | {r['source']} | {r['date']} |")
    lines.append("")
    return lines


def render_rules_block(company_id: str, limit: int = 20) -> list[str]:
    """主题页「📐 长期规则」段落（我们的约定，任务上下文按它执行）。"""
    rules = [r for r in read_rules(resolve_company_id(company_id)) if r["state"] == "active"][-limit:]
    if not rules:
        return []
    lines = ["---", "", "## 📐 长期规则（我们的约定）", "",
             "> 你说过的长期口径，我会一直照着做，不再反复问。", ""]
    for r in rules:
        stamp = _fmt_day(r["date"]) if r["date"] else ""
        lines.append(f"- {r['text']}" + (f"　_({stamp})_" if stamp else ""))
    lines.append("")
    return lines


def render_learning_block(company_id: str, limit: int = 5) -> list[str]:
    """首页「🧠 最近学到的新知识」——真读反思 + 事实增量（不再是空转占位）。"""
    lines: list[str] = []
    for rec in read_reflections(limit=limit, user="")[::-1]:
        label = REFLECTION_LABEL.get(rec["type"], "学会了")
        lines.append(f"- 💡 **{label}**：{rec['what']}")
    facts = read_facts(resolve_company_id(company_id))
    for r in facts[-3:][::-1]:
        lines.append(f"- 🗂️ 记住：{r['field']} = {r['value']}")
    return lines


# ── 渲染：给用户看的「我更懂你了」汇报 ──────────────────────
def learning_digest(company_id: str, *, open_id: str = "", since: datetime | None = None,
                    max_items: int = 5) -> dict:
    """把「新学到的」汇成一条可发给用户的汇报（显化用）。

    返回 ``{"count": n, "text": "...", "items": [...]}``；无新增时 ``count=0`` 且 ``text=""``。
    """
    since = since or datetime.now(timezone.utc) - timedelta(days=7)
    items: list[str] = []

    for rec in read_reflections(limit=50, user=open_id):
        ts = _parse_ts(rec["ts"])
        if ts and ts >= since:
            label = REFLECTION_LABEL.get(rec["type"], "学会了")
            items.append((rec["ts"], f"**{label}**：{rec['what']}"))

    for r in read_rules(resolve_company_id(company_id)):
        ts = _parse_ts(r["date"])
        if r["state"] == "active" and ts and ts >= since:
            items.append((r["date"], f"**记住了你的规矩**：{r['text']}"))

    for r in read_facts(resolve_company_id(company_id)):
        ts = _parse_ts(r["date"])
        if ts and ts >= since:
            items.append((r["date"], f"**记住**：{r['field']} = {r['value']}"))

    items.sort(key=lambda x: x[0])
    picked = items[-max_items:]
    if not picked:
        return {"count": 0, "text": "", "items": []}

    head = f"📌 我又更懂你了（{len(items)} 件新事）"
    body = [f"• {text}" for _, text in picked]
    tail = "接下来我会照这些筛线索、写邮件、报价，你不用再重复告诉我。"
    text = "\n".join([head, ""] + body + ["", tail])
    return {"count": len(items), "text": text, "items": [t for _, t in picked]}


# ── CLI ────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description="记忆显化层（只读）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("facts", help="打印企业事实")
    p1.add_argument("--company-id", required=True)
    p1.add_argument("--limit", type=int, default=0)

    p2 = sub.add_parser("rules", help="打印长期规则")
    p2.add_argument("--company-id", required=True)

    p3 = sub.add_parser("reflections", help="打印业务反思")
    p3.add_argument("--limit", type=int, default=5)
    p3.add_argument("--open-id", default="")

    p4 = sub.add_parser("digest", help="生成「我更懂你了」汇报")
    p4.add_argument("--company-id", required=True)
    p4.add_argument("--open-id", default="")
    p4.add_argument("--days", type=int, default=7)

    args = ap.parse_args()
    if args.cmd == "facts":
        print(json.dumps(read_facts(args.company_id, limit=args.limit), ensure_ascii=False, indent=2))
    elif args.cmd == "rules":
        print(json.dumps(read_rules(args.company_id), ensure_ascii=False, indent=2))
    elif args.cmd == "reflections":
        print(json.dumps(read_reflections(args.limit, user=args.open_id), ensure_ascii=False, indent=2))
    elif args.cmd == "digest":
        since = datetime.now(timezone.utc) - timedelta(days=args.days)
        print(json.dumps(learning_digest(args.company_id, open_id=args.open_id, since=since),
                         ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
