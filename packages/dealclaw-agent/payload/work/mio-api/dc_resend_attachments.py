#!/usr/bin/env python3
"""dc_resend_attachments — 拉取 Resend 邮件的附件（买家附图/报价/证书等）。

Resend 侧：
  列表/详情：GET /emails/receiving/{id} → 详情里带 attachments[]
  附件元数据：GET /emails/receiving/{id}/attachments/{att_id} → {filename, content_type, size, download_url, expires_at}
  下载：直接取 download_url（CDN，带过期时间）

落地：data/email-facts/attachments/<company_id>/<YYYY-MM>/<message_id>/<filename>
索引：同目录 _index.jsonl（message_id → 文件、大小、类型、sha256），供案卷挂附件
幂等：文件已存在则跳过；下载失败逐条记录，不静默。

用法：
    # 先判链路（resend 代理邮箱 / 个人邮箱 IMAP），不联网
    python3 dc_resend_attachments.py --route --message-id "<邮件id>"
    # 代理邮箱（provider=resend / mailbox_kind=dealclaw_proxy）：现拉走 Resend API
    python3 dc_resend_attachments.py --pull --message-id "<邮件id>"
    python3 dc_resend_attachments.py --pull --latest           # 最近一封带附件的入站
    # 个人邮箱（163/腾讯/gmail …）：附件在收信时已由 imap_sync 落盘，重收走 IMAP
    python3 dc_resend_attachments.py --find --message-id "<邮件id>"
    python3 -m email_gateway.cli sync --account-id <id>        # 没落盘时重收该账号
    # 批量兜底
    python3 dc_resend_attachments.py --company-id <sid> --limit 30 --apply
    python3 dc_resend_attachments.py --company-id <sid> --limit 30     # 只报有多少附件
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

UA = "DealClawEmailBot/1.0 (+https://dealclaw.datathink.com)"


def _key() -> str:
    return os.environ.get("RESEND_API_KEY_READ", "").strip() or os.environ.get("RESEND_API_KEY", "").strip()


def _api(path: str, timeout: int = 30) -> dict:
    req = urllib.request.Request("https://api.resend.com" + path, headers={
        "Authorization": f"Bearer {_key()}", "User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def _data_dir(data_dir=None) -> Path:
    return Path(data_dir) if data_dir else Path(os.environ.get("DC_DATA_DIR")
                                                or (HERE.parent.parent / "data"))


def _safe(name: str) -> str:
    return re.sub(r"[^\w.\-()（）\u4e00-\u9fff]+", "_", str(name or "attachment"))[:120]


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for c in iter(lambda: fh.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def download(url: str, dest: Path, *, timeout: int = 60) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    dest.write_bytes(data)
    return len(data)


# ── 统一附件库（Resend 与 IMAP 两条入站通道共用同一套落盘约定）──────────
# 目录：<data>/email-facts/attachments/<company_id>/<YYYY-MM>/<message_id>/<filename>
# 索引：同月目录下 _index.jsonl，一行一个附件，供案卷/知识库按 message_id 反查。

# 查不到时给 agent 的下一步提示（提醒卡片不带邮件 id，--latest 最常用）
_PULL_HINT = ("本地没有落盘记录；可现拉："
              "python3 dc_resend_attachments.py --pull --message-id \"<邮件id>\" "
              "或 --pull --latest 取最近一封带附件的入站")

# 个人邮箱（IMAP）链路的正确取法：**不要**用 --pull（它只走 Resend API）
_IMAP_NEXT = ("这封走个人邮箱（IMAP）链路，不能用 --pull（Resend API 里没有这封）。正确取法："
              "1) 先 python3 dc_resend_attachments.py --find 查已落盘（收信时 imap_sync 已落）；"
              "2) 没有就重收该邮箱：cd work/mio-api && python3 -m email_gateway.cli sync "
              "--account-id <账号id>，再 --find。")


def _store():
    """懒加载 EmailStore（拿不到返回 None，链路判定降级为 unknown，不报错）。"""
    try:
        from email_gateway.store import EmailStore
        return EmailStore()
    except Exception:  # noqa: BLE001
        return None


def route_of_account(account: dict) -> str:
    """账号 → 'resend'（代理邮箱）或 'imap'（个人邮箱）。

    判据只有一条：账号的 provider / mailbox_kind（事实层的账号记录）。
    """
    provider = str((account or {}).get("provider") or "").strip().lower()
    kind = str((account or {}).get("mailbox_kind") or "").strip().lower()
    if provider == "resend" or kind == "dealclaw_proxy":
        return "resend"
    return "imap"


def mailbox_route(*, company_id: str = "", message_id: str = "",
                  account_id: str = "") -> dict:
    """判断这封邮件 / 这个账号走的是 resend 代理邮箱还是个人邮箱（IMAP）。

    代理邮箱与个人邮箱的附件取法是**两条路**：代理走 Resend API，个人邮箱靠 IMAP 收信时
    落盘。优先用传入的 account_id；否则按 message_id 查本地入站记录反查账号。
    查不到就说 unknown——**不猜**，更不跨链路瞎试。
    """
    store = _store()
    mid = (message_id or "").strip()
    if not account_id and mid and store is not None:
        try:
            for rec in store.list_inbound_records(company_id or None):
                if mid in (rec.get("message_id"), rec.get("resend_received_id")):
                    account_id = rec.get("account_id") or ""
                    break
        except Exception:  # noqa: BLE001
            account_id = account_id or ""
    account = None
    if account_id and store is not None:
        try:
            account = store.get_account(account_id)
        except Exception:  # noqa: BLE001
            account = None
    if not account:
        return {"route": "unknown", "account_id": account_id,
                "reason": "本地查不到该邮件/账号的账号记录"}
    return {"route": route_of_account(account), "account_id": account_id,
            "email_address": account.get("email_address", ""),
            "provider": account.get("provider", ""),
            "mailbox_kind": account.get("mailbox_kind", "")}


def _latest_local_inbound(company_id: str = "") -> dict:
    """本地事实层里最近一封入站（用于判链路；拿不到返回 {}）。"""
    store = _store()
    if store is None:
        return {}
    try:
        recs = store.list_inbound_records(company_id or None)
    except Exception:  # noqa: BLE001
        return {}
    if not recs:
        return {}
    return max(recs, key=lambda r: (r.get("received_at") or r.get("created_at") or ""))
# company_id 为空时落 "_unmatched"，与 EmailStore._company_dir 的兜底口径一致。

MAX_BYTES = int(os.environ.get("DC_ATTACHMENT_MAX_BYTES") or 25 * 1024 * 1024)


def _month(ts: str = "") -> str:
    """附件按邮件时间分月；解析不出来就按当前 UTC 月，保证永远有个落点。"""
    if ts:
        try:
            return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).strftime("%Y-%m")
        except ValueError:
            pass
    return datetime.now(timezone.utc).strftime("%Y-%m")


def _company_slug(company_id: str) -> str:
    """空 company_id 要落 _unmatched，不能交给 _safe——_safe("") 返回的是 "attachment"，
    会凭空造出一个假企业目录（测试 test_blank_company_falls_back_to_unmatched 守这条）。"""
    cid = str(company_id or "").strip()
    return _safe(cid) if cid else "_unmatched"


def attachment_dir(company_id: str, message_id: str, *, ym: str = "", data_dir=None) -> Path:
    return (_data_dir(data_dir) / "email-facts" / "attachments"
            / _company_slug(company_id) / (ym or _month()) / _safe(message_id))


def append_index(rows: list, *, company_id: str, ym: str = "", data_dir=None) -> str:
    """把附件行追加进当月 _index.jsonl，按 path 去重。返回索引文件路径。"""
    if not rows:
        return ""
    idx = (_data_dir(data_dir) / "email-facts" / "attachments"
           / _company_slug(company_id) / (ym or _month()) / "_index.jsonl")
    idx.parent.mkdir(parents=True, exist_ok=True)
    existing = set()
    if idx.exists():
        for line in idx.read_text(encoding="utf-8").splitlines():
            try:
                existing.add(json.loads(line).get("path"))
            except json.JSONDecodeError:
                pass
    with idx.open("a", encoding="utf-8") as fh:
        for row in rows:
            if row.get("path") and row.get("path") not in existing:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                existing.add(row["path"])
    return str(idx)


def store_bytes(*, company_id: str, message_id: str, filename: str, content_type: str = "",
                data: bytes = b"", ym: str = "", data_dir=None) -> dict:
    """把一段附件二进制落盘，返回索引行。

    幂等：目标文件已存在则不重写，只补 sha256 回索引行（Resend 重放 / IMAP 重投都安全）。
    超过 MAX_BYTES 的不落盘，返回 skipped 行——宁可记一笔「有这个附件但太大」，
    也不让单封邮件把 PVC 撑爆或静默丢失线索。
    """
    ym = ym or _month()
    dest = attachment_dir(company_id, message_id, ym=ym, data_dir=data_dir) / _safe(filename)
    row = {"message_id": message_id, "filename": _safe(filename),
           "content_type": content_type or "", "size": len(data), "path": str(dest)}
    if dest.exists():
        row["sha256"] = _sha256(dest)
        row["stored"] = True
        return row
    if len(data) > MAX_BYTES:
        row.update({"stored": False, "skipped": "too_large", "limit": MAX_BYTES})
        return row
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    row["sha256"] = _sha256(dest)
    row["stored"] = True
    return row


def pull_for_message(*, company_id: str, message_id: str, attachments: list,
                     ym: str = "", data_dir=None) -> list:
    """Resend 入站单封邮件的附件拉取：详情里的 attachments[] → 下载 → 落盘 → 索引。

    逐条 best-effort：单个附件失败只记一行 error，不影响同封其它附件，更不影响回复主链路。
    """
    rows = []
    ym = ym or _month()
    for att in attachments or []:
        if not isinstance(att, dict):
            continue
        att_id = att.get("id") or ""
        meta = att
        if att_id and message_id:
            try:
                meta = _api(f"/emails/receiving/{message_id}/attachments/{att_id}") or att
            except Exception as e:
                rows.append({"message_id": message_id, "attachment_id": att_id,
                             "filename": _safe(att.get("filename")), "stored": False,
                             "error": f"meta: {str(e)[:120]}"})
                continue
        fname = meta.get("filename") or att.get("filename") or "attachment"
        url = meta.get("download_url") or ""
        if not url:
            rows.append({"message_id": message_id, "attachment_id": att_id, "filename": _safe(fname),
                         "stored": False, "error": "no download_url"})
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                blob = r.read()
        except Exception as e:
            rows.append({"message_id": message_id, "attachment_id": att_id, "filename": _safe(fname),
                         "stored": False, "error": f"download: {str(e)[:120]}"})
            continue
        row = store_bytes(company_id=company_id, message_id=message_id, filename=fname,
                          content_type=meta.get("content_type") or att.get("content_type") or "",
                          data=blob, ym=ym, data_dir=data_dir)
        row["attachment_id"] = att_id
        rows.append(row)
    append_index(rows, company_id=company_id, ym=ym, data_dir=data_dir)
    return rows


def pull(*, company_id: str, limit: int = 30, apply: bool = False,
         data_dir=None, side: str = "received") -> dict:
    if not _key():
        return {"ok": False, "error": "缺少 RESEND_API_KEY_READ / RESEND_API_KEY"}
    path = "/emails/receiving?limit=" + str(int(limit)) if side == "received" \
        else "/emails?limit=" + str(int(limit))
    try:
        items = _api(path).get("data") or []
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}

    # 租户收口：只处理与本租户绑定邮箱有往来的邮件
    try:
        from dc_tenant_mailboxes import belongs_to_tenant, tenant_mailboxes
        boxes = tenant_mailboxes(company_id)
        if boxes:
            items = [it for it in items if belongs_to_tenant(it, boxes)]
    except Exception:
        pass
    report = {"ok": True, "scanned": len(items), "messages_with_att": 0,
              "attachments": 0, "downloaded": 0, "skipped": 0, "failed": [], "apply": apply}
    ym = _month()
    index_lines: list[dict] = []
    for it in items:
        mid = it.get("id") or ""
        try:
            det = _api(f"/emails/{'receiving/' if side == 'received' else ''}{mid}")
        except Exception as e:
            report["failed"].append({"message": mid, "error": str(e)[:120]})
            continue
        atts = det.get("attachments") or []
        if not atts:
            continue
        report["messages_with_att"] += 1
        for att in atts:
            report["attachments"] += 1
            try:
                meta = _api(f"/emails/receiving/{mid}/attachments/{att.get('id')}") if side == "received" \
                    else att
            except Exception as e:
                report["failed"].append({"message": mid, "att": att.get("id"), "error": str(e)[:120]})
                continue
            fname = _safe(meta.get("filename") or att.get("filename"))
            dest = attachment_dir(company_id, mid, ym=ym, data_dir=data_dir) / fname
            row = {"message_id": mid, "attachment_id": att.get("id"), "filename": fname,
                   "content_type": meta.get("content_type") or att.get("content_type"),
                   "size": meta.get("size") or att.get("size"), "path": str(dest),
                   "subject": it.get("subject") or ""}
            if dest.exists():
                report["skipped"] += 1
                row["sha256"] = _sha256(dest); index_lines.append(row); continue
            if not apply:
                index_lines.append(row); continue
            try:
                n = download(meta.get("download_url") or "", dest)
                row["size"] = n
                row["sha256"] = _sha256(dest)
                report["downloaded"] += 1
                index_lines.append(row)
            except Exception as e:
                report["failed"].append({"message": mid, "file": fname, "error": str(e)[:120]})
    if apply and index_lines:
        report["index"] = append_index(index_lines, company_id=company_id, ym=ym,
                                       data_dir=data_dir)
    return report


def pull_message(*, company_id: str, message_id: str, data_dir=None,
                 account_id: str = "") -> dict:
    """按单封邮件现拉附件（**仅 resend 代理邮箱**；个人邮箱走 IMAP，见 _IMAP_NEXT）。

    为什么需要：入站时的附件落盘是 best-effort —— 详情接口偶尔不带 attachments、
    webhook 与轮询两条链路先后顺序不同、或者第一次下载就失败了，都会让「卡片说有
    附件」变成「拿不到」。这里给 agent 一个随时可用的现拉入口。

    只听字节 + 落盘 + 写索引，**不外发**（把文件交到用户手上是调用方的事）。
    """
    message_id = (message_id or "").strip()
    if not message_id:
        return {"ok": False, "error": "缺少 --message-id"}
    route = mailbox_route(company_id=company_id, message_id=message_id,
                          account_id=account_id)
    if route["route"] == "imap":
        return {"ok": False, "route": "imap", "message_id": message_id,
                "account_id": route.get("account_id", ""),
                "error": "该邮件走个人邮箱（IMAP），不能用 Resend 现拉",
                "next": _IMAP_NEXT}
    if not _key():
        return {"ok": False, "route": route["route"], "error": "缺少 RESEND_API_KEY_READ / RESEND_API_KEY"}
    try:
        det = _api(f"/emails/receiving/{message_id}") or {}
    except Exception as e:  # noqa: BLE001 - 网络/权限类异常统一转成结构化结果
        return {"ok": False, "route": route["route"], "message_id": message_id,
                "error": f"detail: {str(e)[:160]}"}
    atts = det.get("attachments") or []
    if not atts:
        return {"ok": True, "route": route["route"], "message_id": message_id,
                "count": 0, "rows": [], "note": "该封邮件没有附件"}
    rows = pull_for_message(company_id=company_id, message_id=message_id,
                            attachments=atts, data_dir=data_dir)
    return {"ok": True, "route": route["route"], "message_id": message_id,
            "subject": det.get("subject") or "",
            "count": len(rows), "stored": sum(1 for r in rows if r.get("stored")),
            "rows": rows}


def pull_latest(*, company_id: str, scan: int = 10, data_dir=None) -> dict:
    """现拉「最近一封带附件的入站邮件」（**仅 resend 代理邮箱**）。

    用途：提醒卡片按口径只说「有附件」，卡片里不带 Resend 邮件 id；
    用户说「把附件发我」时 agent 不知道是哪封 —— 先看本地最近一封入站走哪条链路：
    个人邮箱直接给正确取法（IMAP），只有代理邮箱才去 Resend 回看。
    """
    local = _latest_local_inbound(company_id)
    if local:
        route = mailbox_route(company_id=company_id, account_id=local.get("account_id") or "")
        if route["route"] == "imap":
            return {"ok": False, "route": "imap",
                    "message_id": local.get("message_id") or "",
                    "account_id": route.get("account_id", ""),
                    "error": "最近一封入站走个人邮箱（IMAP），不能用 Resend 现拉",
                    "next": _IMAP_NEXT}
    if not _key():
        return {"ok": False, "error": "缺少 RESEND_API_KEY_READ / RESEND_API_KEY"}
    try:
        items = _api(f"/emails/receiving?limit={int(scan)}").get("data") or []
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"list: {str(e)[:160]}"}

    # 租户收口：只认与本租户绑定邮箱有往来的邮件（与 pull() 同一口径）
    filtered_note = ""
    try:
        from dc_tenant_mailboxes import belongs_to_tenant, tenant_mailboxes
        boxes = tenant_mailboxes(company_id)
        if boxes:
            before = len(items)
            items = [it for it in items if belongs_to_tenant(it, boxes)]
            if before != len(items):
                filtered_note = f"（{before - len(items)} 封不属于本租户，已按租户收口过滤）"
    except Exception:  # noqa: BLE001
        pass

    skipped = 0
    for it in items:
        mid = (it or {}).get("id") or ""
        if not mid:
            continue
        r = pull_message(company_id=company_id, message_id=mid, data_dir=data_dir)
        if r.get("count"):
            r["scanned"] = skipped + 1
            return r
        if not r.get("ok"):
            return r
        skipped += 1
    return {"ok": True, "route": "resend", "count": 0, "rows": [], "scanned": len(items),
            "note": f"最近 {len(items)} 封入站里没有带附件的邮件{filtered_note}"}


def find(*, company_id: str, message_id: str = "", name: str = "",
         limit: int = 20, data_dir=None) -> dict:
    """按 message_id / 文件名查已落盘的附件，供 agent 应「看附件」这类请求。

    扫该企业所有月份的 _index.jsonl，新月在前、同月内后写的在前（追加顺序即时间序）。
    只读，不下载、不外发——把文件交到用户手上是调用方的事，这里只负责「在哪」。
    """
    root = (_data_dir(data_dir) / "email-facts" / "attachments" / _company_slug(company_id))
    if not root.is_dir():
        return {"ok": True, "count": 0, "rows": [], "note": "该企业还没有任何附件记录",
                "hint": _PULL_HINT}
    rows = []
    for month_dir in sorted((d for d in root.iterdir() if d.is_dir()), reverse=True):
        idx = month_dir / "_index.jsonl"
        if not idx.is_file():
            continue
        month_rows = []
        for line in idx.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message_id and row.get("message_id") != message_id:
                continue
            if name and name.lower() not in str(row.get("filename") or "").lower():
                continue
            row["exists"] = bool(row.get("path") and Path(row["path"]).is_file())
            month_rows.append(row)
        rows.extend(reversed(month_rows))
        if len(rows) >= limit:
            break
    out = rows[:limit]
    result = {"ok": True, "count": len(out), "rows": out}
    if not out:
        result["hint"] = _PULL_HINT
    return result


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="拉取 / 查询邮件附件")
    ap.add_argument("--find", action="store_true",
                    help="只查已落盘的附件（不联网），配合 --message-id / --name")
    ap.add_argument("--message-id", default="", help="--find 精确匹配 / --pull 指定单封现拉")
    ap.add_argument("--name", default="", help="--find：按文件名子串匹配")
    ap.add_argument("--pull", action="store_true",
                    help="现拉附件（仅 resend 代理邮箱）：配 --message-id 拉单封；配 --latest 拉最近一封")
    ap.add_argument("--latest", action="store_true", help="--pull：看最近入站走哪条链路并现拉")
    ap.add_argument("--scan", type=int, default=10, help="--pull --latest：最多回看几封（默认 10）")
    ap.add_argument("--route", action="store_true",
                    help="只判链路（resend 代理邮箱 / 个人邮箱 IMAP），不联网、不落盘")
    ap.add_argument("--account-id", default="", help="--pull/--route：直接指定账号，免去反查")
    ap.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--side", default="received", choices=["received", "sent"])
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if args.find:
        r = find(company_id=args.company_id, message_id=args.message_id, name=args.name,
                 limit=args.limit, data_dir=args.data_dir or None)
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0
    if args.route:
        r = mailbox_route(company_id=args.company_id, message_id=args.message_id,
                          account_id=args.account_id)
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0
    if args.pull:
        if args.latest:
            r = pull_latest(company_id=args.company_id, scan=args.scan,
                            data_dir=args.data_dir or None)
        else:
            r = pull_message(company_id=args.company_id, message_id=args.message_id,
                             data_dir=args.data_dir or None, account_id=args.account_id)
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0 if r.get("ok") else 1
    r = pull(company_id=args.company_id, limit=args.limit, apply=args.apply,
             data_dir=args.data_dir or None, side=args.side)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r.get("ok") else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
