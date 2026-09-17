#!/usr/bin/env python3
"""dc_tenant_mailboxes — 租户绑定的邮箱范围（读取/调用的唯一口径）。

田耕郡 2026-09-13：**每个租户只读取和调用这个租户绑定的邮箱的往来内容，不是拉全量**。

口径：租户邮箱 = 以下三个来源的并集（地址一律小写、只取 ``local@domain``）：
      ① accounts 里 ``enterprise_id`` 属于本租户的 ``email_address``；
      ② bindings 引用到的 account（binding.account_id → account.enterprise_id 匹配）；
      ③ 命名库 ``email-facts/naming/addresses.sqlite3`` 里本租户的 ``full_address``
         （默认邮箱是 provisioning 占位分配的，可能还没落 accounts —— 少了这一路
         就会出现「明明有邮箱却查不到」，进而触发下面说的 fail-closed）。
归属判定：一封邮件的 from / to / cc / bcc 里**至少一个地址**是本租户邮箱 → 归本租户。

**fail-closed（2026-09-17）**：Resend 是全平台共用的一个账号（dealclaw.io 各子域名都在
里面），拉列表拿到的是**所有租户**的信。所以「查不到本租户邮箱」只能当成**不知道归属**，
必须拒绝拉取/展示，绝不能当成「不过滤」放行全量——那正是早报串租户的成因。调用方用
``require_tenant_mailboxes()``，查不到直接抛 :class:`TenantScopeUnknown`。

用途：
  · dc_resend_history 拉取时过滤（不拉别的租户的邮件）
  · dc_resend_attachments 附件拉取同理
  · dc_thread_dossier 案卷只并本租户邮件
  · 早晚报「回信采购意图」只展示本租户邮箱的往来
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
import sqlite3
import sys
from email.utils import getaddresses
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


class TenantScopeUnknown(RuntimeError):
    """查不到本租户绑定邮箱 —— 无法判定归属。

    调用方必须据此**拒绝**拉取/展示（fail-closed），不得退化成「不过滤」：
    共用 Resend 账号下「不过滤」= 把别的租户的邮件写进/显示成本租户的。
    """

    def __init__(self, company_id: str, base: Path | str = ""):
        self.company_id = str(company_id or "")
        self.base = str(base or "")
        super().__init__(
            f"查不到租户 {self.company_id!r} 的绑定邮箱（data_dir={self.base!r}）："
            "无法判定邮件归属，已拒绝操作。请先绑定/补齐本租户邮箱（email_gateway account-add 或默认邮箱 provisioning）。")


def _data_dir(data_dir=None) -> Path:
    """数据根。**必须与 EmailStore / 命名库同一口径**（<mio-api>/data），

    否则 DC_DATA_DIR 没设时会去一个不存在的目录找 accounts，查不到邮箱。
    """
    if data_dir:
        return Path(data_dir)
    return Path(os.environ.get("DC_DATA_DIR") or (HERE / "data"))


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


def _addr(value) -> str:
    """``"Name <a@b>"`` / ``{"email": "a@b"}`` / ``" A@B "`` → ``a@b``（小写）。

    Resend 的 from/to 常带显示名；不剥出地址就会和 accounts 里的裸地址比不上，
    导致「本租户自己的信反而被过滤掉」。
    """
    if isinstance(value, dict):
        value = value.get("email") or value.get("address") or ""
    text = str(value or "").strip()
    if not text:
        return ""
    parsed = [a for _, a in getaddresses([text]) if a]
    addr = parsed[0] if parsed else text
    return addr.strip().strip("<>").strip().lower()


def _addrs(value) -> set[str]:
    """一个字段里的全部地址（字符串 / 列表 / 逗号分隔 / 带显示名都吃）。"""
    if value is None:
        return set()
    if isinstance(value, (str, dict)):
        value = [value]
    out: set[str] = set()
    for item in value:
        if isinstance(item, dict):
            a = _addr(item)
            if a:
                out.add(a)
            continue
        for _, a in getaddresses([str(item or "")]):
            a = a.strip().strip("<>").strip().lower()
            if a:
                out.add(a)
    return out


def _same_tenant(record_value, company_id: str) -> bool:
    """记录上的 enterprise_id 是否就是本租户。

    先原样比；再走 canonical（``enterprise_ids`` 的单租户归一：历史 slug → 当前
    supplier_id）。数字型的别家 id（如 999999999999）canonical 后仍是自己，不会误判。
    """
    x = str(record_value or "").strip()
    y = str(company_id or "").strip()
    if not x or not y:
        return False
    if x == y:
        return True
    try:
        from enterprise_ids import canonical_company_id
    except ImportError:
        return False
    try:
        cx, cy = canonical_company_id(x), canonical_company_id(y)
    except Exception:  # noqa: BLE001 - 归一失败一律按「不是本租户」
        return False
    return bool(cx) and cx == cy


def _naming_mailboxes(base: Path, company_id: str) -> set[str]:
    """命名库（provisioning 占位分配的默认邮箱）里本租户的地址。只读、不建库。"""
    db = base / "email-facts" / "naming" / "addresses.sqlite3"
    if not db.exists():
        return set()
    out: set[str] = set()
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return set()
    try:
        rows = conn.execute("SELECT enterprise_id, full_address FROM mailbox_address").fetchall()
    except sqlite3.Error:
        return set()
    finally:
        conn.close()
    for ent, full in rows:
        if _same_tenant(ent, company_id):
            a = _addr(full)
            if a:
                out.add(a)
    return out


def tenant_mailboxes(company_id: str, data_dir=None) -> set[str]:
    """本租户绑定邮箱集合（可能为空 —— 空 = 口径未知，调用方必须 fail-closed）。"""
    base = _data_dir(data_dir)
    accounts: dict[str, dict] = {}
    for p in glob.glob(str(base / "email-facts/accounts/*.md")):
        for r in _records(Path(p)):
            if r.get("account_id"):
                accounts[r["account_id"]] = r
    box: set[str] = set()
    for r in accounts.values():
        if _same_tenant(r.get("enterprise_id"), company_id):
            a = _addr(r.get("email_address"))
            if a:
                box.add(a)
    # bindings → account（企业号不匹配的账号也要排除）
    for p in glob.glob(str(base / "email-facts/bindings/*.md")):
        for b in _records(Path(p)):
            acc = accounts.get(str(b.get("account_id") or ""))
            if acc and _same_tenant(acc.get("enterprise_id"), company_id):
                a = _addr(acc.get("email_address"))
                if a:
                    box.add(a)
    box |= _naming_mailboxes(base, company_id)
    return box


def require_tenant_mailboxes(company_id: str, data_dir=None) -> set[str]:
    """拿本租户邮箱；**查不到就抛** :class:`TenantScopeUnknown`（不许退化成不过滤）。"""
    base = _data_dir(data_dir)
    if not str(company_id or "").strip():
        raise TenantScopeUnknown(company_id, base)
    box = tenant_mailboxes(company_id, base)
    if not box:
        raise TenantScopeUnknown(company_id, base)
    return box


def rec_addresses(rec: dict) -> set[str]:
    """一条记录（事实层记录 / Resend 列表条目 / 详情）上出现的全部邮箱地址。"""
    out: set[str] = set()
    for key in ("sender", "from", "recipients", "to", "cc", "bcc", "reply_to"):
        out |= _addrs(rec.get(key))
    return {x for x in out if x}


def belongs_to_tenant(rec: dict, mailboxes: set[str]) -> bool:
    """收发地址里至少有一个是本租户邮箱。``mailboxes`` 为空一律 False（fail-closed）。"""
    if not mailboxes:
        return False
    return bool(rec_addresses(rec) & {str(m).strip().lower() for m in mailboxes})


def filter_tenant_records(records, mailboxes: set[str]) -> tuple[list[dict], list[dict]]:
    """按租户邮箱切分：``(本租户的, 非本租户的)``。调用方通常要把后者的条数报出来。"""
    kept, foreign = [], []
    for rec in records or []:
        (kept if belongs_to_tenant(rec, mailboxes) else foreign).append(rec)
    return kept, foreign


def all_tenant_mailboxes(data_dir=None) -> dict:
    """{租户: {邮箱...}} —— 由 accounts 的 enterprise_id 汇总（运维/归位用）。"""
    base = _data_dir(data_dir)
    out: dict[str, set] = {}
    for p in glob.glob(str(base / "email-facts/accounts/*.md")):
        for r in _records(Path(p)):
            cid = str(r.get("enterprise_id") or "").strip()
            addr = _addr(r.get("email_address"))
            if cid and addr:
                out.setdefault(cid, set()).add(addr)
    db = base / "email-facts" / "naming" / "addresses.sqlite3"
    if db.exists():
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
            try:
                rows = conn.execute(
                    "SELECT enterprise_id, full_address FROM mailbox_address").fetchall()
            finally:
                conn.close()
            for ent, full in rows:
                cid, addr = str(ent or "").strip(), _addr(full)
                if cid and addr:
                    out.setdefault(cid, set()).add(addr)
        except sqlite3.Error:
            pass
    return out


def owner_tenant(rec: dict, tenant_boxes: dict) -> tuple[str, int]:
    """按收发地址命中的租户邮箱数量判定归属；命中为 0 返回空。"""
    addrs = rec_addresses(rec)
    best, best_hits = "", 0
    for cid, boxes in tenant_boxes.items():
        hits = len(addrs & {str(b).strip().lower() for b in boxes})
        if hits > best_hits:
            best, best_hits = cid, hits
    return best, best_hits


def rehome_quarantine(data_dir=None, apply: bool = False, keep_unassigned: bool = True) -> dict:
    """把隔离区里的事实按正确租户归位（田耕郡 2026-09-13 确认）。"""
    base = _data_dir(data_dir)
    qroot = base / "_quarantine"
    tenant_boxes = all_tenant_mailboxes(base)
    report = {"tenants": {k: sorted(v) for k, v in tenant_boxes.items()},
              "moved": 0, "unassigned": 0, "by_tenant": {}, "applied": apply}
    if not qroot.exists():
        return {**report, "note": "没有隔离区"}

    facts = glob.glob(str(qroot / "email-facts/**/*.md"), recursive=True)
    for f in facts:
        path = Path(f)
        m = re.search(r"\{.*\}", path.read_text(encoding="utf-8", errors="ignore"), re.S)
        if not m:
            continue
        try:
            rec = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
        cid, hits = owner_tenant(rec, tenant_boxes)
        if not cid:
            report["unassigned"] += 1
            if apply and keep_unassigned:
                dest = qroot / "unassigned" / path.relative_to(qroot / "email-facts")
                dest.parent.mkdir(parents=True, exist_ok=True)
                path.replace(dest)
            continue
        direction = "outbound" if "outbound" in path.parts else "inbound"
        dest = base / "email-facts" / direction / cid / path.parent.name / path.name
        report["moved"] += 1
        report["by_tenant"][cid] = report["by_tenant"].get(cid, 0) + 1
        if apply:
            dest.parent.mkdir(parents=True, exist_ok=True)
            path.replace(dest)
    return report


def quarantine_foreign_facts(company_id: str, data_dir=None, apply: bool = False) -> dict:
    """把「写进了本租户目录、但收发地址都不是本租户邮箱」的事实移到 _quarantine。

    这些是早期未按租户收口时写进去的（跨租户污染），必须移出。

    口径未知（查不到本租户邮箱）时**直接拒绝**：那时 belongs_to_tenant 恒为 False，
    真跑下去会把这个租户的全部事实一股脑搬进隔离区。
    """
    base = _data_dir(data_dir)
    box = require_tenant_mailboxes(company_id, base)
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
    ap.add_argument("--rehome", action="store_true", help="把隔离区事实按正确租户归位")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    try:
        if args.rehome:
            r = rehome_quarantine(args.data_dir or None, apply=args.apply)
        elif args.quarantine:
            r = quarantine_foreign_facts(args.company_id, args.data_dir or None, apply=args.apply)
        else:
            box = tenant_mailboxes(args.company_id, args.data_dir or None)
            r = {"company_id": args.company_id, "mailboxes": sorted(box),
                 "scope_known": bool(box),
                 "data_dir": str(_data_dir(args.data_dir or None))}
            if not box:
                r["warning"] = ("查不到本租户绑定邮箱：所有拉取/展示链路会 fail-closed 拒绝，"
                                "请先补齐邮箱绑定")
    except TenantScopeUnknown as e:
        print(json.dumps({"ok": False, "code": "tenant_scope_unknown", "error": str(e)},
                         ensure_ascii=False, indent=2))
        return 3
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
