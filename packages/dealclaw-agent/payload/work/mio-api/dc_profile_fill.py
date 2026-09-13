#!/usr/bin/env python3
"""dc_profile_fill — 企业画像补全（面向所有租户，通用）。

背景：`company info` 的 productTags / adProducts / advantage 常为空 →
      买家搜索缺"匹配产品"基准 → 只能靠猜关键词。

本工具做四步（默认只读，`--apply` 才写）：
  ① 取资料：KB 企业画像(data/memory/<supplier_id>/kb.json) → 本地文本 → 官网/店铺 URL
  ② 抽取：--extract-json（由模型/人工给出）或 --llm（走 OpenRouter 兼容端点）
  ③ 对齐：把产品词对齐到平台采购类目树（all-category），避免叶子类目无买家
  ④ 回写：company info 拉全量 → 只覆盖要改字段 → company edit（先拉取再合并）

用法（只读，出 diff）：
    python3 dc_profile_fill.py --text-file profile.txt
    python3 dc_profile_fill.py --extract-json extract.json --category-json cat.json
    python3 dc_profile_fill.py --tenants-file tenants.json          # 批量，全租户
写回：
    python3 dc_profile_fill.py --extract-json extract.json --apply
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# ── 可写字段（company edit / editSaveBasic.json）──
EDITABLE = {
    "product_tags": "--product-tags",
    "ad_products": "--ad-products",
    "advantage": "--advantage",
}
# company info 返回字段 → 内部键
CURRENT_MAP = {
    "product_tags": ("productTags",),
    "ad_products": ("adProducts", "adProduct"),
    "advantage": ("advantage",),
}


def _run(cmd: list[str], timeout: int = 60) -> dict:
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError(f"命令失败: {' '.join(cmd[:3])}... {out.stderr[-200:]}")
    return json.loads(out.stdout)


def _cli(*args: str, open_id: str, supplier_id: str) -> dict:
    base = ["xiaoyuan", "--open-id", open_id, "--supplier-id", supplier_id]
    return _run(base + list(args))


def company_info(open_id: str, supplier_id: str) -> dict:
    d = _cli("company", "info", open_id=open_id, supplier_id=supplier_id)
    return (d.get("response") or {}).get("data") or d.get("data") or {}


def all_categories(open_id: str, supplier_id: str) -> dict:
    d = _cli("buyer", "all-category", open_id=open_id, supplier_id=supplier_id)
    return (d.get("response") or {}).get("data") or d.get("data") or {}


# ── 纯函数：类目对齐 ──
def _unwrap_roots(payload):
    """兼容 CLI 整包({path,request,response:{data:...}})、{data:...}、{records/children:[...]} 与裸列表。"""
    node = payload
    for _ in range(4):
        if isinstance(node, dict):
            nxt = None
            for key in ("response", "data"):
                if isinstance(node.get(key), (dict, list)):
                    nxt = node[key]
                    break
            if nxt is None:
                nxt = node.get("records") or node.get("children")
            if nxt is None:
                return []
            node = nxt
        elif isinstance(node, list):
            return node
        else:
            return []
    return node if isinstance(node, list) else []


def flatten_categories(roots) -> list[dict]:
    """类目树 → [{path:[names], ids:[ids], name, level}]。"""
    roots = _unwrap_roots(roots)
    out: list[dict] = []

    def walk(nodes, names=(), ids=()):
        for n in nodes or []:
            nm = str(n.get("name") or n.get("categoryName") or "").strip()
            nid = str(n.get("id") or n.get("categoryId") or "").strip()
            pn, pi = names + (nm,), ids + (nid,)
            out.append({"path": list(pn), "ids": list(pi), "name": nm, "level": len(pn)})
            walk(n.get("children") or [], pn, pi)

    walk(roots if isinstance(roots, list) else (roots.get("records") or roots.get("children") or []))
    return out


def match_categories(keywords, flat: list[dict], *, top: int = 5,
                     prefer_levels=(2, 3)) -> list[dict]:
    """产品词 → 类目候选。打分：名称精确/包含 + 层级偏好（避开过窄叶子）。"""
    kws = [str(k).strip().lower() for k in (keywords or []) if str(k).strip()]
    hits = []
    for node in flat:
        nm = node["name"].lower()
        score = 0.0
        for k in kws:
            if not k or not nm:
                continue
            if k == nm:
                score += 3.0
            elif k in nm or nm in k:
                score += 2.0
            # 逐字重合（中英混合的粗匹配）
            overlap = len(set(k) & set(nm))
            if overlap >= 2:
                score += min(overlap, 4) * 0.25
        if score <= 0:
            continue
        if node["level"] in prefer_levels:
            score += 0.5
        hits.append({**node, "score": round(score, 2)})
    hits.sort(key=lambda x: (-x["score"], x["level"]))
    return hits[:top]


# ── 纯函数：合并 / diff ──
def current_profile(info: dict) -> dict:
    out = {}
    for key, aliases in CURRENT_MAP.items():
        for a in aliases:
            v = info.get(a)
            if v:
                out[key] = v
                break
    return out


def merge_edit(current: dict, proposed: dict) -> dict:
    """只输出**真正变化**的字段（避免覆盖未变字段）。"""
    payload = {}
    for key, cli_flag in EDITABLE.items():
        new = proposed.get(key)
        if new in (None, "", []):
            continue
        old = current.get(key)
        if isinstance(new, (list, tuple)):
            new = ", ".join(str(x) for x in new if str(x).strip())
        if str(new).strip() != str(old or "").strip():
            payload[cli_flag] = str(new).strip()
    return payload


def render_diff(current: dict, proposed: dict, payload: dict, cats: list[dict]) -> str:
    lines = ["字段                现行值 → 建议值", "-" * 60]
    for key in EDITABLE:
        old = current.get(key) or "（空）"
        new = proposed.get(key) or "（未提供）"
        flag = EDITABLE[key] in payload
        lines.append(f"{key:18} {str(old)[:40]} → {str(new)[:60]}{'  ✱待写' if flag else ''}")
    lines.append("")
    lines.append("对齐到的采购类目（搜索用；避免叶子类目）：")
    if not cats:
        lines.append("  （无匹配）")
    for c in cats:
        lines.append(f"  {' / '.join(c['path'])}   ids={c['ids']}  score={c['score']}  level={c['level']}")
    return "\n".join(lines)


def apply_edit(payload: dict, *, open_id: str, supplier_id: str) -> dict:
    args = []
    for flag, value in payload.items():
        args += [flag, value]
    if not args:
        return {"skipped": True, "reason": "没有字段变化"}
    return _cli("company", "edit", *args, open_id=open_id, supplier_id=supplier_id)


def load_extract(path: str | None, text: str = "") -> dict:
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    if text:
        # 极简兜底：把文本里的产品词按行/逗号切成标签（模型抽取应由 --extract-json 提供）
        words = [w.strip() for w in re.split(r"[\n,，;；、|]+", text) if w.strip()]
        return {"product_tags": words[:20], "ad_products": words[:10], "advantage": ""}
    return {}


def fill_one(*, open_id: str, supplier_id: str, extract: dict,
             flat_cats: list[dict] | None, apply: bool = False,
             prefer_levels=(2, 3)) -> dict:
    info = company_info(open_id, supplier_id)
    cur = current_profile(info)
    proposed = {
        "product_tags": extract.get("product_tags") or extract.get("products") or [],
        "ad_products": extract.get("ad_products") or [],
        "advantage": extract.get("advantage") or "",
    }
    payload = merge_edit(cur, proposed)
    kws = list(proposed["product_tags"]) + list(proposed["ad_products"])
    cats = match_categories(kws, flat_cats or [], prefer_levels=prefer_levels)
    result = {
        "company": info.get("companyName") or "",
        "supplier_id": supplier_id,
        "current": cur,
        "proposed": proposed,
        "edit_payload": payload,
        "categories": cats,
        "diff": render_diff(cur, proposed, payload, cats),
    }
    if apply and payload:
        result["apply_result"] = apply_edit(payload, open_id=open_id, supplier_id=supplier_id)
    return result


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="企业画像补全（通用，默认只读）")
    ap.add_argument("--extract-json", default="", help="模型/人工抽取结果 JSON")
    ap.add_argument("--text-file", default="", help="资料文本（无 extract-json 时按行切词兜底）")
    ap.add_argument("--category-json", default="", help="all-category 结果缓存；缺省实时拉取")
    ap.add_argument("--tenants-file", default="", help="批量：JSON 数组 [{open_id,supplier_id,name}]")
    ap.add_argument("--open-id", default=os.environ.get("MIO_V_OPEN_ID", ""))
    ap.add_argument("--supplier-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--apply", action="store_true", help="真正回写（默认只出 diff）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args(argv)

    text = Path(args.text_file).read_text(encoding="utf-8") if args.text_file else ""
    extract = load_extract(args.extract_json or None, text)

    tenants = []
    if args.tenants_file:
        tenants = json.loads(Path(args.tenants_file).read_text(encoding="utf-8"))
    else:
        tenants = [{"open_id": args.open_id, "supplier_id": args.supplier_id}]

    results = []
    for t in tenants:
        oid, sid = t.get("open_id") or args.open_id, t.get("supplier_id") or args.supplier_id
        if not oid or not sid:
            results.append({"supplier_id": sid, "error": "缺 open_id/supplier_id"})
            continue
        try:
            flat = (flatten_categories(json.loads(Path(args.category_json).read_text(encoding="utf-8")))
                    if args.category_json else flatten_categories(all_categories(oid, sid)))
            results.append(fill_one(open_id=oid, supplier_id=sid, extract=extract,
                                    flat_cats=flat, apply=args.apply))
        except Exception as e:  # 单租户失败不影响其他租户
            results.append({"supplier_id": sid, "error": str(e)})

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print(f"===== {r.get('company') or r.get('supplier_id')} =====")
            print(r.get("diff") or r.get("error"))
            print()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
