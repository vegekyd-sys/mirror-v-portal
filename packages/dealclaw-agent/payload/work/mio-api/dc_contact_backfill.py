#!/usr/bin/env python3
"""dc_contact_backfill — 从邮件事实层补「联系人」，让案卷能挂到买家身上。

问题：拉到的邮件两侧都在，但 `contacts/` 里没有这些邮箱 → 案卷只能用邮箱当标识，
      挂不到"客户档案"（lead_id/contact_id 为空）。

做法（幂等）：
  ① 扫事实层（出站 recipients / 入站 sender），排除我方域名；
  ② 已有 contacts 里出现过的邮箱跳过；
  ③ 新增联系人行：{lead_id:"", company_id, contact_id:"EM<sha1前16>", name, role:"",
     email, domain, source:"resend_pull", verified_at}
  ④ 同域已有联系人 → 复用其 lead_id（同域视为同一买家主体）

我方域名（默认，可用 --own-domain 追加）：dealclaw.io 及其子域、dogarm.top、meorient.com

用法：
    python3 dc_contact_backfill.py --company-id <sid> --apply
    python3 dc_contact_backfill.py --company-id <sid>          # 只报将新增多少
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

DEFAULT_OWN_DOMAINS = ("dealclaw.io", "dogarm.top", "meorient.com")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")


def _data_dir(data_dir=None) -> Path:
    return Path(data_dir) if data_dir else Path(os.environ.get("DC_DATA_DIR")
                                                or (HERE.parent.parent / "data"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _domain(email: str) -> str:
    return str(email).split("@")[-1].strip().lower()


def is_own(email: str, own_domains) -> bool:
    d = _domain(email)
    return any(d == o or d.endswith("." + o) for o in own_domains)


def guess_name(email: str) -> str:
    """从邮箱本地部分猜个名字（不编造真实姓名，只做可读化）。"""
    local = str(email).split("@")[0]
    return re.sub(r"[._-]+", " ", local).strip().title()[:40]


def scan_counterparties(data_dir=None, company_id: str = "", own_domains=DEFAULT_OWN_DOMAINS) -> dict:
    """返回 {email: {"domain":..., "seen": n, "last": iso}}（排除我方域名）。"""
    base = _data_dir(data_dir)
    found: dict[str, dict] = {}
    for direction in ("outbound", "inbound"):
        pat = str(base / f"email-facts/{direction}/{company_id}/**/*.md") if company_id \
            else str(base / f"email-facts/{direction}/**/*.md")
        for p in __import__("glob").glob(pat, recursive=True):
            t = Path(p).read_text(encoding="utf-8", errors="ignore")
            m = re.search(r"\{.*\}", t, re.S)
            if not m:
                continue
            try:
                rec = json.loads(m.group(0))
            except json.JSONDecodeError:
                continue
            addrs = [rec.get("sender") or ""] + list(rec.get("recipients") or [])
            for a in addrs:
                a = str(a).strip().lower()
                if not EMAIL_RE.fullmatch(a) or is_own(a, own_domains):
                    continue
                slot = found.setdefault(a, {"domain": _domain(a), "seen": 0,
                                            "last": str(rec.get("created_at") or "")})
                slot["seen"] += 1
                slot["last"] = max(slot["last"], str(rec.get("created_at") or ""))
    return found


def existing_emails(data_dir=None, company_id: str = "") -> set:
    from dc_contact_link import iter_contacts
    return {str(c.get("email") or "").strip().lower()
            for c in iter_contacts(company_id, data_dir) if c.get("email")}


def existing_lead_by_domain(data_dir=None) -> dict:
    """域名 → lead_id（contacts 里已知的），供同域复用。"""
    from dc_contact_link import iter_contacts
    out: dict[str, str] = {}
    base = _data_dir(data_dir)
    for d in (base / "contacts").glob("*"):
        for c in iter_contacts(d.name, data_dir):
            if c.get("domain") or c.get("email"):
                dom = str(c.get("domain") or _domain(c.get("email")))
                if c.get("lead_id"):
                    out.setdefault(dom, str(c["lead_id"]))
    return out


def backfill(*, company_id: str, data_dir=None, apply: bool = False,
             own_domains=DEFAULT_OWN_DOMAINS, limit: int = 500) -> dict:
    cps = scan_counterparties(data_dir, company_id, own_domains)
    have = existing_emails(data_dir, company_id)
    dom_lead = existing_lead_by_domain(data_dir)
    new_rows = []
    for email, info in sorted(cps.items(), key=lambda kv: -kv[1]["seen"]):
        if email in have:
            continue
        new_rows.append({
            "lead_id": dom_lead.get(info["domain"], ""),
            "company_id": company_id,
            "contact_id": "EM" + hashlib.sha1(email.encode()).hexdigest()[:16].upper(),
            "name": guess_name(email),
            "role": "",
            "email": email,
            "domain": info["domain"],
            "seen": info["seen"],
            "source": "resend_pull",
            "verified_at": _now(),
        })
        if len(new_rows) >= limit:
            break

    written = 0
    if apply and new_rows:
        base = _data_dir(data_dir) / "contacts" / company_id
        base.mkdir(parents=True, exist_ok=True)
        f = base / f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.md"
        if not f.exists():
            f.write_text("# DealClaw Contacts\n# DO NOT EDIT MANUALLY. One JSON object per line.\n",
                         encoding="utf-8")
        with f.open("a", encoding="utf-8") as fh:
            for r in new_rows:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
                written += 1
    return {"company_id": company_id, "scanned": len(cps), "already": len(have),
            "to_add": len(new_rows), "written": written, "applied": apply,
            "sample": new_rows[:5]}


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="从邮件事实补联系人")
    ap.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--own-domain", action="append", default=[])
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    own = tuple(DEFAULT_OWN_DOMAINS) + tuple(args.own_domain or ())
    r = backfill(company_id=args.company_id, data_dir=args.data_dir or None,
                 apply=args.apply, own_domains=own, limit=args.limit)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
