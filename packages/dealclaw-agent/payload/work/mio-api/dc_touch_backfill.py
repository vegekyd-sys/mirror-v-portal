#!/usr/bin/env python3
"""dc_touch_backfill.py — 触达回写：发送/回复记录 → 线索池「阶段」字段

数据源（发送/回复流水）：
  - email-facts/outbound/<company_id>/*.md （email_gateway 发送，含 recipients）
  - email-facts/inbound/<company_id>/*.md  （回复）
  - founder-direct/sent-log.jsonl          （Resend 直发脚本，含 to，无 company_id，按邮箱匹配）
  - dc_email_signals                       （回复信号）

匹配键：邮箱（线索池「联系人」字段里提取的邮箱）优先，域名兜底。
回写：有发送 → 阶段=已触达；有回复 → 阶段=已回复（覆盖已触达）。

只回写「待触达/已触达」→ 向上推进；不把「已回复/报价中/成交/停止触达」降级。

用法: python3 dc_touch_backfill.py <company_id> [--dry-run]
"""
import json
import re
import subprocess
import sys
from pathlib import Path

EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}")

DATA_DIR = Path(__file__).resolve().parent / "data"
SENT_LOG = Path(__file__).resolve().parents[2] / "scripts" / "founder-direct" / "sent-log.jsonl"

# 阶段推进顺序（数值越大越靠后）
STAGE_ORDER = {"待触达": 0, "已触达": 1, "已回复": 2, "报价中": 3, "成交": 4, "停止触达": -1}
REPLY_SIGNALS = {"quote_request", "sample_request", "meeting_interest", "missing_info", "reply"}


def _run_lark(*args, timeout=90):
    r = subprocess.run(["lark-cli"] + list(args), capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"lark-cli 失败: {r.stderr[:300]}")
    return json.loads(r.stdout)


def _emails_in_text(text: str) -> set:
    return {m.lower() for m in EMAIL_RE.findall(text or "")}


def _read_outbound(company_id: str) -> list:
    """email-facts outbound 发送记录。"""
    base = DATA_DIR / "email-facts" / "outbound" / company_id
    recs = []
    if base.exists():
        for f in base.rglob("*.md"):
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("record_type") == "outbound":
                    recs.append(d)
    return recs


def _read_inbound(company_id: str) -> list:
    base = DATA_DIR / "email-facts" / "inbound" / company_id
    recs = []
    if base.exists():
        for f in base.rglob("*.md"):
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("record_type") == "inbound":
                    recs.append(d)
    return recs


def _read_sent_log() -> list:
    recs = []
    if SENT_LOG.exists():
        for line in SENT_LOG.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return recs


def _read_signals(company_id: str) -> list:
    try:
        from dc_email_controller.dc_email_signals import list_signals
        return list_signals(company_id)
    except Exception:
        return []


def _lead_index(app_token: str, table_id: str) -> dict:
    """线索池 record_id → {emails, domains, stage}。"""
    resp = _run_lark("base", "+record-list", "--base-token", app_token,
                     "--table-id", table_id, "--limit", "200", "--format", "json", "--as", "bot")
    data = resp.get("data", {})
    fields = data.get("fields", [])
    rows = data.get("data", [])
    rids = data.get("record_id_list", [])
    idx = {}
    for rid, row in zip(rids, rows):
        rec = dict(zip(fields, row))
        contact = rec.get("联系人")
        contact = contact[0] if isinstance(contact, list) else contact
        emails = _emails_in_text(str(contact or ""))
        site = rec.get("官网") or ""
        site = site[0] if isinstance(site, list) else site
        domain = ""
        m = re.search(r"([\w-]+\.\w+)$", str(site or "").strip())
        if m:
            domain = m.group(1).lower()
        stage = rec.get("阶段") or "待触达"
        stage = stage[0] if isinstance(stage, list) else stage
        idx[rid] = {"emails": emails, "domain": domain, "stage": str(stage)}
    return idx


def backfill(company_id: str, dry_run: bool = False) -> dict:
    from dc_company_registry import CompanyRegistry
    entry = CompanyRegistry().get(company_id)
    if not entry:
        return {"status": "error", "error": "无该企业线索池"}
    app_token, table_id = entry["app_token"], entry["table_id"]

    index = _lead_index(app_token, table_id)

    # 收集发送邮箱（已触达）和回复邮箱（已回复）
    sent_emails, sent_domains = set(), set()
    reply_emails, reply_domains = set(), set()

    for o in _read_outbound(company_id):
        for e in (o.get("recipients") or []):
            e = str(e).strip().lower()
            if "@" in e:
                sent_emails.add(e); sent_domains.add(e.split("@")[-1])

    for r in _read_sent_log():
        to = str(r.get("to") or "").strip().lower()
        if "@" in to:
            sent_emails.add(to); sent_domains.add(to.split("@")[-1])

    for i in _read_inbound(company_id):
        sender = str(i.get("sender") or i.get("from") or "").strip().lower()
        if "@" in sender:
            reply_emails.add(sender); reply_domains.add(sender.split("@")[-1])

    for s in _read_signals(company_id):
        if s.get("signal_type") in REPLY_SIGNALS:
            e = str(s.get("contact_email") or s.get("buyer_email") or "").strip().lower()
            if "@" in e:
                reply_emails.add(e); reply_domains.add(e.split("@")[-1])

    # 回写
    updates = {}
    for rid, info in index.items():
        cur = info["stage"]
        if STAGE_ORDER.get(cur, 0) >= STAGE_ORDER["已回复"]:
            continue  # 已回复及以后，不降级
        target = None
        if reply_emails & info["emails"] or (reply_domains & {info["domain"]} if info["domain"] else False):
            target = "已回复"
        elif sent_emails & info["emails"] or (sent_domains & {info["domain"]} if info["domain"] else False):
            target = "已触达"
        if target and STAGE_ORDER[target] > STAGE_ORDER.get(cur, 0):
            updates[rid] = {"阶段": target}

    if dry_run:
        return {"status": "dry_run", "company_id": company_id, "would_update": len(updates)}

    if updates:
        _run_lark("base", "+record-batch-update", "--base-token", app_token,
                  "--table-id", table_id,
                  "--json", json.dumps({"update_records": updates}, ensure_ascii=False),
                  "--as", "bot")
    return {"status": "ok", "company_id": company_id, "updated": len(updates)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: dc_touch_backfill.py <company_id> [--dry-run]")
        sys.exit(1)
    cid = sys.argv[1]
    dry = "--dry-run" in sys.argv
    print(json.dumps(backfill(cid, dry), ensure_ascii=False, indent=2))
