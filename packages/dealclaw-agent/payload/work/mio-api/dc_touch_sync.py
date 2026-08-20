#!/usr/bin/env python3
"""DC-Touch-Sync — send_log 发送/回复流水 → 触达记录子表 + 策略效果回填线索池

用法:
  python3 dc_touch_sync.py <enterprise> [--dry-run]
"""
import json, subprocess, sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
BASE_TOKEN = "QnHkbPllYaHun0s5hjMcp0ehnOf"
LEAD_TABLE = "tbluEPxc4wWe6PCG"
TOUCH_TABLE = "tblXlLZ0sjWvyxIl"

TYPE_MAP = {
    "sent": "发送", "delivered": "送达", "bounced": "退信",
    "opened": "打开", "clicked": "点击", "reply": "回复",
    "unsubscribed": "退订", "complained": "投诉",
}


def lark(*args):
    r = subprocess.run(["lark-cli"] + list(args), capture_output=True, text=True, timeout=90)
    return json.loads(r.stdout)


def read_outbound(company_id):
    """读 email-facts/outbound/<company_id> 的发送邮件记录。"""
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


def read_reply(company_id):
    """读 send_log.jsonl 的回复记录。"""
    recs = []
    path = DATA_DIR / "send_log.jsonl"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("enterprise") == company_id and d.get("type") == "reply":
                recs.append(d)
    return recs


def outbound_fields(rec):
    recipients = rec.get("recipients") or []
    email = recipients[0] if recipients else ""
    # 渠道推导：有 resend_id → GS（Resend 群发）；无 resend_id（SMTP 直发）→ FD
    channel = "GS" if rec.get("resend_id") else "FD"
    return {
        "类型": "发送",
        "时间": rec.get("sent_at", ""),
        "轮次": str(rec.get("touch_number", "") or ""),
        "渠道": channel,
        "结果": f"{rec.get('provider_status','')} {rec.get('subject','')}".strip()[:500],
        "_match_key": email.strip().lower(),
    }


def reply_fields(rec):
    return {
        "类型": "回复",
        "时间": rec.get("_ts", ""),
        "轮次": "",
        "渠道": rec.get("channel", "") or "",
        "结果": (rec.get("reply_text") or "")[:500],
        "_match_key": (rec.get("buyer_email") or rec.get("buyer_domain") or "").strip().lower(),
    }


def read_send_log(enterprise):
    path = DATA_DIR / "send_log.jsonl"
    recs = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("enterprise") == enterprise:
                recs.append(d)
    return recs


def lead_index():
    """线索池 → 建立 联系人/公司名/官网 → record_id 索引。"""
    fl = lark("base", "+field-list", "--base-token", BASE_TOKEN,
              "--table-id", LEAD_TABLE, "--as", "bot")
    id2name = {f["id"]: f["name"] for f in fl["data"]["fields"]}
    index, offset = {}, 0
    while True:
        d = lark("base", "+record-list", "--base-token", BASE_TOKEN,
                 "--table-id", LEAD_TABLE, "--offset", str(offset),
                 "--limit", "200", "--format", "json", "--as", "bot")
        data = d.get("data", {})
        rows = data.get("data") or []
        fids = data.get("field_id_list") or []
        rids = data.get("record_id_list") or []
        for i, row in enumerate(rows):
            rec = {id2name.get(fids[j], fids[j]): row[j] for j in range(min(len(fids), len(row)))}
            rid = rids[i] if i < len(rids) else ""
            for k in (str(rec.get("联系人") or "").strip().lower(),
                      str(rec.get("公司名") or "").strip().lower(),
                      str(rec.get("官网") or "").strip().lower()):
                if k and k not in index:
                    index[k] = rid
        if not data.get("has_more") or not rows:
            break
        offset += len(rows)
    return index


def touch_type(rec):
    t = rec.get("type", "")
    if t == "delivery":
        return TYPE_MAP.get(rec.get("status", ""), "发送")
    if t == "sent":
        return "发送"
    return TYPE_MAP.get(t, t)


def touch_result(rec):
    t = rec.get("type", "")
    if t == "reply":
        return (rec.get("reply_text") or "")[:500]
    if t == "delivery":
        return rec.get("detail", "") or rec.get("status", "")
    return rec.get("status", "") or ""


def link_target(rec, index):
    """按 buyer_email / buyer_domain / buyer_name 匹配线索池 record_id。"""
    email = str(rec.get("buyer_email") or "").strip().lower()
    domain = str(rec.get("buyer_domain") or "").strip().lower()
    name = str(rec.get("buyer_name") or "").strip().lower()
    for k in (email, domain, name):
        if k and k in index:
            return index[k]
    return ""


def backfill_strategy_effect(recs, index):
    """按线索聚合 send_log，回填「策略效果」到线索池。"""
    from collections import defaultdict
    stats = defaultdict(lambda: {"sent": False, "delivered": False, "bounced": False, "replied": False, "rounds": 0})
    for r in recs:
        rid = link_target(r, index)
        if not rid:
            continue
        s = stats[rid]
        t = r.get("type", "")
        if t == "sent":
            s["sent"] = True
            try:
                s["rounds"] = max(s["rounds"], int(r.get("round_num", 0) or 0))
            except (TypeError, ValueError):
                pass
        elif t == "delivery":
            if r.get("status") == "bounced":
                s["bounced"] = True
            else:
                s["delivered"] = True
        elif t == "reply":
            s["replied"] = True

    updates = {}
    for rid, s in stats.items():
        if s["replied"]:
            effect = f"触达{s['rounds']}轮 · 已回复" if s["rounds"] else "已回复"
        elif s["bounced"]:
            effect = "退信 · 暂停"
        elif s["delivered"]:
            effect = "已送达 · 未回复"
        elif s["sent"]:
            effect = f"已发送第{s['rounds']}轮 · 等待送达" if s["rounds"] else "已发送"
        else:
            continue
        updates[rid] = {"策略效果": effect}

    if updates:
        lark("base", "+record-batch-update", "--base-token", BASE_TOKEN,
             "--table-id", LEAD_TABLE,
             "--json", json.dumps({"update_records": updates}, ensure_ascii=False),
             "--as", "bot")
    return len(updates)


def main():
    enterprise = sys.argv[1] if len(sys.argv) > 1 else "testco"
    dry_run = "--dry-run" in sys.argv
    index = lead_index()

    # 沟通记录：发送（outbound）+ 回复（send_log reply）
    out_recs = read_outbound(enterprise)
    rep_recs = read_reply(enterprise)
    print(f"[outbound] {enterprise} 发送 {len(out_recs)} 封, 回复 {len(rep_recs)} 条")

    creates = []
    for r in out_recs:
        f = outbound_fields(r)
        key = f.pop("_match_key", "")
        rid = key if key in index else ""
        if rid:
            f["关联线索"] = [{"id": index[rid]}]
        creates.append(f)
    for r in rep_recs:
        f = reply_fields(r)
        key = f.pop("_match_key", "")
        rid = key if key in index else ""
        if rid:
            f["关联线索"] = [{"id": index[rid]}]
        creates.append(f)

    if not creates:
        print("无沟通记录可写")
        return 0

    if dry_run:
        print(f"[dry-run] 将写 {len(creates)} 条沟通记录，样例:")
        print(json.dumps(creates[0], ensure_ascii=False))
        return 0

    done = 0
    for i in range(0, len(creates), 200):
        batch = creates[i:i + 200]
        r = lark("base", "+record-batch-create", "--base-token", BASE_TOKEN,
                 "--table-id", TOUCH_TABLE,
                 "--json", json.dumps({"create_records": batch}, ensure_ascii=False),
                 "--as", "bot")
        created = r.get("data", {}).get("record_id_list") or []
        done += len(created)
    print(f"[done] 共写入 {done} 条沟通记录")
    return 0


if __name__ == "__main__":
    sys.exit(main())
