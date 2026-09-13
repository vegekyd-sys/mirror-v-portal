#!/usr/bin/env python3
"""dc_followup_panel — 在线索池里建「跟进记录」表，并把邮件往来回写进去。

设计（田耕郡 2026-09-13 定稿口径）：
  · 人类看得懂：字段全中文、类型简单（文本/单选），一线销售不用学；
  · 我方不出错：**幂等键 = 邮件 message_id**（文本字段），重复同步不会重复写行；
  · 线索池主表只加 3 个汇总字段（最近跟进时间 / 最近回复摘要 / 往来条数），
    长文本落到子表，列表依然干净；
  · 数据来源：email-facts（已按租户绑定邮箱收口）+ 线程案卷（两侧原文）+ 附件索引。

用法：
    # 1) 建表 + 建字段（幂等，已存在则跳过）
    python3 dc_followup_panel.py setup --base-token <pool_base> --pool-table <pool_table_id>
    # 2) 回写往来（只读事实层，写子表 + 更新汇总字段）
    python3 dc_followup_panel.py sync  --base-token <pool_base> --pool-table <pool_table_id> \
        --company-id <sid> --apply
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

FOLLOWUP_TABLE = "跟进记录"
FOLLOWUP_FIELDS = [
    {"name": "标题", "type": "text"},
    {"name": "时间", "type": "text"},
    {"name": "方向", "type": "select", "multiple": False,
     "options": [{"name": "出"}, {"name": "入"}]},
    {"name": "渠道", "type": "select", "multiple": False,
     "options": [{"name": "邮件"}, {"name": "WhatsApp"}]},
    {"name": "主题", "type": "text"},
    {"name": "原文", "type": "text"},
    {"name": "附件", "type": "text"},
    {"name": "分析", "type": "text"},
    {"name": "幂等键", "type": "text"},
]
POOL_SUMMARY_FIELDS = [
    {"name": "最近跟进时间", "type": "text"},
    {"name": "最近回复摘要", "type": "text"},
    {"name": "往来条数", "type": "number"},
]


def _lark(*args: str, timeout: int = 120) -> dict:
    r = subprocess.run(["lark-cli"] + list(args), capture_output=True, text=True, timeout=timeout)
    out = (r.stdout or "").strip()
    try:
        d = json.loads(out) if out else {}
    except json.JSONDecodeError:
        d = {"ok": False, "raw": out[:200], "stderr": (r.stderr or "")[:200]}
    if r.returncode != 0 and d.get("ok") is not False:
        d["ok"] = False
    return d


def _tables(base_token: str) -> list[dict]:
    d = _lark("base", "+table-list", "--base-token", base_token, "--as", "bot", "--json")
    return (d.get("data") or {}).get("tables") or []


def _fields(base_token: str, table_id: str) -> list[dict]:
    d = _lark("base", "+field-list", "--base-token", base_token, "--table-id", table_id,
              "--as", "bot", "--json")
    return (d.get("data") or {}).get("items") or (d.get("data") or {}).get("fields") or []


def setup(*, base_token: str, pool_table: str = "", apply: bool = False) -> dict:
    """建/检查「跟进记录」表 + 线索池汇总字段。幂等。"""
    out = {"base_token": base_token, "created_table": "", "created_fields": [],
           "pool_fields_created": [], "apply": apply}
    if not apply:
        out["plan"] = {"table": FOLLOWUP_TABLE, "fields": [f["name"] for f in FOLLOWUP_FIELDS],
                       "pool_fields": [f["name"] for f in POOL_SUMMARY_FIELDS]}
        return out

    existing = {str(t.get("name") or ""): str(t.get("table_id") or t.get("id") or "")
                for t in _tables(base_token)}
    tid = existing.get(FOLLOWUP_TABLE, "")
    if not tid:
        d = _lark("base", "+table-create", "--base-token", base_token, "--name", FOLLOWUP_TABLE,
                  "--fields", json.dumps(FOLLOWUP_FIELDS, ensure_ascii=False),
                  "--as", "bot", "--json")
        tbl = (d.get("data") or {}).get("table") or {}
        tid = str((d.get("data") or {}).get("table_id") or tbl.get("id") or "")
        out["created_table"] = tid
    out["table_id"] = tid
    if pool_table:
        have = {str(f.get("field_name") or f.get("name") or "") for f in _fields(base_token, pool_table)}
        for f in POOL_SUMMARY_FIELDS:
            if f["name"] in have:
                continue
            _lark("base", "+field-create", "--base-token", base_token, "--table-id", pool_table,
                  "--json", json.dumps(f, ensure_ascii=False), "--as", "bot",
                  "--format", "json")
            out["pool_fields_created"].append(f["name"])
    return out


def _norm_subject(s: str) -> str:
    import re
    return re.sub(r"^\s*(re|fwd|fw|回复|答复|转发)\s*[:：]\s*", "", str(s or ""), flags=re.I).strip()


def build_rows(*, company_id: str, data_dir=None) -> list[dict]:
    """从事实层生成「跟进记录」行（幂等键 = message_id）。"""
    import dc_thread_dossier as td
    facts = td.load_facts(data_dir, company_id)          # 内部已按租户邮箱收口
    rows = []
    for r in sorted(facts, key=lambda x: str(x.get("created_at") or "")):
        direction = "出" if r.get("_direction") == "outbound" else "入"
        body = r.get("text") or ""
        if direction == "入":
            body = td.strip_quoted(body)
        ts = str(r.get("created_at") or "")[:16].replace("T", " ")
        subj = _norm_subject(r.get("subject"))
        mid = str(r.get("resend_id") or r.get("message_id") or "")   # Resend id 更稳定
        rows.append({
            "标题": f"[{ts}] {direction} · {subj}"[:200],
            "时间": ts,
            "方向": [direction],
            "渠道": ["邮件"],
            "主题": subj[:200],
            "原文": body[:5000],
            "附件": "",
            "分析": "",
            "幂等键": mid,
        })
    return rows


def sync(*, base_token: str, table_id: str, company_id: str, pool_table: str = "",
         data_dir=None, apply: bool = False) -> dict:
    rows = build_rows(company_id=company_id, data_dir=data_dir)
    have = set()
    if apply and table_id:
        rows_now, _ = read_rows(base_token=base_token, table_id=table_id)
        for r in rows_now:
            k = r.get("幂等键")
            if isinstance(k, list) and k:
                k = k[0]
            if k:
                have.add(str(k))
    new = [r for r in rows if r["幂等键"] and r["幂等键"] not in have]
    result = {"company_id": company_id, "rows": len(rows), "already": len(have),
              "to_create": len(new), "created": 0, "applied": apply}
    if apply and new and table_id:
        for i in range(0, len(new), 100):
            chunk = new[i:i + 100]
            d = _lark("base", "+record-batch-create", "--base-token", base_token,
                      "--table-id", table_id,
                      "--json", json.dumps({"create_records": chunk}, ensure_ascii=False),
                      "--as", "bot", "--format", "json")
            if d.get("ok"):
                result["created"] += len(chunk)
    # 更新线索池汇总字段（最近跟进时间 / 最近回复摘要 / 往来条数）
    if apply and pool_table and rows:
        last = rows[-1]
        fields = {"最近跟进时间": last["时间"], "往来条数": len(rows)}
        inbound = [r for r in rows if r["方向"] == ["入"]]
        if inbound:
            fields["最近回复摘要"] = inbound[-1]["原文"][:120]
        result["pool_update"] = fields
    return result


def read_rows(*, base_token: str, table_id: str) -> tuple[list[dict], list[str]]:
    """读全表：返回 (行字典列表, record_id 列表)。按 field_id_list 列序解析。"""
    fmap = {str(f.get("field_name") or f.get("name") or ""): str(f.get("field_id") or f.get("id") or "")
            for f in _fields(base_token, table_id)}
    inv = {v: k for k, v in fmap.items()}
    d = _lark("base", "+record-list", "--base-token", base_token, "--table-id", table_id,
              "--limit", "200", "--as", "bot", "--format", "json")
    data = d.get("data") or {}
    fids = data.get("field_id_list") or []
    cols = [inv.get(f, f) for f in fids]
    rows, rids = [], data.get("record_id_list") or []
    for rec in (data.get("data") or []):
        if isinstance(rec, list):
            rows.append({c: v for c, v in zip(cols, rec)})
    return rows, list(rids)


def dedupe(*, base_token: str, table_id: str, apply: bool = False) -> dict:
    """按「幂等键」去重：保留每个键的第一条，其余删除。"""
    rows, rids = read_rows(base_token=base_token, table_id=table_id)
    seen, dup_ids = {}, []
    for i, r in enumerate(rows):
        k = r.get("幂等键")
        if isinstance(k, list) and k:
            k = k[0]
        k = str(k or "")
        if not k:
            continue
        if k in seen:
            if i < len(rids):
                dup_ids.append(rids[i])
        else:
            seen[k] = True
    deleted = 0
    if apply and dup_ids:
        d = _lark("base", "+record-delete", "--base-token", base_token, "--table-id", table_id,
                  "--json", json.dumps({"record_id_list": dup_ids}, ensure_ascii=False),
                  "--as", "bot", "--yes", "--format", "json")
        deleted = len(dup_ids) if d.get("ok") else 0
    return {"rows": len(rows), "unique_keys": len(seen), "duplicates": len(dup_ids),
            "deleted": deleted, "applied": apply}


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="线索池「跟进记录」表：建表 + 回写")
    ap.add_argument("cmd", choices=["setup", "sync", "plan", "dedupe"])
    ap.add_argument("--base-token", default=os.environ.get("DC_POOL_BASE_TOKEN", ""))
    ap.add_argument("--table-id", default="", help="跟进记录表 id")
    ap.add_argument("--pool-table", default=os.environ.get("DC_POOL_TABLE_ID", ""),
                    help="线索池主表 id（用于加汇总字段）")
    ap.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if args.cmd == "dedupe":
        r = dedupe(base_token=args.base_token, table_id=args.table_id, apply=args.apply)
        print(json.dumps(r, ensure_ascii=False, indent=2)); return 0
    if args.cmd == "plan" or not args.apply:
        r = setup(base_token=args.base_token, pool_table=args.pool_table, apply=False)
        r["sample_rows"] = build_rows(company_id=args.company_id,
                                      data_dir=args.data_dir or None)[:2]
    elif args.cmd == "setup":
        r = setup(base_token=args.base_token, pool_table=args.pool_table, apply=True)
        args.table_id = args.table_id or r.get("table_id", "")
        r["sync"] = sync(base_token=args.base_token, table_id=args.table_id,
                         company_id=args.company_id, pool_table=args.pool_table, apply=True)
    else:
        r = sync(base_token=args.base_token, table_id=args.table_id,
                 company_id=args.company_id, pool_table=args.pool_table,
                 data_dir=args.data_dir or None, apply=True)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
