#!/usr/bin/env python3
"""dc_resend_history — 从 Resend 拉取「两侧」沟通记录（出站 + 入站）写入邮件事实层。

田耕郡 2026-09-13：需要把 Resend 两边的沟通记录都拉到（用于买家案卷的原文显示）。

端点（Resend API）：
  出站列表：GET /emails?limit=N             详情：GET /emails/{id}
  入站列表：GET /emails/receiving?limit=N   详情：GET /emails/receiving/{id}

写入：`email_gateway.store.MarkdownEmailStore.insert_message()`（幂等，按 message_id/时间取键），
     并用 `dc_contact_link.link_by_email()` 回填 lead_id / contact_id / contact_name。

权限：Resend 的 key 分「仅发送」与「完整权限」。仅发送的 key 调列表端点会 **403**。
      本工具遇到 403 会明确报「key 无读权限」，不会假装拉到 0 条。

用法：
    python3 dc_resend_history.py --direction both --limit 100 --company-id <sid> --json
    python3 dc_resend_history.py --direction both --dry-run     # 只探测权限与条数
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

API = "https://api.resend.com"


def _key(explicit: str = "") -> str:
    """优先用可读专用 key（RESEND_API_KEY_READ），避免动发送用的 key。"""
    return (explicit
            or os.environ.get("RESEND_API_KEY_READ", "").strip()
            or os.environ.get("RESEND_API_KEY", "").strip())


def _get(path: str, key: str, timeout: int = 25) -> dict:
    # Cloudflare 会按浏览器签名拦默认 UA（error code 1010），必须带正常 UA
    req = urllib.request.Request(API + path, headers={
        "Authorization": f"Bearer {key}",
        "User-Agent": "DealClawEmailBot/1.0 (+https://dealclaw.datathink.com)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "ignore")[:200]
        except Exception:
            pass
        if e.code in (401, 403):
            raise PermissionError(
                f"Resend 拒绝访问（HTTP {e.code}）—— 当前 key 只有发送权限，"
                f"需要「完整权限/可读」的 key 才能拉列表。{body}")
        raise RuntimeError(f"Resend HTTP {e.code}: {body}")


def list_side(direction: str, key: str, limit: int) -> list[dict]:
    path = f"/emails?limit={int(limit)}" if direction == "sent" else f"/emails/receiving?limit={int(limit)}"
    d = _get(path, key)
    items = d.get("data") if isinstance(d, dict) else None
    return items if isinstance(items, list) else []


def detail(direction: str, key: str, eid: str) -> dict:
    path = f"/emails/{eid}" if direction == "sent" else f"/emails/receiving/{eid}"
    try:
        return _get(path, key)
    except Exception:
        return {}


def to_fact(item: dict, det: dict, direction: str, company_id: str) -> dict:
    src = {**item, **(det if isinstance(det, dict) else {})}
    to = src.get("to") or src.get("recipients") or []
    if isinstance(to, str):
        to = [to]
    frm = src.get("from") or src.get("sender") or ""
    if isinstance(frm, dict):
        frm = frm.get("email") or frm.get("address") or ""
    fact = {
        "direction": "outbound" if direction == "sent" else "inbound",
        "account_id": "",
        "message_id": src.get("message_id") or src.get("id") or "",
        "resend_id": src.get("id") or "",
        "sender": frm,
        "recipients": [x for x in to if x],
        "subject": src.get("subject") or "",
        "text": src.get("text") or "",
        "html": src.get("html") or "",
        "company_id": company_id,
        "provider_status": (src.get("last_event") or "accepted"),
        "created_at": src.get("created_at") or src.get("createdAt") or "",
    }
    # 联系人回填（回信才能定位到买家）
    try:
        from dc_contact_link import link_by_email
        link = link_by_email(company_id, fact["recipients"] or [fact["sender"]])
        fact.update({"lead_id": link.get("lead_id", ""), "contact_id": link.get("contact_id", ""),
                     "contact_name": link.get("contact_name", "")})
    except Exception:
        pass
    return fact


def pull(*, direction: str = "both", limit: int = 100, company_id: str = "",
         key: str = "", dry_run: bool = False) -> dict:
    key = _key(key)
    if not key:
        return {"ok": False, "error": "缺少 RESEND_API_KEY"}
    sides = ["sent", "received"] if direction == "both" else [direction]
    report = {"ok": True, "dry_run": dry_run, "sides": {}, "written": 0, "errors": []}
    for side in sides:
        try:
            items = list_side(side, key, limit)
        except PermissionError as e:
            report["ok"] = False
            report["sides"][side] = {"fetched": 0, "error": str(e)[:300]}
            report["errors"].append({"side": side, "error": str(e)[:200]})
            continue
        except Exception as e:
            report["ok"] = False
            report["sides"][side] = {"fetched": 0, "error": str(e)[:200]}
            report["errors"].append({"side": side, "error": str(e)[:200]})
            continue
        written = 0
        if not dry_run:
            from email_gateway.store import MarkdownEmailStore
            store = MarkdownEmailStore()
            for it in items:
                eid = it.get("id") or ""
                det = detail(side, key, eid) if eid else {}
                fact = to_fact(it, det, side, company_id)
                try:
                    if store.insert_message(fact):
                        written += 1
                except Exception as e:
                    report["errors"].append({"side": side, "id": eid, "error": str(e)[:160]})
        report["sides"][side] = {"fetched": len(items), "written": written}
        report["written"] += written
    return report


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="从 Resend 拉取两侧沟通记录")
    ap.add_argument("--direction", default="both", choices=["both", "sent", "received"])
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    r = pull(direction=args.direction, limit=args.limit, company_id=args.company_id,
             dry_run=args.dry_run)
    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(r["sides"], ensure_ascii=False, indent=2))
        if not r["ok"]:
            print("❌ 未完成：" + json.dumps(r["errors"], ensure_ascii=False)[:300])
    return 0 if r["ok"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
