#!/usr/bin/env python3
"""dc_dossier_link — 给线索池每一行生成「跟进档案」（飞书文档）并把链接回填到「跟进档案链接」字段。

链路：
  线索池行（公司名/官网/联系人）
    → 定位买家（邮箱/域名，复用 dc_thread_dossier.find_by_buyer）
    → 生成案卷 md（买家信息 + 两侧原文 + 分析）
    → 建/复用飞书文档（每买家一篇，缓存于 data/memory/<租户>/dossier_docs.json）
    → 把文档 URL 写回该行「跟进档案链接」

幂等：同一买家只建一篇文档；再次运行是**追加**新往来（不重复建）。
缺数据不编造：没有往来就不生成文档，也不写链接（如实计入 skipped）。

用法：
    python3 dc_dossier_link.py backfill --base-token <pool> --pool-table <tbl> --company-id <sid> --apply
    python3 dc_dossier_link.py backfill ... --limit 5            # 只处理前 5 行
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import dc_followup_panel as fp  # noqa: E402  复用其 read_rows / _lark / _fields
import dc_thread_dossier as td  # noqa: E402


def _doc_cache(company_id: str, data_dir=None) -> Path:
    base = Path(data_dir) if data_dir else Path(os.environ.get("DC_DATA_DIR") or (HERE.parent.parent / "data"))
    return base / "memory" / company_id / "dossier_docs.json"


def load_docs(company_id: str, data_dir=None) -> dict:
    p = _doc_cache(company_id, data_dir)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_docs(company_id: str, docs: dict, data_dir=None) -> None:
    p = _doc_cache(company_id, data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(docs, ensure_ascii=False, indent=2), encoding="utf-8")


def create_doc(title: str) -> str:
    d = fp._lark("docs", "+create", "--title", title, "--as", "bot", "--format", "json")
    data = d.get("data") or {}
    url = str(data.get("url") or data.get("doc_url") or "")
    if not url:
        doc = data.get("document") or {}
        url = str(doc.get("url") or "")
    return url


def append_md(url_or_token: str, md_text: str) -> bool:
    tmp = Path("/tmp") / "dossier_append.md"
    tmp.write_text(md_text, encoding="utf-8")
    token = url_or_token.split("/docx/")[-1].split("?")[0] if "/docx/" in url_or_token else url_or_token
    d = fp._lark("docs", "+update", "--doc", token, "--command", "append",
                 "--content", "@" + str(tmp), "--doc-format", "markdown",
                 "--as", "bot", "--format", "json")
    return bool(d.get("ok"))


def buyer_key(row: dict) -> str:
    return str(row.get("官网") or row.get("公司名") or "").strip()


def backfill(*, base_token: str, pool_table: str, company_id: str, data_dir=None,
             limit: int = 0, apply: bool = False) -> dict:
    rows, rids = fp.read_rows(base_token=base_token, table_id=pool_table)
    facts = td.load_facts(data_dir, company_id)
    threads = td.build_threads(facts)
    docs = load_docs(company_id, data_dir)
    out = {"rows": len(rows), "linked": 0, "created_docs": 0, "skipped_no_mail": 0,
           "failed": [], "apply": apply, "details": []}
    targets = rows[:limit] if limit else rows
    for row, rid in zip(targets, rids):
        website = str(row.get("官网") or "")
        name = str(row.get("公司名") or "")
        domain = website.replace("https://", "").replace("http://", "").split("/")[0].lower()
        keys = []
        if domain:
            keys = [k for k, rs in threads.items()
                    if any(domain in str(r.get("sender") or "").lower()
                           or any(domain in str(a).lower() for a in (r.get("recipients") or []))
                           for r in rs)]
        if not keys:
            out["skipped_no_mail"] += 1
            out["details"].append({"row": name, "status": "skip_no_mail"})
            continue
        md = "\n\n---\n\n".join(td.render_dossier(k, threads[k]) for k in keys)
        entry = docs.get(name) or {}
        url = str(entry.get("url") or "")
        appended = set(entry.get("appended_keys") or [])
        if not url:
            if not apply:
                out["details"].append({"row": name, "status": "would_create_doc"})
                continue
            url = create_doc(f"{name} · 跟进档案")
            if not url:
                out["failed"].append({"row": name, "error": "建文档失败"})
                continue
            docs[name] = {"url": url, "appended_keys": list(keys)}
            appended = set()
            out["created_docs"] += 1
        if apply and (set(keys) - appended):
            ok = append_md(url, md)
            if not ok:
                out["failed"].append({"row": name, "error": "追加内容失败"})
                continue
            upd = fp._lark("base", "+record-batch-update", "--base-token", base_token,
                           "--table-id", pool_table,
                           "--json", json.dumps({"update_records": {rid: {"跟进档案链接": url}}},
                                                 ensure_ascii=False),
                           "--as", "bot", "--format", "json")
            if upd.get("ok"):
                out["linked"] += 1
                out["details"].append({"row": name, "url": url})
            else:
                out["failed"].append({"row": name, "error": str(upd)[:120]})
        else:
            out["details"].append({"row": name, "status": "would_link", "threads": len(keys)})
    if apply:
        save_docs(company_id, docs, data_dir)
    return out


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="回填线索池「跟进档案链接」")
    ap.add_argument("cmd", choices=["backfill"])
    ap.add_argument("--base-token", default=os.environ.get("DC_POOL_BASE_TOKEN", ""))
    ap.add_argument("--pool-table", default=os.environ.get("DC_POOL_TABLE_ID", ""))
    ap.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    r = backfill(base_token=args.base_token, pool_table=args.pool_table,
                 company_id=args.company_id, data_dir=args.data_dir or None,
                 limit=args.limit, apply=args.apply)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if not r["failed"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
