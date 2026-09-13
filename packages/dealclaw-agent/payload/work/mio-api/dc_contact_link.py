#!/usr/bin/env python3
"""dc_contact_link — 按收件人邮箱把「邮件事实」关联到「联系人 / 线索」。

为什么需要：买家回信要能**正确定位到人**。现在 outbound 事实里的 lead_id / contact_id
由调用方传，传空就空（本机样本就是空）→ 回信找不到买家。本模块做兜底解析：

数据源（都是现成的，不新增存储）：
  ① data/contacts/<company_id>/*.md   —— JSONL，含 lead_id / contact_id / name / email
  ② data/leads.json                   —— 线索池（含 _xq_email / _xq_contactName / domain）
匹配顺序：邮箱精确匹配（大小写不敏感）→ 命中 contacts 返回 lead_id/contact_id；
         再命中 leads 返回线索身份（company/domain），两者可叠加。

用法：
    python3 dc_contact_link.py --company-id <sid> --email a@b.com
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

DEFAULT_DATA_DIR = HERE.parent.parent / "data"


def _data_dir(data_dir=None) -> Path:
    return Path(data_dir) if data_dir else Path(os.environ.get("DC_DATA_DIR") or DEFAULT_DATA_DIR)


def _norm(email: str) -> str:
    return str(email or "").strip().lower()


def iter_contacts(company_id: str, data_dir=None) -> list[dict]:
    """读 contacts/<company>/*.md 里的 JSONL 行。"""
    base = _data_dir(data_dir) / "contacts" / company_id
    out: list[dict] = []
    if not base.exists():
        return out
    for f in sorted(base.glob("*.md")):
        for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def iter_leads(data_dir=None) -> list[dict]:
    p = _data_dir(data_dir) / "leads.json"
    if not p.exists():
        return []
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return d if isinstance(d, list) else (d.get("leads") or d.get("items") or [])


def link_by_email(company_id: str, recipients, *, data_dir=None) -> dict:
    """邮箱 → 联系人/线索。返回可空字段，匹配不到就返回空（不猜、不编）。"""
    emails = {_norm(e) for e in (recipients or []) if _norm(e)}
    result = {"lead_id": "", "contact_id": "", "contact_name": "", "role": "",
              "email": "", "lead_company": "", "lead_domain": "", "match": ""}
    if not emails:
        return result

    # ① contacts（带 lead_id / contact_id）
    for c in iter_contacts(company_id, data_dir):
        if _norm(c.get("email")) in emails:
            result.update({"lead_id": str(c.get("lead_id") or ""),
                           "contact_id": str(c.get("contact_id") or ""),
                           "contact_name": str(c.get("name") or ""),
                           "role": str(c.get("role") or ""),
                           "email": _norm(c.get("email")),
                           "match": "contacts"})
            break

    # ② 线索池（星擎导入的联系人邮箱写在 _xq_email）
    for l in iter_leads(data_dir):
        cand = [_norm(l.get("_xq_email")), _norm(l.get("email"))]
        if any(e and e in emails for e in cand):
            result.setdefault("contact_name", str(l.get("_xq_contactName") or ""))
            result.update({"lead_company": str(l.get("company_name") or ""),
                           "lead_domain": str(l.get("domain") or ""),
                           "match": (result["match"] + "+leads") if result["match"] else "leads"})
            if not result["contact_name"]:
                result["contact_name"] = str(l.get("_xq_contactName") or "")
            result["email"] = result["email"] or next((e for e in cand if e in emails), "")
            break
    # ③ 域名兜底：同一域名的来信归到同一买家主体（联系人数据不全时用）
    if not result["match"]:
        doms = {_norm(e).split("@")[-1] for e in emails if "@" in _norm(e)}
        for c in iter_contacts(company_id, data_dir):
            cdom = str(c.get("domain") or _norm(c.get("email")).split("@")[-1]).lower()
            if cdom and cdom in doms:
                result.update({"lead_id": str(c.get("lead_id") or ""),
                               "contact_id": str(c.get("contact_id") or ""),
                               "contact_name": str(c.get("name") or ""),
                               "email": _norm(c.get("email")),
                               "match": "domain-contacts"})
                break
        if not result["match"]:
            for l in iter_leads(data_dir):
                ldom = str(l.get("domain") or "").lower().strip()
                if ldom and ldom in doms:
                    result.update({"lead_company": str(l.get("company_name") or ""),
                                   "lead_domain": ldom,
                                   "contact_name": result["contact_name"] or str(l.get("_xq_contactName") or ""),
                                   "match": "domain-leads"})
                    break
    return result


def main(argv=None) -> int:  # pragma: no cover
    import argparse
    ap = argparse.ArgumentParser(description="按邮箱解析联系人/线索")
    ap.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--email", action="append", default=[])
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    r = link_by_email(args.company_id, args.email, data_dir=args.data_dir or None)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r["match"] else 3


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
