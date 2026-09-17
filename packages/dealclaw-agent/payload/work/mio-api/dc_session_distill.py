#!/usr/bin/env python3
"""dc_session_distill.py — 统一会话沉淀器（路由器，不是新的记忆系统）

背景（2026-09-17 田耕郡）："用户和你说的信息总忘记"、"聊了很多天 kb.json 还是空的"。

排查结论：反思/记忆**四套存储都存在**，但**没有任何一条会话→存储的自动通道**，
每个写入器都要求 agent"记得在任务结束时主动调"——实际就是不写。
（实测：memory/reflections/ 只有 9-10、9-11 两天有文件；people/ 0 个文件；
 reflections.jsonl 5 条；feedback.jsonl 5 条；kb.json profile 空。）

本模块不新建存储，只做**分流**：把一批事实按类型写进已有归口。

| 事实类型 | 归口 | 谁读它 |
|---|---|---|
| `company_fact` | `kb.json profile`（dc_profile_learn，非破坏合并） | 搜索 / 邮件 / 画像 / 展中匹配 |
| `long_term_rule` | `rules.md`（dc_rules.append_rule） | dc_daily_cycle 长期规则 → 任务上下文 |
| `business_reflection` | `reflections.jsonl`（scripts/write-business-reflection.py） | 日报「最近更懂你了」 |
| `user_profile` | `memory/people/<open_id>.md`（dc_distill 同格式） | 人员卡（称呼/偏好/边界） |

铁律：幂等（同一条事实重复沉淀不重复写）、可审计、不覆盖已有内容。

用法::

    # 会话结束时把事实送进来（模型抽取，最准）
    python3 dc_session_distill.py route --company-id 100000834234 --open-id ou_xxx \
        --facts-json '[{"kind":"company_fact","data":{"products":["stand up pouch"]}},
                       {"kind":"long_term_rule","text":"东南亚只做印尼越南"},
                       {"kind":"user_profile","text":"习惯早上看日报"}]' --apply

    # 无模型兜底：从已有素材自动抽（幂等）
    python3 dc_session_distill.py sweep --company-id 100000834234 --apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from dc_profile_learn import learn as learn_profile, harvest  # noqa: E402

KINDS = ("company_fact", "long_term_rule", "business_reflection", "user_profile")


def workspace_root() -> Path:
    env = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    return Path(env) if env else BASE.parents[1]


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ── 归口 1：长期规则 → rules.md（复用 dc_rules）──────────────────
def _rule_path(enterprise: str) -> Path:
    try:
        from dc_rules import _rules_path  # noqa: PLC0415
        return Path(_rules_path(enterprise))
    except Exception:  # noqa: BLE001
        return workspace_root() / "data" / "memory" / str(enterprise) / "rules.md"


def add_rule_if_new(enterprise: str, text: str, *, source: str = "session") -> dict:
    text = (text or "").strip()
    if not text:
        return {"status": "skipped", "reason": "空规则"}
    path = _rule_path(enterprise)
    if path.exists():
        try:
            if text in path.read_text(encoding="utf-8"):
                return {"status": "duplicate", "path": str(path)}
        except Exception:  # noqa: BLE001
            pass
    try:
        from dc_rules import append_rule  # noqa: PLC0415
        return append_rule(enterprise, text, source=source, state="active")
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "error": str(exc)[:200]}


# ── 归口 2：业务反思 → reflections.jsonl（复用 scripts/write-business-reflection.py）──
def _reflections_path() -> Path:
    return workspace_root() / "memory" / "projects" / "dealclaw" / "reflections.jsonl"


def add_reflection_if_new(what: str, how: str = "", *, rtype: str = "pattern",
                          user: str = "", source: str = "session") -> dict:
    what = (what or "").strip()
    if not what:
        return {"status": "skipped", "reason": "空反思"}
    path = _reflections_path()
    if path.exists():
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                if str(rec.get("what") or "").strip() == what:
                    return {"status": "duplicate", "path": str(path)}
        except Exception:  # noqa: BLE001
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {"what": what, "how": (how or "").strip(), "type": rtype,
           "user": user or "", "ts": _now(), "source": source}
    with open(path, "a", encoding="utf-8") as f:  # 追加，天然保序
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return {"status": "ok", "path": str(path)}


# ── 归口 3：用户个人卡 → memory/people/<open_id>.md ──────────────
def add_user_note_if_new(open_id: str, text: str, *, tag: str = "事实") -> dict:
    open_id = (open_id or "").strip()
    text = (text or "").strip()
    if not open_id or not text:
        return {"status": "skipped", "reason": "缺 open_id 或内容"}
    path = workspace_root() / "memory" / "people" / f"{open_id}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            if text in path.read_text(encoding="utf-8"):
                return {"status": "duplicate", "path": str(path)}
        except Exception:  # noqa: BLE001
            pass
    line = f"- [{tag} | {_now()[:10]} | 会话沉淀] {text}\n"
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)
    return {"status": "ok", "path": str(path)}



# ── 归口 0（canonical）：企业事实 → memory/company/<id>/facts.md ──
# 2026-09-17 田耕郡定调：**记录落到 memory（agent 能读能调）**，给人看的限定好格式，
# 需要时再查。kb.json profile 降级为「机器投影」（搜索/邮件用），不再是事实的唯一去处。
FACTS_HEADER = """# {name} · 企业事实

> 由 V 自动沉淀（dc_session_distill）。**格式固定，勿改列**；新事实追加行，修正请新增「更正」行而不是改旧行。
> 机器投影：`kb.json profile`（搜索/邮件/展中匹配读它）。**本文件是事实原始记录，检索以本文件为准。**

| 字段 | 值 | 来源 | 时间 |
|---|---|---|---|
"""
FACT_FIELD_LABELS = {
    "products": "产品线", "target_markets": "目标市场", "certifications": "认证",
    "usp": "核心优势", "company_type": "公司类型", "business_model": "商业模式",
    "scale": "规模", "founded": "成立年份", "website": "官网", "industry": "行业",
    "positioning": "定位", "customization": "定制能力", "name": "公司名",
    "name_en": "英文名", "categories": "采购类目", "tags": "标签",
    "tagKeywords": "标签词", "main_products": "主营产品", "advantages": "优势",
}


def facts_path(company_id: str) -> Path:
    return workspace_root() / "memory" / "company" / str(company_id) / "facts.md"


def _existing_rows(path: Path) -> set:
    """已存在的 (字段, 值) 组合，用于幂等去重。"""
    rows = set()
    if not path.exists():
        return rows
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.startswith("|") or line.startswith("|---") or "字段 | 值" in line:
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) >= 2 and cells[0] and cells[1]:
                rows.add((cells[0], cells[1]))
    except OSError:
        pass
    return rows


def add_facts_to_memory(company_id: str, facts: dict, *, source: str = "session") -> dict:
    """把企业事实写进 memory/company/<id>/facts.md（固定表格格式，幂等）。"""
    if not facts:
        return {"status": "skipped", "reason": "空事实"}
    path = facts_path(company_id)
    existing = _existing_rows(path)
    today = _now()[:10]
    new_lines: list = []

    for field, value in sorted(facts.items()):
        label = FACT_FIELD_LABELS.get(field, field)
        vals = value if isinstance(value, list) else [value]
        for v in vals:
            text = str(v).strip()
            if not text or (label, text) in existing:
                continue
            existing.add((label, text))
            new_lines.append(f"| {label} | {text} | {source} | {today} |")

    if not new_lines:
        return {"status": "duplicate", "path": str(path)}

    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(FACTS_HEADER.format(name=company_id), encoding="utf-8")
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(new_lines) + "\n")
    return {"status": "ok", "path": str(path), "added": len(new_lines)}


# ── 路由器 ────────────────────────────────────────────────────
def route(facts: list, *, company_id: str, open_id: str = "",
          dry_run: bool = True, source: str = "session") -> dict:
    """按 kind 分流到已有归口。返回每个归口的处理结果。"""
    out = {"company_fact": [], "long_term_rule": [], "business_reflection": [], "user_profile": []}
    company_facts: dict = {}

    for item in facts or []:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip()
        if kind not in KINDS:
            out.setdefault("unknown", []).append({"item": item, "reason": "未知 kind"})
            continue
        if kind == "company_fact":
            data = item.get("data") if isinstance(item.get("data"), dict) else {}
            for k, v in data.items():
                if k in company_facts and isinstance(company_facts[k], list) and isinstance(v, list):
                    company_facts[k] = company_facts[k] + [x for x in v if x not in company_facts[k]]
                else:
                    company_facts[k] = v
        elif kind == "long_term_rule":
            if dry_run:
                out[kind].append({"status": "dry_run", "text": item.get("text")})
            else:
                out[kind].append(add_rule_if_new(company_id, item.get("text", ""), source=source))
        elif kind == "business_reflection":
            if dry_run:
                out[kind].append({"status": "dry_run", "what": item.get("what")})
            else:
                out[kind].append(add_reflection_if_new(
                    item.get("what", ""), item.get("how", ""),
                    rtype=str(item.get("type") or "pattern"),
                    user=open_id, source=source))
        elif kind == "user_profile":
            if dry_run:
                out[kind].append({"status": "dry_run", "text": item.get("text")})
            else:
                out[kind].append(add_user_note_if_new(
                    open_id, item.get("text", ""), tag=str(item.get("tag") or "事实")))

    if company_facts:
        # canonical：先落 memory（人可读、agent 可查）
        if dry_run:
            out["company_fact"].append({"status": "dry_run", "facts": company_facts})
        else:
            out["company_fact"].append(add_facts_to_memory(company_id, company_facts, source=source))
        # 机器投影：kb.json profile（搜索/邮件读它）
        out["company_fact"].append(learn_profile(
            company_id, company_facts, source=source, dry_run=dry_run))

    written = sum(1 for k in KINDS for r in out[k]
                  if isinstance(r, dict) and r.get("status") in ("ok", "written")
                  or isinstance(r, dict) and r.get("wrote"))
    unknown = out.get("unknown", [])
    if unknown:
        # 未知 kind 必须显式暴露（顶层 + by_kind），不允许静默丢弃
        out["unknown"] = unknown
    return {"ok": True, "dry_run": dry_run, "written": written, "by_kind": out,
            "unknown": unknown,
            "counts": {k: len(v) for k, v in out.items()}}


def sweep(company_id: str, *, open_id: str = "", dry_run: bool = True) -> dict:
    """无模型兜底：把已有素材里能抽的事实沉淀进 profile。"""
    res = harvest(company_id, source="sweep", dry_run=dry_run)
    return {"ok": True, "profile": res}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="统一会话沉淀器（分流到既有记忆归口）")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("route", help="把事实按 kind 分流沉淀")
    r.add_argument("--company-id", required=True)
    r.add_argument("--open-id", default="")
    r.add_argument("--facts-json", default="[]")
    r.add_argument("--facts-file", default="")
    r.add_argument("--source", default="session")
    r.add_argument("--apply", action="store_true")

    s = sub.add_parser("sweep", help="从已有素材自动抽并沉淀（无模型兜底）")
    s.add_argument("--company-id", required=True)
    s.add_argument("--open-id", default="")
    s.add_argument("--apply", action="store_true")

    a = p.parse_args(argv)
    if a.cmd == "route":
        raw = Path(a.facts_file).read_text(encoding="utf-8") if a.facts_file else a.facts_json
        facts = json.loads(raw or "[]")
        res = route(facts, company_id=a.company_id, open_id=a.open_id,
                    dry_run=not a.apply, source=a.source)
    else:
        res = sweep(a.company_id, open_id=a.open_id, dry_run=not a.apply)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
