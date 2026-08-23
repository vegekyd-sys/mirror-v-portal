#!/usr/bin/env python3
"""DC-Memory-Data — 企业业务数据的 memory 权威层

线索、邮件、信号、草稿、战役的权威 json 存在 data/memory/<enterprise_id>/：
  - leads.json        （线索池，从飞书 Bitable 归集，字段 = 线索池字段）
  - leads_internal.json（内部线索 LeadStore，company_name/domain/country/company_cdp_id）
  - emails.json       （邮件收发完整 record，含 direction 标记）
  - signals.json      （信号完整 record）
  - drafts.json       （草稿完整 record）
  - campaign.json     （active campaign）
  - email_followup.json（邮件跟进状态表，agent 权威读取）
  - email_followup.csv （一买家一行的表格快照）
  - email_followup.md  （便于人工查看的表格快照）

agent 读这些 memory json 生成看板。飞书 Bitable / email-facts / signals / drafts
是「中间层」，本层是数据权威。

用法:
  python3 dc_memory_data.py sync-all <company_id>
  python3 dc_memory_data.py sync-leads <company_id>
  python3 dc_memory_data.py sync-emails <company_id>
  python3 dc_memory_data.py sync-signals <company_id>
  python3 dc_memory_data.py sync-drafts <company_id>
  python3 dc_memory_data.py sync-campaign <company_id>
  python3 dc_memory_data.py sync-email-followup <company_id>
"""

import csv
import json
import os
import sys
from pathlib import Path

MEMORY_DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "memory"


def resolve_supplier_id() -> str:
    """单租户 supplier id：动态从 MIO_CDP_SUPPLIER_ID 环境变量 / .env 读（不做硬编码占位）。"""
    sid = os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()
    if sid:
        return sid
    env_path = Path(__file__).resolve().parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("MIO_CDP_SUPPLIER_ID="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def _enterprise_dir(company_id: str) -> Path:
    company_id = resolve_supplier_id() or (company_id or "").strip()
    d = MEMORY_DATA_DIR / company_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_json(company_id: str, name: str, data) -> Path:
    path = _enterprise_dir(company_id) / name
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _fmt(v):
    if isinstance(v, list):
        return "、".join(str(x).strip() for x in v if str(x).strip())
    return str(v or "").strip()


# ── 读取接口（权威数据）──────────────────────────────────
def read_leads(company_id: str) -> list:
    return _read_json(company_id, "leads.json", [])


def read_leads_internal(company_id: str) -> list:
    return _read_json(company_id, "leads_internal.json", [])


def read_emails(company_id: str) -> list:
    return _read_json(company_id, "emails.json", [])


def read_signals(company_id: str) -> list:
    return _read_json(company_id, "signals.json", [])


def read_drafts(company_id: str) -> list:
    return _read_json(company_id, "drafts.json", [])


def read_campaign(company_id: str):
    return _read_json(company_id, "campaign.json", None)


def _read_json(company_id: str, name: str, default):
    path = _enterprise_dir(company_id) / name
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


# ── 线索池（飞书 Bitable）────────────────────────────────
def sync_leads_to_memory(company_id: str) -> dict:
    """从飞书 Bitable 归集线索到 memory 的 leads.json（权威数据）。"""
    from dc_company_registry import CompanyRegistry, _run_lark, parse_record_list
    entry = CompanyRegistry().get(company_id)
    if not entry:
        return {"status": "error", "error": "无线索池（未建 Base）"}

    try:
        result = _run_lark(
            "base", "+record-list",
            "--base-token", entry["app_token"],
            "--table-id", entry["table_id"],
            "--limit", "200",
            "--format", "json",
            "--as", "bot",
        )
        records = parse_record_list(result)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    leads = []
    for r in records:
        f = r.get("fields", {}) or {}
        leads.append({
            "company": _fmt(f.get("公司名")) or "",
            "website": _fmt(f.get("官网")) or "",
            "contact": _fmt(f.get("联系人")) or "",
            "country": _fmt(f.get("国家")) or "",
            "buyer_type": _fmt(f.get("买家类型")) or "",
            "stage": _fmt(f.get("阶段")) or "待触达",
            "match_product": _fmt(f.get("匹配产品")) or "",
            "source": _fmt(f.get("来源")) or "",
            "hot_cold": _fmt(f.get("冷热")) or "❄️冷",
            "recommend": _fmt(f.get("推荐理由")) or "",
        })

    path = _write_json(company_id, "leads.json", leads)
    return {"status": "ok", "count": len(leads), "path": str(path)}


def sync_leads_internal_to_memory(company_id: str) -> dict:
    """从 LeadStore 归集内部线索到 leads_internal.json（买家状态看板域名→公司名映射用）。"""
    try:
        from dc_ls_store import LeadStore
        ls = LeadStore()
        leads = [l for l in getattr(ls, "_leads", [])
                 if (l.get("enterprise") or "") in (company_id, "", "testco")]
    except Exception as e:
        return {"status": "error", "error": str(e)}
    path = _write_json(company_id, "leads_internal.json", leads)
    return {"status": "ok", "count": len(leads), "path": str(path)}


def _feishu_to_board(f: dict) -> dict:
    """飞书线索池字段 → 看板字段（与 sync_leads_to_memory 读飞书时一致）。"""
    return {
        "company": _fmt(f.get("公司名")) or "",
        "website": _fmt(f.get("官网")) or "",
        "contact": _fmt(f.get("联系人")) or "",
        "country": _fmt(f.get("国家")) or "",
        "buyer_type": _fmt(f.get("买家类型")) or "",
        "stage": _fmt(f.get("阶段")) or "待触达",
        "match_product": _fmt(f.get("匹配产品")) or "",
        "source": _fmt(f.get("来源")) or "",
        "hot_cold": _fmt(f.get("冷热")) or "❄️冷",
        "recommend": _fmt(f.get("推荐理由")) or "",
    }


def write_leads_to_memory(company_id: str, feishu_fields: list) -> dict:
    """写入方直写 memory leads.json（权威数据，幂等 upsert）。

    feishu_fields: 飞书线索池字段格式的 dict 列表（公司名/官网/国家/买家类型/
    匹配产品/来源/冷热/阶段/推荐理由）。内部映射为看板字段后合并写 memory。
    """
    new_leads = [_feishu_to_board(f) for f in (feishu_fields or [])]
    existing = read_leads(company_id)
    index: dict = {}
    for l in existing + new_leads:
        key = ((l.get("company") or "").strip().lower(),
               (l.get("website") or "").strip().lower())
        if key == ("", ""):
            continue
        index[key] = l
    merged = list(index.values())
    path = _write_json(company_id, "leads.json", merged)
    return {"status": "ok", "count": len(merged), "added": len(new_leads), "path": str(path)}


# ── 邮件（email-facts 完整 record）────────────────────────
def sync_emails_to_memory(company_id: str) -> dict:
    """从 email-facts 归集邮件完整 record 到 emails.json（权威数据）。"""
    from email_gateway.store import EmailStore
    store = EmailStore()
    outbounds = store.list_outbound_records(company_id=company_id)
    inbounds = store.list_inbound_records(company_id=company_id)

    emails = []
    for o in outbounds:
        emails.append({**o, "direction": "out"})
    for i in inbounds:
        emails.append({**i, "direction": "in"})

    path = _write_json(company_id, "emails.json", emails)
    return {"status": "ok", "count": len(emails), "out": len(outbounds),
            "in": len(inbounds), "path": str(path)}


# ── 信号 ─────────────────────────────────────────────────
def sync_signals_to_memory(company_id: str) -> dict:
    """从 dc_email_signals 归集信号完整 record 到 signals.json。"""
    from dc_email_controller.dc_email_signals import list_signals
    try:
        signals = list_signals(company_id)
    except Exception as e:
        return {"status": "error", "error": str(e)}
    path = _write_json(company_id, "signals.json", signals)
    return {"status": "ok", "count": len(signals), "path": str(path)}


# ── 草稿 ─────────────────────────────────────────────────
def sync_drafts_to_memory(company_id: str) -> dict:
    """从 dc_reply_draft 归集草稿完整 record 到 drafts.json。"""
    from dc_email_controller.dc_reply_draft import list_drafts
    try:
        drafts = list_drafts(company_id=company_id)
    except Exception as e:
        return {"status": "error", "error": str(e)}
    path = _write_json(company_id, "drafts.json", drafts)
    return {"status": "ok", "count": len(drafts), "path": str(path)}


# ── 战役 ─────────────────────────────────────────────────
def sync_campaign_to_memory(company_id: str) -> dict:
    """从 dc_campaign 归集 active campaign 到 campaign.json。"""
    from dc_campaign import get_active_campaign
    try:
        camp = get_active_campaign(company_id)
    except Exception as e:
        return {"status": "error", "error": str(e)}
    path = _write_json(company_id, "campaign.json", camp)
    return {"status": "ok", "found": camp is not None, "path": str(path)}


# ── 物料（知识库物料索引 → data/memory 双写）─────────────────
def read_materials(company_id: str) -> dict:
    """读 data/memory 的 materials.json（物料权威镜像）。"""
    return _read_json(company_id, "materials.json", {})


def sync_materials_to_memory(company_id: str) -> dict:
    """从知识库物料索引（kb.json materials）归集到 data/memory/materials.json。

    物料双写：canonical 在知识库索引（kb.json materials，dc_kb_engine 写），
    data/memory/materials.json 是权威镜像（agent 读卡片/发营销内容时用）。
    """
    from dc_kb_engine import KBEngine
    kb = KBEngine()._load(company_id)
    mats = (kb or {}).get("materials", {})
    path = _write_json(company_id, "materials.json", mats)
    return {"status": "ok", "count": len(mats), "path": str(path)}


# ── 邮件跟进状态表 ───────────────────────────────────────
def _extract_emails(text: str) -> set:
    import re
    if isinstance(text, list):
        text = " ".join(str(x) for x in text)
    return {m.lower() for m in re.findall(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}", str(text or ""))}


def _normalize_addresses(value) -> list[str]:
    """把邮件地址字段统一成小写列表，兼容 str/list 和带姓名的地址。"""
    if isinstance(value, list):
        raw = value
    else:
        raw = [value]
    out = []
    for item in raw:
        out.extend(sorted(_extract_emails(str(item or ""))))
    return list(dict.fromkeys(out))


def _contact_names(contact: str) -> list[str]:
    """从线索池联系人文本中提取姓名，不把邮箱/电话误当姓名。"""
    names = []
    for line in str(contact or "").splitlines():
        name = line.split("|", 1)[0].strip()
        if not name or name.lower() == "unknown" or "@" in name:
            continue
        if name not in names:
            names.append(name)
    return names


def _read_sent_log() -> list:
    """读 founder-direct/sent-log.jsonl（Resend 直发脚本的发送记录，无 company_id）。"""
    path = Path(__file__).resolve().parents[2] / "scripts" / "founder-direct" / "sent-log.jsonl"
    recs = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return recs


def read_email_followup(company_id: str) -> list:
    """读 memory 的 email_followup.json（邮件跟进状态表，权威数据）。"""
    return _read_json(company_id, "email_followup.json", [])


def _load_resend_api_key() -> str:
    key = os.environ.get("RESEND_API_KEY", "").strip()
    if key:
        return key
    env_path = Path(__file__).resolve().parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("RESEND_API_KEY="):
                return line.split("=", 1)[1].strip()
    return ""


def _hydrate_resend_content(company_id: str, lead_emails: set[str], sent_records: list[dict]) -> dict:
    """为旧 sent-log 补正文，并拉取与本企业线索邮箱匹配的买家回信。

    sent-log 旧记录没有正文和 company_id；这里只对当前企业线索池中已存在的邮箱
    做精确匹配，避免跨企业串数据。外部内容落到企业自己的 memory cache，后续离线可读。
    """
    cache = _read_json(company_id, "email_content_cache.json", {"outbound": {}, "inbound": {}})
    cache.setdefault("outbound", {})
    cache.setdefault("inbound", {})
    key = _load_resend_api_key()
    if not key or not lead_emails:
        return cache

    try:
        import requests
    except ImportError:
        return cache

    headers = {"Authorization": f"Bearer {key}"}
    changed = False

    # 旧发送日志：只补当前企业线索邮箱对应的邮件。
    for rec in sent_records:
        record_company = str(rec.get("company_id") or "").strip()
        if record_company and record_company != company_id:
            continue
        recipients = _normalize_addresses(rec.get("to"))
        if not set(recipients) & lead_emails:
            continue
        rid = str(rec.get("resend_id") or rec.get("messageId") or "").strip()
        if not rid or rid == "?" or rid in cache["outbound"]:
            continue
        try:
            resp = requests.get(f"https://api.resend.com/emails/{rid}", headers=headers, timeout=20)
            if not resp.ok:
                continue
            data = resp.json()
            cache["outbound"][rid] = {
                "from": data.get("from", ""),
                "to": data.get("to", []),
                "subject": data.get("subject", ""),
                "text": data.get("text", ""),
                "html": data.get("html", ""),
                "created_at": data.get("created_at", ""),
                "status": data.get("last_event", ""),
            }
            changed = True
        except Exception:
            continue

    # 买家回信：先列出最近收到的邮件，再按发件邮箱精确筛选并拉完整正文。
    try:
        resp = requests.get(
            "https://api.resend.com/emails/receiving",
            headers=headers,
            params={"limit": 100},
            timeout=20,
        )
        received = (resp.json() or {}).get("data", []) if resp.ok else []
    except Exception:
        received = []

    for item in received:
        senders = _normalize_addresses(item.get("from"))
        if not set(senders) & lead_emails:
            continue
        rid = str(item.get("id") or "").strip()
        if not rid or rid in cache["inbound"]:
            continue
        try:
            resp = requests.get(
                f"https://api.resend.com/emails/receiving/{rid}",
                headers=headers,
                timeout=20,
            )
            if not resp.ok:
                continue
            data = resp.json()
            cache["inbound"][rid] = {
                "from": data.get("from", ""),
                "to": data.get("to", []),
                "subject": data.get("subject", ""),
                "text": data.get("text", ""),
                "html": data.get("html", ""),
                "created_at": data.get("created_at", ""),
            }
            changed = True
        except Exception:
            continue

    if changed:
        _write_json(company_id, "email_content_cache.json", cache)
    return cache


def _write_email_followup_tables(company_id: str, rows: list[dict]) -> tuple[Path, Path]:
    """写 CSV + Markdown，一买家一行，邮件完整内容集中在最后一列。"""
    base = _enterprise_dir(company_id)
    csv_path = base / "email_followup.csv"
    md_path = base / "email_followup.md"
    fields = [
        "公司名", "官网", "国家", "买家类型", "联系人名", "联系人信息",
        "跟进状态", "已发邮件数", "买家回复数", "已跟进轮次", "最近联系时间", "邮件全部内容",
    ]

    def timeline(row: dict) -> str:
        blocks = []
        for mail in row.get("emails", []):
            direction = "发出" if mail.get("direction") == "out" else "收到"
            round_no = mail.get("round")
            round_text = "首次触达" if direction == "发出" and round_no == 0 else (
                f"第{round_no}次跟进" if direction == "发出" and round_no is not None else "买家回复"
            )
            body = mail.get("content") or "[历史记录未保存正文]"
            blocks.append(
                f"【{round_text}｜{direction}｜{mail.get('sent_at', '')}】\n"
                f"主题：{mail.get('subject', '')}\n正文：{body}"
            )
        return "\n\n".join(blocks)

    csv_rows = []
    for row in rows:
        csv_rows.append({
            "公司名": row.get("company", ""),
            "官网": row.get("website", ""),
            "国家": row.get("country", ""),
            "买家类型": row.get("buyer_type", ""),
            "联系人名": "、".join(row.get("contact_names", [])),
            "联系人信息": row.get("contact", ""),
            "跟进状态": row.get("stage", ""),
            "已发邮件数": row.get("outbound_count", 0),
            "买家回复数": row.get("inbound_count", 0),
            "已跟进轮次": row.get("touch_number", 0),
            "最近联系时间": row.get("latest_at", ""),
            "邮件全部内容": timeline(row),
        })

    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(csv_rows)

    def md_cell(value) -> str:
        return str(value or "").replace("|", "\\|").replace("\r", "").replace("\n", "<br>")

    lines = [
        f"# 邮件跟进状态表 · {company_id}",
        "",
        "| " + " | ".join(fields) + " |",
        "|" + "|".join(["---"] * len(fields)) + "|",
    ]
    for row in csv_rows:
        lines.append("| " + " | ".join(md_cell(row[f]) for f in fields) + " |")
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return csv_path, md_path


def sync_email_followup_to_memory(company_id: str) -> dict:
    """聚合线索池 + 邮件记录 → email_followup.json（邮件跟进状态表，权威数据）。

    每行一个买家：公司信息（company/website/country/buyer_type/contact）+
    跟进状态（stage/touch_number）+ 邮件全部内容（emails 数组，每封含
    round/subject/content/sent_at/status）。

    邮件数据源：email-facts outbound（有完整正文）+ founder-direct sent-log（只有主题）。
    """
    from email_gateway.store import EmailStore
    leads = read_leads(company_id)

    # 线索池邮箱 → 线索（用于关联）
    lead_by_email = {}
    for l in leads:
        for e in _extract_emails(l.get("contact", "")):
            lead_by_email.setdefault(e, l)

    sent_records = _read_sent_log()
    resend_cache = _hydrate_resend_content(company_id, set(lead_by_email), sent_records)

    # 聚合邮件：email-facts outbound + sent-log
    emails_by_key = {}  # 邮箱 -> [邮件 record]

    try:
        store = EmailStore()
        outbounds = store.list_outbound_records(company_id=company_id)
    except Exception:
        outbounds = []
    for o in outbounds:
        for r in (o.get("recipients") or []):
            e = str(r).strip().lower()
            if "@" not in e:
                continue
            emails_by_key.setdefault(e, []).append({
                "round": o.get("touch_number", 0),
                "direction": "out",
                "subject": o.get("subject", ""),
                "content": (o.get("text") or o.get("subject") or "").strip(),
                "sent_at": o.get("sent_at", "") or o.get("created_at", ""),
                "status": o.get("provider_status", "") or o.get("status", ""),
            })

    for s in sent_records:
        record_company = str(s.get("company_id") or "").strip()
        if record_company and record_company != company_id:
            continue
        recipients = _normalize_addresses(s.get("to"))
        matched = set(recipients) & set(lead_by_email)
        if not matched:
            continue
        rid = str(s.get("resend_id") or s.get("messageId") or "").strip()
        hydrated = resend_cache.get("outbound", {}).get(rid, {})
        for to in matched:
            emails_by_key.setdefault(to, []).append({
                "round": None,
                "direction": "out",
                "subject": hydrated.get("subject") or s.get("subject", ""),
                "content": (hydrated.get("text") or s.get("text") or s.get("body") or "").strip(),
                "sent_at": hydrated.get("created_at") or s.get("sent_at") or s.get("ts", ""),
                "status": hydrated.get("status") or s.get("status", ""),
            })

    for inbound in resend_cache.get("inbound", {}).values():
        for sender in set(_normalize_addresses(inbound.get("from"))) & set(lead_by_email):
            emails_by_key.setdefault(sender, []).append({
                "round": None,
                "direction": "in",
                "subject": inbound.get("subject", ""),
                "content": (inbound.get("text") or inbound.get("html") or "").strip(),
                "sent_at": inbound.get("created_at", ""),
                "status": "received",
            })

    def _dedup_sort(recs):
        seen, out = set(), []
        for r in sorted(recs, key=lambda x: str(x.get("sent_at") or "")):
            k = (r.get("subject"), str(r.get("sent_at") or ""))
            if k in seen:
                continue
            seen.add(k)
            out.append(r)
        return out

    # 生成每行（以线索池买家为主，关联邮件）
    followup = []
    for l in leads:
        recs = []
        for e in _extract_emails(l.get("contact", "")):
            if e in emails_by_key:
                recs.extend(emails_by_key[e])
        recs = _dedup_sort(recs)
        next_round = 0
        for rec in recs:
            if rec.get("direction") != "out":
                continue
            if rec.get("round") is None:
                rec["round"] = next_round
            next_round = max(next_round, int(rec.get("round") or 0) + 1)
        rounds = [r["round"] for r in recs if r.get("round") is not None]
        outbound_count = sum(1 for r in recs if r.get("direction") == "out")
        inbound_count = sum(1 for r in recs if r.get("direction") == "in")
        followup.append({
            "company": l.get("company", ""),
            "website": l.get("website", ""),
            "country": l.get("country", ""),
            "buyer_type": l.get("buyer_type", ""),
            "contact": l.get("contact", ""),
            "contact_names": _contact_names(l.get("contact", "")),
            "stage": l.get("stage", ""),
            "touch_number": max(rounds) if rounds else 0,
            "outbound_count": outbound_count,
            "inbound_count": inbound_count,
            "latest_at": max((str(r.get("sent_at") or "") for r in recs), default=""),
            "emails": recs,
        })

    path = _write_json(company_id, "email_followup.json", followup)
    csv_path, md_path = _write_email_followup_tables(company_id, followup)
    return {
        "status": "ok",
        "count": len(followup),
        "path": str(path),
        "csv_path": str(csv_path),
        "md_path": str(md_path),
    }


def sync_all(company_id: str) -> dict:
    out = {}
    for name, fn in [
        ("leads", sync_leads_to_memory),
        ("leads_internal", sync_leads_internal_to_memory),
        ("emails", sync_emails_to_memory),
        ("signals", sync_signals_to_memory),
        ("drafts", sync_drafts_to_memory),
        ("campaign", sync_campaign_to_memory),
        ("materials", sync_materials_to_memory),
        ("email_followup", sync_email_followup_to_memory),
    ]:
        try:
            out[name] = fn(company_id)
        except Exception as e:
            out[name] = {"status": "error", "error": str(e)}
    return out


if __name__ == "__main__":
    cmds = {
        "sync-all": sync_all,
        "sync-leads": sync_leads_to_memory,
        "sync-emails": sync_emails_to_memory,
        "sync-signals": sync_signals_to_memory,
        "sync-drafts": sync_drafts_to_memory,
        "sync-campaign": sync_campaign_to_memory,
        "sync-materials": sync_materials_to_memory,
        "sync-leads-internal": sync_leads_internal_to_memory,
        "sync-email-followup": sync_email_followup_to_memory,
    }
    if len(sys.argv) >= 3 and sys.argv[1] in cmds:
        print(json.dumps(cmds[sys.argv[1]](sys.argv[2]), ensure_ascii=False, indent=2))
    else:
        print("用法: dc_memory_data.py sync-all|sync-leads|sync-emails|sync-signals|sync-drafts|sync-campaign|sync-leads-internal <company_id>")
