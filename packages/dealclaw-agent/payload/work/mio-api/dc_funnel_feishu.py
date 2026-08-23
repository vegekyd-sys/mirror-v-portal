#!/usr/bin/env python3
"""
dc_funnel_feishu.py — 邮件营销漏斗 → 飞书表 + 漏斗图（标准化，所有企业通用）

标准格式（每个企业）：
  1. 线索池表        （已有，find-buyers/leads 建）
  2. 邮件跟进表      （dc_memory_data sync-email-followup）
  3. 邮件营销漏斗表  （本脚本建，数据 = build_funnel 实时聚合 email-facts + 七信号，不手填）
  4. 七信号仪表盘 + 漏斗图（本脚本建，读「邮件营销漏斗」表）

用法：
  python3 dc_funnel_feishu.py sync <company_id> <base_token>
"""
import json
import re
import subprocess
import sys

FUNNEL_TABLE = "邮件营销漏斗"
DASHBOARD_NAME = "七信号仪表盘"
FUNNEL_BLOCK = "营销转化漏斗"

_FIELDS = [
    {"name": "漏斗层级", "type": "text"},
    {"name": "数量", "type": "number", "style": {"type": "plain", "precision": 0}},
]


def _lark(args: list[str]) -> dict:
    cmd = ["lark-cli", "base"] + args + ["--as", "bot"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    out = (r.stdout or "").strip()
    try:
        i = out.find("{")
        if i >= 0:
            return json.loads(out[i:])
    except Exception:
        pass
    return {"ok": False, "raw": out[:600], "stderr": (r.stderr or "")[:300]}


def _funnel_rows(company_id: str) -> list[tuple[str, int]]:
    from dc_growth_dashboard import build_funnel
    f = build_funnel(company_id)
    return [
        ("发送", int(f.get("sent", 0))),
        ("送达", int(f.get("delivered", 0))),
        ("回复", int(f.get("replied", 0))),
        ("有效询盘", int(f.get("valid_inquiry", 0))),
        ("会议意向", int(f.get("meeting_intent", 0))),
    ]


def _table_id(base_token: str, name: str) -> str:
    d = _lark(["+table-list", "--base-token", base_token])
    for t in d.get("data", {}).get("tables", []):
        if t.get("name") == name:
            return t.get("id", "")
    return ""


def _dashboard_id(base_token: str) -> str:
    d = _lark(["+dashboard-list", "--base-token", base_token])
    for it in d.get("data", {}).get("items", []):
        if it.get("name") == DASHBOARD_NAME:
            return it.get("dashboard_id", "")
    return ""


def _block_id(base_token: str, dashboard_id: str) -> str:
    d = _lark(["+dashboard-block-list", "--base-token", base_token, "--dashboard-id", dashboard_id])
    blocks = d.get("data", {}).get("blocks") or d.get("data", {}).get("items") or []
    for b in blocks:
        if b.get("name") == FUNNEL_BLOCK:
            return b.get("block_id", "")
    return ""


def _record_ids(base_token: str, table_id: str) -> list[str]:
    r = subprocess.run(
        ["lark-cli", "base", "+record-list", "--as", "bot",
         "--base-token", base_token, "--table-id", table_id, "--limit", "200"],
        capture_output=True, text=True, timeout=120)
    return re.findall(r"\brec[A-Za-z0-9]+\b", r.stdout or "")


def _clear_table(base_token: str, table_id: str) -> None:
    ids = _record_ids(base_token, table_id)
    if not ids:
        return
    args = ["+record-delete", "--base-token", base_token, "--table-id", table_id]
    for rid in ids:
        args += ["--record-id", rid]
    args += ["--yes"]
    _lark(args)


def _write_rows(base_token: str, table_id: str, rows: list[tuple[str, int]]) -> None:
    import tempfile, os
    payload = {"fields": ["漏斗层级", "数量"], "rows": [[a, b] for a, b in rows]}
    tmp = os.path.join(os.getcwd(), ".funnel_batch.json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    try:
        _lark(["+record-batch-create", "--base-token", base_token, "--table-id", table_id,
               "--json", "@./.funnel_batch.json"])
    finally:
        os.unlink(tmp)


def sync(company_id: str, base_token: str) -> dict:
    rows = _funnel_rows(company_id)

    # 1. 表
    tid = _table_id(base_token, FUNNEL_TABLE)
    created_table = False
    if not tid:
        d = _lark(["+table-create", "--base-token", base_token, "--name", FUNNEL_TABLE,
                   "--fields", json.dumps(_FIELDS)])
        tid = d.get("data", {}).get("table", {}).get("id", "")
        if not tid:
            return {"ok": False, "error": "table create failed", "detail": d}
        created_table = True

    # 2. 写数据（清空重写）
    _clear_table(base_token, tid)
    _write_rows(base_token, tid, rows)

    # 3. 仪表盘
    did = _dashboard_id(base_token)
    created_dashboard = False
    if not did:
        d = _lark(["+dashboard-create", "--base-token", base_token, "--name", DASHBOARD_NAME])
        did = d.get("data", {}).get("dashboard", {}).get("dashboard_id", "")
        if not did:
            return {"ok": False, "error": "dashboard create failed", "detail": d}
        created_dashboard = True

    # 4. 漏斗图
    bid = _block_id(base_token, did)
    created_block = False
    if not bid:
        d = _lark(["+dashboard-block-create", "--base-token", base_token, "--dashboard-id", did,
                   "--name", FUNNEL_BLOCK, "--type", "funnel",
                   "--data-config", json.dumps({
                       "table_name": FUNNEL_TABLE,
                       "series": [{"field_name": "数量", "rollup": "SUM"}],
                       "group_by": [{"field_name": "漏斗层级", "mode": "integrated",
                                     "sort": {"type": "value", "order": "desc"}}],
                   })])
        bid = d.get("data", {}).get("block", {}).get("block_id", "")
        if not bid:
            return {"ok": False, "error": "block create failed", "detail": d}
        created_block = True

    return {
        "ok": True,
        "company_id": company_id,
        "table_id": tid,
        "dashboard_id": did,
        "block_id": bid,
        "rows": dict(rows),
        "created_table": created_table,
        "created_dashboard": created_dashboard,
        "created_block": created_block,
    }


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "sync":
        print(json.dumps(sync(sys.argv[2], sys.argv[3]), ensure_ascii=False, indent=2))
    else:
        print(json.dumps({"usage": "dc_funnel_feishu.py sync <company_id> <base_token>"}, ensure_ascii=False))
