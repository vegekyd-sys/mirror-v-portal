#!/usr/bin/env python3
"""
dc_feishu_standard.py — 企业飞书标准格式（所有企业通用）

标准格式（每个企业）：
  1. 线索池表        （find-buyers / leads 建，已存在）
  2. 邮件跟进表      （本脚本，数据 = email_followup.json）
  3. 邮件营销漏斗表  （dc_funnel_feishu，数据 = build_funnel 实时聚合）
  4. 七信号仪表盘    （dc_funnel_feishu，漏斗图读「邮件营销漏斗」表）

用法：
  python3 dc_feishu_standard.py sync-all <company_id> <base_token>
  python3 dc_feishu_standard.py sync-email-followup <company_id> <base_token>
"""
import json
import re
import subprocess
import sys

from dc_funnel_feishu import sync as _sync_funnel, _lark, _table_id, _record_ids

EMAIL_FOLLOWUP_TABLE = "邮件跟进"

FOLLOWUP_FIELDS = [
    {"name": "公司名", "type": "text"},
    {"name": "官网", "type": "text", "style": {"type": "url"}},
    {"name": "国家", "type": "text"},
    {"name": "买家类型", "type": "text"},
    {"name": "联系人名", "type": "text"},
    {"name": "联系人信息", "type": "text"},
    {"name": "跟进状态", "type": "text"},
    {"name": "已发邮件数", "type": "number", "style": {"type": "plain", "precision": 0}},
    {"name": "买家回复数", "type": "number", "style": {"type": "plain", "precision": 0}},
    {"name": "已跟进轮次", "type": "number", "style": {"type": "plain", "precision": 0}},
    {"name": "最近联系时间", "type": "text"},
    {"name": "邮件全部内容", "type": "text"},
]
FOLLOWUP_FIELD_NAMES = [f["name"] for f in FOLLOWUP_FIELDS]


def _site_url(website: str) -> str:
    m = re.search(r"\((https?://[^)]+)\)", website or "")
    return m.group(1) if m else (website or "")


def _ts(ts) -> str:
    return str(ts or "").replace("T", " ").replace("Z", "")[:19]


def _mail_text(m: dict) -> str:
    d = "发出" if m.get("direction") == "out" else "收到"
    r = m.get("round")
    if d == "发出" and r == 0:
        tag = "首次触达"
    elif d == "发出" and r is not None:
        tag = f"第{r}次跟进"
    else:
        tag = "买家回复"
    body = m.get("content") or "[历史记录未保存正文]"
    return f"【{tag}｜{d}｜{_ts(m.get('sent_at', ''))}】\n主题：{m.get('subject', '')}\n正文：{body}"


def _build_followup_rows(company_id: str) -> list[list]:
    from dc_memory_data import read_email_followup
    out = []
    for r in read_email_followup(company_id):
        timeline = "\n\n".join(_mail_text(m) for m in r.get("emails", []))
        out.append([
            r.get("company", ""),
            _site_url(r.get("website", "")),
            r.get("country", ""),
            r.get("buyer_type", ""),
            "、".join(r.get("contact_names", [])),
            r.get("contact", ""),
            r.get("stage", ""),
            int(r.get("outbound_count", 0)),
            int(r.get("inbound_count", 0)),
            int(r.get("touch_number", 0)),
            _ts(r.get("latest_at", "")),
            timeline,
        ])
    return out


def _clear_table(base_token: str, table_id: str) -> None:
    ids = _record_ids(base_token, table_id)
    if not ids:
        return
    args = ["+record-delete", "--base-token", base_token, "--table-id", table_id]
    for rid in ids:
        args += ["--record-id", rid]
    args += ["--yes"]
    _lark(args)


def _write_rows(base_token: str, table_id: str, rows: list[list]) -> None:
    import os
    payload = {"fields": FOLLOWUP_FIELD_NAMES, "rows": rows}
    tmp = os.path.join(os.getcwd(), ".followup_batch.json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    try:
        _lark(["+record-batch-create", "--base-token", base_token, "--table-id", table_id,
               "--json", "@./.followup_batch.json"])
    finally:
        os.unlink(tmp)


def sync_email_followup(company_id: str, base_token: str) -> dict:
    rows = _build_followup_rows(company_id)
    tid = _table_id(base_token, EMAIL_FOLLOWUP_TABLE)
    created = False
    if not tid:
        d = _lark(["+table-create", "--base-token", base_token, "--name", EMAIL_FOLLOWUP_TABLE,
                   "--fields", json.dumps(FOLLOWUP_FIELDS)])
        tid = d.get("data", {}).get("table", {}).get("id", "")
        if not tid:
            return {"ok": False, "error": "table create failed", "detail": d}
        created = True
    _clear_table(base_token, tid)
    _write_rows(base_token, tid, rows)
    return {"ok": True, "table_id": tid, "rows": len(rows), "created": created}


def sync_all(company_id: str, base_token: str) -> dict:
    out = {"email_followup": sync_email_followup(company_id, base_token)}
    try:
        out["funnel"] = _sync_funnel(company_id, base_token)
    except Exception as e:
        out["funnel"] = {"ok": False, "error": str(e)}
    out["ok"] = out["email_followup"].get("ok") and out["funnel"].get("ok")
    return out


if __name__ == "__main__":
    if len(sys.argv) >= 4:
        cmd, company_id, base_token = sys.argv[1], sys.argv[2], sys.argv[3]
        if cmd == "sync-all":
            print(json.dumps(sync_all(company_id, base_token), ensure_ascii=False, indent=2))
        elif cmd == "sync-email-followup":
            print(json.dumps(sync_email_followup(company_id, base_token), ensure_ascii=False, indent=2))
        else:
            print(json.dumps({"error": f"unknown cmd {cmd}"}, ensure_ascii=False))
    else:
        print(json.dumps({"usage": "dc_feishu_standard.py sync-all <company_id> <base_token>"}, ensure_ascii=False))
