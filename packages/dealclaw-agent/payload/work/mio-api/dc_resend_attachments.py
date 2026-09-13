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


def pull(*, company_id: str, limit: int = 30, apply: bool = False,
         data_dir=None, side: str = "received") -> dict:
    base = _data_dir(data_dir)
    if not _key():
        return {"ok": False, "error": "缺少 RESEND_API_KEY_READ / RESEND_API_KEY"}
    path = "/emails/receiving?limit=" + str(int(limit)) if side == "received" \
        else "/emails?limit=" + str(int(limit))
    try:
        items = _api(path).get("data") or []
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}

    report = {"ok": True, "scanned": len(items), "messages_with_att": 0,
              "attachments": 0, "downloaded": 0, "skipped": 0, "failed": [], "apply": apply}
    root = base / "email-facts" / "attachments" / company_id
    ym = datetime.now(timezone.utc).strftime("%Y-%m")
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
            dest = root / ym / mid / fname
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
        idx = root / ym / "_index.jsonl"
        idx.parent.mkdir(parents=True, exist_ok=True)
        existing = set()
        if idx.exists():
            for line in idx.read_text(encoding="utf-8").splitlines():
                try:
                    existing.add(json.loads(line).get("path"))
                except json.JSONDecodeError:
                    pass
        with idx.open("a", encoding="utf-8") as fh:
            for row in index_lines:
                if row.get("path") not in existing:
                    fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        report["index"] = str(idx)
    return report


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="拉取 Resend 邮件附件")
    ap.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--side", default="received", choices=["received", "sent"])
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    r = pull(company_id=args.company_id, limit=args.limit, apply=args.apply,
             data_dir=args.data_dir or None, side=args.side)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r.get("ok") else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
