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
INTERACTION_TABLE = "沟通明细"

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
]
FOLLOWUP_FIELD_NAMES = [f["name"] for f in FOLLOWUP_FIELDS]

# 沟通明细子表（一行一次互动，对齐 customer-dossier-schema.md 的 interaction）
# 「客户关联」是 link 字段，关联线索池主表 record（展示公司名、底层存 record_id）；
# 无线索池主表时降级为 text「客户」展示名。
def _interaction_fields(lead_table_id: str = "") -> list:
    head = [{"name": "客户关联", "type": "link", "link_table": lead_table_id}] if lead_table_id \
        else [{"name": "客户", "type": "text"}]
    return head + [
        {"name": "渠道", "type": "text"},
        {"name": "方向", "type": "text"},
        {"name": "时间", "type": "text"},
        {"name": "主题", "type": "text"},
        {"name": "摘要", "type": "text"},
        {"name": "发送状态", "type": "text"},
        {"name": "是否有回复", "type": "checkbox"},
        {"name": "thread_id", "type": "text"},
        {"name": "互动ID", "type": "text"},
        {"name": "客户ID", "type": "text"},
        {"name": "商机ID", "type": "text"},
        {"name": "展会ID", "type": "text"},
        {"name": "原文引用", "type": "text"},
        {"name": "来源系统", "type": "text"},
        {"name": "来源记录ID", "type": "text"},
    ]


def _interaction_field_names(lead_table_id: str = "") -> list:
    return [f["name"] for f in _interaction_fields(lead_table_id)]


def _site_url(website: str) -> str:
    m = re.search(r"\((https?://[^)]+)\)", website or "")
    return m.group(1) if m else (website or "")


def _ts(ts) -> str:
    return str(ts or "").replace("T", " ").replace("Z", "")[:19]


def _build_followup_rows(company_id: str) -> list[list]:
    from dc_memory_data import read_email_followup
    out = []
    for r in read_email_followup(company_id):
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
        ])
    return out


def _lead_record_index(base_token: str, lead_table_id: str) -> dict:
    """线索池主表 record_id 索引：cdp:/website:/company: → record_id（用于「客户关联」link 字段）。

    复用 dc_company_registry._existing_record_index；无线索池主表或解析失败时静默返回空索引。
    """
    if not base_token or not lead_table_id:
        return {}
    try:
        from dc_company_registry import _existing_record_index
        return _existing_record_index(base_token, lead_table_id)
    except Exception:
        return {}


def _lead_table_id(company_id: str) -> str:
    """企业线索池主表 table_id（从 CompanyRegistry 读）。"""
    try:
        from dc_company_registry import CompanyRegistry
        from enterprise_ids import slug_for
        entry = CompanyRegistry().get(slug_for(company_id))
        return (entry or {}).get("table_id", "")
    except Exception:
        return ""


def _persist_interaction_table_id(company_id: str, tid: str) -> None:
    """把「沟通明细」子表 table_id 写回 registry（interaction_table_id 字段）。

    失败静默：不阻断主流程，链接层会兜底用线索池 bitable_url。
    """
    if not tid:
        return
    try:
        from dc_company_registry import CompanyRegistry
        from enterprise_ids import slug_for
        reg = CompanyRegistry()
        key = slug_for(company_id)
        entry = dict(reg.get(key) or {})
        entry["interaction_table_id"] = tid
        reg.set(key, entry)
    except Exception:
        pass


def _norm_key(v) -> str:
    return " ".join(str(v or "").split()).strip().lower()


def _resolve_link(lead_table_id: str, lead_index: dict, it: dict) -> list:
    """解析「客户关联」link 字段值：[{"id": record_id}] 或 []（无线索池主表 / 无 record_id）。"""
    if not lead_table_id:
        return []
    cid = _norm_key(it.get("customer_id", ""))
    display = _norm_key(it.get("customer_display", ""))
    rid = lead_index.get(f"cdp:{cid}") or lead_index.get(f"company:{display}") or ""
    return [{"id": rid}] if rid else []


def _build_interaction_rows(company_id: str, lead_table_id: str = "", lead_index: dict = None) -> list[list]:
    """沟通明细子表行：一行一次互动，不含邮件全文。

    - 客户关联：link 字段（有 lead_table_id 时）存 [{"id": record_id}]，否则 text 展示名
    - 正文不进表格，summary 是截断摘要，raw_record_ref 存原文引用
    """
    from dc_memory_data import read_interactions
    lead_index = lead_index if lead_index is not None else {}
    out = []
    for it in read_interactions(company_id):
        if lead_table_id:
            customer_cell = _resolve_link(lead_table_id, lead_index, it)
        else:
            customer_cell = it.get("customer_display", "")
        out.append([
            customer_cell,
            it.get("channel", ""),
            it.get("direction", ""),
            _ts(it.get("occurred_at", "")),
            it.get("subject", ""),
            it.get("summary", ""),
            it.get("status", ""),
            bool(it.get("has_reply")),
            it.get("thread_id", ""),
            it.get("interaction_id", ""),
            it.get("customer_id", ""),
            it.get("opportunity_id", ""),
            it.get("exhibition_id", ""),
            it.get("raw_record_ref", ""),
            it.get("source_system", ""),
            it.get("source_record_id", ""),
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


def _write_rows(base_token: str, table_id: str, field_names: list, rows: list[list], tag: str = "followup") -> None:
    import os
    payload = {"fields": field_names, "rows": rows}
    tmp = os.path.join(os.getcwd(), f".{tag}_batch.json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    try:
        _lark(["+record-batch-create", "--base-token", base_token, "--table-id", table_id,
               "--json", f"@./.{tag}_batch.json"])
    finally:
        os.unlink(tmp)


def _ensure_table(base_token: str, name: str, fields: list) -> tuple[str, bool]:
    """确保表存在，返回 (table_id, created)。"""
    tid = _table_id(base_token, name)
    if tid:
        return tid, False
    d = _lark(["+table-create", "--base-token", base_token, "--name", name,
               "--fields", json.dumps(fields)])
    tid = d.get("data", {}).get("table", {}).get("id", "")
    if not tid:
        raise RuntimeError(f"table create failed: {name}")
    return tid, True


def sync_email_followup(company_id: str, base_token: str) -> dict:
    rows = _build_followup_rows(company_id)
    tid, created = _ensure_table(base_token, EMAIL_FOLLOWUP_TABLE, FOLLOWUP_FIELDS)
    _clear_table(base_token, tid)
    _write_rows(base_token, tid, FOLLOWUP_FIELD_NAMES, rows, tag="followup")
    return {"ok": True, "table_id": tid, "rows": len(rows), "created": created}


def sync_interactions(company_id: str, base_token: str, lead_table_id: str = "") -> dict:
    """同步「沟通明细」子表：一行一次互动，不含邮件全文。

    - 「客户关联」为 link 字段关联线索池主表 record（lead_table_id 传入时）；
    - 无 lead_table_id 时降级为 text 展示名。
    - 成功后把子表 table_id 写回 registry（interaction_table_id），供链接层改指。
    """
    if not lead_table_id:
        lead_table_id = _lead_table_id(company_id)
    lead_index = _lead_record_index(base_token, lead_table_id) if lead_table_id else {}
    rows = _build_interaction_rows(company_id, lead_table_id, lead_index)
    fields = _interaction_fields(lead_table_id)
    tid, created = _ensure_table(base_token, INTERACTION_TABLE, fields)
    _clear_table(base_token, tid)
    _write_rows(base_token, tid, _interaction_field_names(lead_table_id), rows, tag="interaction")
    _persist_interaction_table_id(company_id, tid)
    return {"ok": True, "table_id": tid, "rows": len(rows), "created": created,
            "linked_customers": sum(1 for r in rows if r[0])}


def sync_all(company_id: str, base_token: str) -> dict:
    out = {
        "email_followup": sync_email_followup(company_id, base_token),
        "interactions": sync_interactions(company_id, base_token),
    }
    try:
        out["funnel"] = _sync_funnel(company_id, base_token)
    except Exception as e:
        out["funnel"] = {"ok": False, "error": str(e)}
    out["ok"] = out["email_followup"].get("ok") and out["interactions"].get("ok") and out["funnel"].get("ok")
    return out


if __name__ == "__main__":
    if len(sys.argv) >= 4:
        cmd, company_id, base_token = sys.argv[1], sys.argv[2], sys.argv[3]
        if cmd == "sync-all":
            print(json.dumps(sync_all(company_id, base_token), ensure_ascii=False, indent=2))
        elif cmd == "sync-email-followup":
            print(json.dumps(sync_email_followup(company_id, base_token), ensure_ascii=False, indent=2))
        elif cmd == "sync-interactions":
            print(json.dumps(sync_interactions(company_id, base_token), ensure_ascii=False, indent=2))
        else:
            print(json.dumps({"error": f"unknown cmd {cmd}"}, ensure_ascii=False))
    else:
        print(json.dumps({"usage": "dc_feishu_standard.py sync-all <company_id> <base_token>"}, ensure_ascii=False))
