#!/usr/bin/env python3
"""dc_profile_learn.py — 企业画像自动沉淀（非破坏性合并）

背景（2026-09-17 田耕郡指出）：用户聊了很多天、跑了很多任务，`kb.json` 的
`profile` 依然是空的——"完全没有体现自进化、有记忆的能力"。

根因不是"没人写"，而是**没有一条日常路径会写**：
  · `seed_profile` 只在 `dealclaw-analyze-company`（显式要求分析企业）时被调用；
  · `dc_iq_engine` 的播种发生在 `missing_profile` 断点**之后**，画像越缺越走不到（死锁）；
  · `dc_profile_fill` 只回写平台 `company info`，默认只读、需 `--apply`、手工触发。
结果：画像只有"某次显式分析"才会有，日常对话/任务里的事实全部流失。

本模块提供**统一的日常写入通道**：把任意来源的事实（对话、任务产物、资料、回信）
非破坏性地合并进 `data/memory/<企业>/kb.json` 的 `profile`。

铁律：
  · 只填空、只追加，**永不覆盖已有非空值**（除非 `--replace-fields` 显式点名）
  · 幂等：同样输入重复跑，结果不变
  · 每次写入留 provenance（`_learned`：来源/时间/新增字段），可审计、可回溯
  · 空值不写（绝不把 profile 写成空壳）

用法::

    # 从结构化事实合并（推荐：模型抽取后给 JSON）
    python3 dc_profile_learn.py merge --company-id 100000834234 \
        --facts-json '{"products":["packaging bag"],"target_markets":["BR"]}' --source chat

    # 从自由文本抽（规则抽取，弱一些，但能兜底）
    python3 dc_profile_learn.py extract --company-id 100000834234 --text-file note.txt

    # 只看会改什么（默认就是 dry-run；--apply 才写）
    python3 dc_profile_learn.py merge --facts-json '...' --apply
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent

# ── profile 字段语义 ────────────────────────────────────────────
SCALAR_FIELDS = (
    "name", "name_en", "product", "usp", "company_type", "business_model",
    "customization", "scale", "founded", "website", "industry", "positioning",
)
LIST_FIELDS = (
    "products", "target_markets", "certifications", "categories",
    "tagKeywords", "tags", "advantages", "main_products",
)
# 别名 → canonical（模型/上游字段名不统一是常态）
ALIASES = {
    "company_name": "name", "enterprise_name": "name", "公司名": "name",
    "company_name_en": "name_en", "enterprise_external": "name_en",
    "产品": "products", "主营产品": "products", "main_products": "products",
    "优势": "usp", "advantage": "usp", "advantages": "advantages",
    "证书": "certifications", "certificate": "certifications",
    "目标市场": "target_markets", "markets": "target_markets", "countries": "target_markets",
    "标签": "tags", "tag_keywords": "tagKeywords", "keywords": "tagKeywords",
    "类目": "categories", "supplierCategories": "categories",
    "成立年份": "founded", "year_founded": "founded",
    "公司类型": "company_type", "enterprise_type": "company_type",
    "规模": "scale", "employees": "scale",
    "官网": "website", "网址": "website", "url": "website",
}
# 注意：usp / positioning / business_model 等是**标量**字段，首次写入即锁定。
# 早期版本误把 usp 归到列表字段，会把互相矛盾的值一路追加进去（2026-09-17 自检发现）。
LIST_ALIASES: dict = {}


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def workspace_root() -> Path:
    env = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    return Path(env) if env else BASE.parents[1]


def kb_path(company_id: str) -> Path:
    return workspace_root() / "data" / "memory" / str(company_id) / "kb.json"


def load_kb(company_id: str) -> dict:
    p = kb_path(company_id)
    if not p.exists():
        return {}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def save_kb(company_id: str, kb: dict) -> Path:
    p = kb_path(company_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(kb, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)  # 原子落盘，避免半截文件
    return p


def _as_list(value) -> list:
    """把任意形态收敛成字符串列表（去空、去重、保序）。"""
    if value is None or value == "":
        return []
    if isinstance(value, dict):
        for k in ("name", "value", "label", "text"):
            if value.get(k):
                return _as_list(value.get(k))
        return []
    if isinstance(value, (list, tuple, set)):
        out = []
        for x in value:
            for t in _as_list(x):
                if t not in out:
                    out.append(t)
        return out
    parts = re.split(r"[,，;；/、|]+", str(value))
    out = []
    for p in parts:
        t = p.strip()
        if t and t not in out:
            out.append(t)
    return out


def canonicalize(facts: dict) -> dict:
    """字段名归一（别名 → canonical），并把值收敛成 profile 形态。"""
    out: dict = {}
    for raw_key, value in (facts or {}).items():
        key = ALIASES.get(raw_key, raw_key)
        if key in LIST_FIELDS or raw_key in LIST_ALIASES:
            vals = _as_list(value)
            if vals:
                out.setdefault(key, [])
                for v in vals:
                    if v not in out[key]:
                        out[key].append(v)
        elif key in SCALAR_FIELDS:
            text = ("" if value is None else str(value)).strip()
            if text:
                out[key] = text
        # 其他未知字段：保留为标量（不丢信息），但仍遵守"不覆盖非空"
        else:
            text = ("" if value is None else str(value)).strip()
            if text:
                out[key] = text
    return out


def merge_profile(current: dict, facts: dict) -> tuple[dict, dict, dict]:
    """非破坏性合并：只填空 / 只追加。返回 (merged, changed, skipped)。"""
    merged = dict(current or {})
    changed: dict = {}
    skipped: dict = {}
    for key, value in canonicalize(facts).items():
        if isinstance(value, list):
            old = merged.get(key)
            old_list = old if isinstance(old, list) else (_as_list(old) if old else [])
            added = [v for v in value if v not in old_list]
            if added:
                merged[key] = old_list + added
                changed[key] = added
        else:
            if not str(merged.get(key) or "").strip():
                merged[key] = value
                changed[key] = value
            elif str(merged.get(key) or "").strip() != str(value).strip():
                # 只有**值不同**才算被拒更新；同值重复进来是幂等，不该留冲突痕迹
                skipped[key] = value
    if skipped:
        merged["_skipped_updates"] = {**merged.get("_skipped_updates", {}), **skipped}
    return merged, changed, skipped


def learn(
    company_id: str,
    facts: dict,
    *,
    source: str = "",
    replace_fields: list | None = None,
    dry_run: bool = True,
) -> dict:
    """把 facts 合并进企业 profile；默认 dry-run。

    `replace_fields`：显式点名的字段允许覆盖（默认谁都不许）。
    """
    facts = canonicalize(facts)
    if not facts:
        return {"ok": False, "error": "没有可写入的事实（空输入不写）", "changed": {}}

    kb = load_kb(company_id)
    current = kb.get("profile", {}) if isinstance(kb.get("profile"), dict) else {}
    merged, changed, skipped = merge_profile(current, facts)

    forced: dict = {}
    for field in (replace_fields or []):
        if field in facts:
            merged[field] = facts[field]
            forced[field] = facts[field]
            changed[field] = facts[field]

    if not changed and not skipped:
        return {"ok": True, "changed": {}, "wrote": False,
                "reason": "全部字段已有非空值，按铁律不覆盖", "profile_keys": sorted(merged.keys())}

    if dry_run:
        return {"ok": True, "changed": changed, "skipped": skipped, "wrote": False,
                "dry_run": True, "profile_keys": sorted(merged.keys())}

    only_skipped = not changed
    learned = kb.get("_learned") if isinstance(kb.get("_learned"), dict) else {}
    history = learned.get("history") if isinstance(learned.get("history"), list) else []
    history.append({
        "at": _now(), "source": source or "unspecified",
        "changed": sorted(changed.keys()), "forced": sorted(forced.keys()),
    })
    merged["updated"] = _now()
    if not merged.get("source"):
        merged["source"] = source or ""
    kb["profile"] = merged
    kb["_learned"] = {"last_at": _now(), "last_source": source or "unspecified",
                      "history": history[-50:]}  # 只留最近 50 条，防止无限膨胀
    path = save_kb(company_id, kb)
    return {"ok": True, "changed": changed, "skipped": skipped, "wrote": True,
            "reason": "仅记录被拒更新，画像内容未变" if only_skipped else "已合并",
            "path": str(path), "profile_keys": sorted(merged.keys())}


# ── 自由文本抽取（规则兜底；模型抽取优先）──────────────────────
COUNTRY_HINTS = {
    "brazil": "BR", "brasil": "BR", "mexico": "MX", "méxico": "MX", "india": "IN",
    "indonesia": "ID", "vietnam": "VN", "germany": "DE", "usa": "US", "u.s.": "US",
    "united states": "US", "japan": "JP", "russia": "RU", "poland": "PL",
    "turkey": "TR", "dubai": "AE", "saudi": "SA", "south africa": "ZA",
}


def extract_facts(text: str) -> dict:
    """从自由文本抽企业事实（保守：只在有明确信号时才产出）。"""
    facts: dict = {}
    t = text or ""
    low = t.lower()

    # 国家（英文名 → ISO2）
    markets = []
    for word, iso in COUNTRY_HINTS.items():
        if re.search(rf"\b{re.escape(word)}\b", low):
            if iso not in markets:
                markets.append(iso)
    if markets:
        facts["target_markets"] = markets

    # 认证（常见外贸认证）
    certs = []
    for c in ("CE", "RoHS", "ISO9001", "ISO 9001", "FDA", "REACH", "FSC", "BSCI", "SGS"):
        if re.search(rf"\b{re.escape(c)}\b", t, re.I):
            certs.append(c.replace("ISO 9001", "ISO9001"))
    if certs:
        facts["certifications"] = sorted(set(certs))

    # 成立年份
    m = re.search(r"(成立|founded|since)[^\d]{0,8}(19\d{2}|20\d{2})", t, re.I)
    if m:
        facts["founded"] = m.group(2)

    # 官网
    m = re.search(r"https?://([\w.-]+\.[a-z]{2,})", t, re.I)
    if m:
        facts["website"] = m.group(1)

    # 产品词（"主营/产品/we produce/our products" 后面跟的短语）
    m = re.search(r"(?:主营|产品线|主要产品|our products?|we (?:produce|manufacture))\s*[:：]?\s*([^\n。;；]{2,80})", t, re.I)
    if m:
        facts["products"] = _as_list(m.group(1))
    return facts


def _harvest_texts(company_id: str, limit_chars: int = 20000) -> list[tuple[str, str]]:
    """收集该企业已存在、可用来抽取画像的文本（不联网、不额外消耗）。"""
    root = workspace_root() / "data" / "memory" / str(company_id)
    out: list[tuple[str, str]] = []
    if not root.exists():
        return out
    for name in ("kb.json", "materials.json", "notes.md", "profile.txt", "company.md"):
        f = root / name
        if not f.exists():
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except Exception:  # noqa: BLE001
            continue
        # kb.json 里只要文本型内容，避免把线索/索引当画像
        if name.endswith(".json"):
            try:
                d = json.loads(text)
            except Exception:  # noqa: BLE001
                continue
            if name == "kb.json":
                d = {k: v for k, v in (d or {}).items() if k in ("materials", "docs", "notes")}
            text = json.dumps(d, ensure_ascii=False)
        if text.strip():
            out.append((name, text[:limit_chars]))
    return out


def harvest(company_id: str, *, source: str = "harvest", dry_run: bool = False) -> dict:
    """从企业已有素材里抽取画像事实并合并（自动沉淀的通用入口）。

    IQ/日常流程可直接调；永远不覆盖已有非空值，所以重复跑安全。
    """
    facts: dict = {}
    used: list[str] = []
    for name, text in _harvest_texts(company_id):
        got = extract_facts(text)
        if got:
            used.append(name)
            merged, _c, _s = merge_profile(facts, got)
            facts = merged
    if not facts:
        return {"ok": True, "wrote": False, "reason": "已有素材里没抽到可用事实", "sources": []}
    res = learn(company_id, facts, source=source, dry_run=dry_run)
    res["sources"] = used
    return res


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="企业画像自动沉淀（非破坏性合并）")
    p.add_argument("--company-id", required=True)
    sub = p.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("merge", help="合并结构化事实")
    m.add_argument("--facts-json", default="{}")
    m.add_argument("--facts-file", default="")
    m.add_argument("--source", default="")
    m.add_argument("--replace-fields", default="")

    h = sub.add_parser("harvest", help="从企业已有素材自动抽取并合并")
    h.add_argument("--source", default="harvest")

    e = sub.add_parser("extract", help="从自由文本抽并合并")
    e.add_argument("--text", default="")
    e.add_argument("--text-file", default="")
    e.add_argument("--source", default="text")

    for sp in (m, e, h):
        sp.add_argument("--apply", action="store_true", help="真正写入（默认 dry-run）")

    a = p.parse_args(argv)
    if a.cmd == "merge":
        if a.facts_file:
            facts = json.loads(Path(a.facts_file).read_text(encoding="utf-8"))
        else:
            facts = json.loads(a.facts_json or "{}")
        src = a.source
        rep = [x.strip() for x in (a.replace_fields or "").split(",") if x.strip()]
    elif a.cmd == "harvest":
        res = harvest(a.company_id, source=a.source, dry_run=not a.apply)
        print(json.dumps(res, ensure_ascii=False, indent=1))
        return 0 if res.get("ok") else 1
    else:
        text = a.text
        if a.text_file:
            text = Path(a.text_file).read_text(encoding="utf-8")
        facts = extract_facts(text)
        src = a.source
        rep = []

    res = learn(a.company_id, facts, source=src, replace_fields=rep, dry_run=not a.apply)
    res["ok"] = res.get("ok", True)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
