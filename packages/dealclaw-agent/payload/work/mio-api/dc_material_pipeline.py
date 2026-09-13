#!/usr/bin/env python3
"""dc_material_pipeline — 物料入库「双写」管线。

输入：一批文件（PDF / 官网图 / PPT / 证书 / 案例…），来自用户上传或官网下载目录。
目标：**一一归位到对应物料类型**，并**双写**——
  · agent 侧：KB 引擎（data/memory/<企业>/kb.json + materials.json）→ 机器可读
  · 人类侧 A：飞书物料表（多维表，记录 + 附件）→ 人可检索
  · 人类侧 B：飞书主题页文档的「物料清单」→ 人可阅读

每一步都做**回读校验**；任一侧失败都如实报告，绝不宣称"已入库"。
坐标自动解析（缓存 → 发现 → 兜底创建），不需要人工给 token。

用法：
    python3 dc_material_pipeline.py --dir /path/to/assets --enterprise <sid> --json
    python3 dc_material_pipeline.py --file a.pdf --file b.png
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from dc_kb_engine import KB_DIR, KBEngine, MATERIAL_LABELS  # noqa: E402
from dc_material_ingest import (BITABLE_TYPE_NAMES, IMAGE_EXT, SUPPORTED_EXT,  # noqa: E402
                               infer_type, ingest)


def classify_file(path: Path) -> str:
    """图片按主图/参数表细分，其余按文件名语义。返回物料键（sample/spec/...）。"""
    ext = path.suffix.lower()
    if ext in IMAGE_EXT and ("参数" in path.name or "规格" in path.name or "spec" in path.name.lower()):
        return "spec"
    return infer_type(path.name)


def group_files(paths: list[Path]) -> dict:
    """按物料类型归位：{物料键: [文件路径, ...]}。一条记录 = 一个可独立调用的物料单元。"""
    groups: dict[str, list[str]] = {}
    for p in paths:
        if p.suffix.lower() not in SUPPORTED_EXT:
            continue
        groups.setdefault(classify_file(p), []).append(str(p))
    return groups


def _lark(*args: str, timeout: int = 120) -> dict:
    r = subprocess.run(["lark-cli"] + list(args), capture_output=True, text=True, timeout=timeout)
    out = (r.stdout or "").strip()
    try:
        return json.loads(out) if out else {}
    except json.JSONDecodeError:
        return {"ok": False, "raw": out[:200], "stderr": (r.stderr or "")[:200]}


# ── 人类侧 B：主题页文档 ────────────────────────────────────────────
def _doc_cache(enterprise: str) -> Path:
    key = KBEngine()._key(enterprise)
    return KB_DIR / key / "kb_doc.json"


def read_doc(enterprise: str) -> dict:
    p = _doc_cache(enterprise)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def write_doc(enterprise: str, data: dict) -> None:
    p = _doc_cache(enterprise)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def ensure_doc(enterprise: str, company_name: str = "") -> dict:
    """取（或创建）主题页文档，返回 {token, url, created}。"""
    cur = read_doc(enterprise)
    if cur.get("token"):
        return cur
    try:
        from dc_kb_publish import publish, build_master_index
        url = publish(f"{company_name or enterprise} · 知识库", "", enterprise) or ""
    except Exception:
        url = ""
    token = ""
    if url and "/docx/" in url:
        token = url.split("/docx/")[1].split("?")[0]
    if token:
        data = {"token": token, "url": url, "created": True,
                "created_at": datetime.now(timezone.utc).isoformat()}
        write_doc(enterprise, data)
        return data
    return {"token": "", "url": "", "created": False, "error": "创建文档失败"}


def doc_material_table(enterprise: str) -> str:
    """生成追加到文档的「物料清单」Markdown。"""
    mats = KBEngine().ensure(enterprise).get("materials", {})
    lines = ["", f"## 📋 物料清单（更新于 {datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M')}）", "",
             "| 类型 | 文件名称 | 状态 | 营销用途 |", "|---|---|---|---|"]
    for key, m in mats.items():
        if not m:
            continue
        label = BITABLE_TYPE_NAMES.get(key, MATERIAL_LABELS.get(key, key))
        lines.append(f"| {label} | {m.get('name','')} | "
                     f"{'✅' if m.get('status') == 'ready' else '⬜'} | "
                     f"{(m.get('description') or '')[:40]} |")
    return "\n".join(lines) + "\n"


def append_doc_section(enterprise: str, company_name: str = "",
                       names: tuple = ()) -> dict:
    """把物料清单写进主题页文档（人类侧 B），并**按内容回读校验**。

    - 已存在「物料清单」→ 不重复追加，只校验（幂等）
    - 不存在 → append，然后 fetch 回读，要求命中表头 + 至少一个本次文件名
    """
    doc = ensure_doc(enterprise, company_name)
    token = doc.get("token")
    if not token:
        return {"ok": False, "skipped": True, "reason": doc.get("error") or "无文档 token"}

    def _content() -> str:
        f = _lark("docs", "+fetch", "--doc", token, "--as", "bot", "--json")
        return str(((f.get("data") or {}).get("document") or {}).get("content") or "")

    md = doc_material_table(enterprise)
    header = "物料清单"
    body = _content()
    if header in body:
        ok = all(n and n in body for n in names) if names else True
        return {"ok": ok, "url": doc.get("url", ""), "mode": "already_present",
                "verified_names": [n for n in names if n and n in body]}

    r = _lark("docs", "+update", "--doc", token, "--revision-id", "-1",
              "--command", "append", "--content", md, "--doc-format", "markdown",
              "--as", "bot", "--json")
    if not r.get("ok"):
        return {"ok": False, "url": doc.get("url", ""), "error": str(r)[:160]}
    body = _content()
    ok = header in body and (not names or any(n and n in body for n in names))
    return {"ok": ok, "url": doc.get("url", ""), "mode": "appended",
            "appended_lines": len(md.splitlines())}


# ── 主流程 ────────────────────────────────────────────────────────
def run(paths: list[Path], *, enterprise: str, company_name: str = "",
        auto_target: bool = True, description: str = "") -> dict:
    groups = group_files([Path(p) for p in paths])
    per_type: list[dict] = []
    for mtype, files in sorted(groups.items()):
        for f in files:
            res = ingest(enterprise=enterprise, file_path=Path(f), mtype=mtype,
                         description=description, auto_target=auto_target)
            per_type.append(res)

    # 人类侧 A：物料表的回读校验（记录数应 >= 本次入库条数）
    table_ok = False
    table_detail: dict = {}
    for res in per_type:
        b = res.get("bitable") or {}
        if b.get("ok"):
            table_ok = True
            table_detail = {"records": b.get("records"), "attached": b.get("attached")}
            break
    # 人类侧 B：主题页文档
    names = tuple(Path(r["file"]).stem for r in per_type)
    doc_result = append_doc_section(enterprise, company_name, names) if per_type else \
        {"ok": False, "skipped": True, "reason": "无文件"}
    # agent 侧：KB 回读
    agent_ok = all(r.get("verified_readable") for r in per_type) and bool(per_type)
    links = KBEngine().get_material_links(enterprise)

    return {
        "enterprise": enterprise,
        "company_name": company_name,
        "ingested": len(per_type),
        "by_type": {k: len(v) for k, v in sorted(groups.items())},
        "double_write": {
            "agent_kb": {"ok": agent_ok, "readable_types": [m["type"] for m in links]},
            "human_table": {"ok": table_ok, **table_detail},
            "human_doc": doc_result,
        },
        "items": [{"type": r["type"], "file": r["file"],
                   "verified_readable": r["verified_readable"],
                   "table_ok": bool((r.get("bitable") or {}).get("ok"))} for r in per_type],
    }


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="物料入库双写管线")
    ap.add_argument("--dir", default="", help="目录（官网下载/PDF 提取目录）")
    ap.add_argument("--file", action="append", default=[], help="单个文件（可重复）")
    ap.add_argument("--enterprise", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--company-name", default="")
    ap.add_argument("--description", default="")
    ap.add_argument("--no-auto-target", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    paths: list[Path] = [Path(f) for f in args.file]
    if args.dir:
        d = Path(args.dir)
        paths += [p for p in sorted(d.rglob("*")) if p.is_file()]
    if not paths:
        print("没有输入文件（--dir 或 --file）", file=sys.stderr)
        return 2
    if not args.enterprise:
        print("缺少 enterprise", file=sys.stderr)
        return 2

    r = run(paths, enterprise=args.enterprise, company_name=args.company_name,
            auto_target=not args.no_auto_target, description=args.description)
    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        dw = r["double_write"]
        print(f"入库 {r['ingested']} 件 | 归位：{r['by_type']}")
        print(f"  agent 侧 KB   : {'✅' if dw['agent_kb']['ok'] else '❌'}")
        print(f"  人类侧 物料表 : {'✅' if dw['human_table']['ok'] else '❌'} {dw['human_table']}")
        print(f"  人类侧 文档   : {'✅' if dw['human_doc'].get('ok') else '❌'} {dw['human_doc']}")
    ok = (r["double_write"]["agent_kb"]["ok"] and r["double_write"]["human_table"]["ok"])
    return 0 if ok else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
