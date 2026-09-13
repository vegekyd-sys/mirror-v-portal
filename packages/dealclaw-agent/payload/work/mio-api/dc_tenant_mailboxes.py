#!/usr/bin/env python3
"""dc_tenant_mailboxes — 租户绑定的邮箱范围（读取/调用的唯一口径）。

田耕郡 2026-09-13：**每个租户只读取和调用这个租户绑定的邮箱的往来内容，不是拉全量**。

口径：租户邮箱 = accounts 里 `enterprise_id == 本租户` 的 `email_address`（小写），
      同时并入 bindings 引用到的 account（binding.account_id → account.enterprise_id 匹配）。
归属判定：一封邮件的 from / to / cc / bcc 里**至少一个地址**是本租户邮箱 → 归本租户。

用途：
  · dc_resend_history 拉取时过滤（不拉别的租户的邮件）
  · dc_resend_attachments 附件拉取同理
  · dc_thread_dossier 案卷只并本租户邮件
  · 清理历史误写（见 quarantine_foreign_facts）

用法：
    python3 dc_tenant_mailboxes.py --company-id 100000834234
    python3 dc_tenant_mailboxes.py --company-id 100000834234 --quarantine   # 把非本租户事实移出
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


def _data_dir(data_dir=None) -> Path:
    return Path(data_dir) if data_dir else Path(os.environ.get("DC_DATA_DIR")
                                                or (HERE.parent.parent / "data"))


def _records(path: Path) -> list[dict]:
    t = path.read_text(encoding="utf-8", errors="ignore")
    out = []
    for line in t.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    if not out:
        m = re.search(r"\{.*\}", t, re.S)
        if m:
            try:
                out = [json.loads(m.group(0))]
            except json.JSONDecodeError:
                pass
    return out


def tenant_mailboxes(company_id: str, data_dir=None) -> set[str]:
    base = _data_dir(data_dir)
    accounts: dict[str, dict] = {}
    for p in glob.glob(str(base / "email-facts/accounts/*.md")):
        for r in _records(Path(p)):
            if r.get("account_id"):
                accounts[r["account_id"]] = r
    box: set[str] = set()
    for r in accounts.values():
        if str(r.get("enterprise_id") or "") == str(company_id):
            a = str(r.get("email_address") or "").strip().lower()
            if a:
                box.add(a)
    # bindings → account（企业号不匹配的账号也要排除）
    for p in glob.glob(str(base / "email-facts/bindings/*.md")):
        for b in _records(Path(p)):
            acc = accounts.get(str(b.get("account_id") or ""))
            if acc and str(acc.get("enterprise_id") or "") == str(company_id):
                a = str(acc.get("email_address") or "").strip().lower()
                if a:
                    box.add(a)
    return box


def rec_addresses(rec: dict) -> set[str]:
    out: set[str] = set()
    frm = rec.get("sender") or rec.get("from") or ""
    if isinstance(frm, dict):
        frm = frm.get("email") or frm.get("address") or ""
    if frm:
        out.add(str(frm).strip().lower())
    for key in ("recipients", "to", "cc", "bcc"):
        v = rec.get(key)
        if isinstance(v, str):
            v = [v]
        for a in (v or []):
            if isinstance(a, dict):
                a = a.get("email") or a.get("address") or ""
            if a:
                out.add(str(a).strip().lower())
    return {x for x in out if x}


def belongs_to_tenant(rec: dict, mailboxes: set[str]) -> bool:
    return bool(rec_addresses(rec) & {m.lower() for m in mailboxes})


def quarantine_foreign_facts(company_id: str, data_dir=None, apply: bool = False) -> dict:
    """把「写进了本租户目录、但收发地址都不是本租户邮箱」的事实移到 _quarantine。

    这些是我早期未按租户收口时写进去的（跨租户污染），必须移出。
    """
    base = _data_dir(data_dir)
    box = tenant_mailboxes(company_id, base)
    moved, kept = 0, 0
    moved_list = []
    for direction in ("outbound", "inbound"):
        for p in glob.glob(str(base / f"email-facts/{direction}/{company_id}/**/*.md"), recursive=True):
            path = Path(p)
            t = path.read_text(encoding="utf-8", errors="ignore")
            m = re.search(r"\{.*\}", t, re.S)
            if not m:
                continue
            try:
                rec = json.loads(m.group(0))
            except json.JSONDecodeError:
                continue
            if belongs_to_tenant(rec, box):
                kept += 1
                continue
            moved += 1
            moved_list.append(str(path))
            if apply:
                rel = path.relative_to(base / "email-facts")
                dest = base / "_quarantine" / "email-facts" / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                path.replace(dest)
    return {"company_id": company_id, "mailboxes": sorted(box), "kept": kept,
            "moved": moved, "moved_sample": moved_list[:5], "applied": apply}


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="租户绑定邮箱口径 + 跨租户事实隔离")
    ap.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--quarantine", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if args.quarantine:
        r = quarantine_foreign_facts(args.company_id, args.data_dir or None, apply=args.apply)
    else:
        r = {"company_id": args.company_id,
             "mailboxes": sorted(tenant_mailboxes(args.company_id, args.data_dir or None))}
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
