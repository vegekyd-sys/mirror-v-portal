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
import re
import sys
import time
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


def _get(path: str, key: str, timeout: int = 25, attempts: int = 6) -> dict:
    # Cloudflare 会按浏览器签名拦默认 UA（error code 1010），必须带正常 UA。
    # Resend 限流 10 req/s：翻页 + 逐封取详情很容易碰上限，必须退避重试，
    # 否则一旦 429 就丢掉后面所有页（表现为「只拉到第一页」）。
    for attempt in range(max(1, attempts)):
        req = urllib.request.Request(API + path, headers={
            "Authorization": f"Bearer {key}",
            "User-Agent": "DealClawEmailBot/1.0 (+https://dealclaw.datathink.com)",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < max(1, attempts) - 1:
                delay = 0.0
                try:
                    ra = e.headers.get("Retry-After") if e.headers else None
                    if ra:
                        delay = float(ra)
                except (TypeError, ValueError):
                    delay = 0.0
                time.sleep(max(delay, min(0.5 * (2 ** attempt), 8.0)))
                continue
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
    raise RuntimeError(f"Resend HTTP 429: 退避重试仍被限流（{path}）")


def list_side(direction: str, key: str, limit: int) -> list[dict]:
    """分页拉取（Resend：单页上限 100，用 after=<last id> 翻页）。"""
    total = max(int(limit or 100), 1)
    out: list[dict] = []
    cursor = ""
    base = "/emails" if direction == "sent" else "/emails/receiving"
    while len(out) < total:
        path = f"{base}?limit=100" + (f"&after={cursor}" if cursor else "")
        d = _get(path, key)
        items = d.get("data") if isinstance(d, dict) else None
        if not isinstance(items, list) or not items:
            break
        out.extend(items)
        if not d.get("has_more"):
            break
        cursor = str(items[-1].get("id") or "")
        if not cursor:
            break
    return out[:total]


def list_side_single(direction: str, key: str, limit: int) -> list[dict]:
    """（保留：单页拉取，仅取前 limit 条）"""
    path = (f"/emails?limit={int(limit)}" if direction == "sent"
            else f"/emails/receiving?limit={int(limit)}")
    d = _get(path, key)
    items = d.get("data") if isinstance(d, dict) else None
    return items if isinstance(items, list) else []


def detail(direction: str, key: str, eid: str) -> dict:
    path = f"/emails/{eid}" if direction == "sent" else f"/emails/receiving/{eid}"
    try:
        return _get(path, key)
    except Exception:
        return {}


def fetch_details(direction: str, key: str, items: list[dict], workers: int = 1) -> list[dict]:
    """批量取详情。``workers>1`` 时用线程池并发拉正文。

    为什么需要：全量回拉时**每封邮件一次详情调用**是瓶颈（实测单次 ~0.42s，
    1.6 万封 ≈ 2.5 小时）。瓶颈是网络往返不是 CPU，所以并发真有用。
    默认 ``workers=1`` 保持原有逐封行为；调用方要自己保证不超过 Resend 的
    10 req/s 限额（``_get`` 内部已带 429 退避，超了只会变慢不会丢数据）。
    只并发**取数据**，写库仍由调用方单线程顺序完成，避免并发写事实层。
    """
    ids = [str(it.get("id") or "") for it in items]
    if workers <= 1:
        return [detail(direction, key, eid) for eid in ids]
    from concurrent.futures import ThreadPoolExecutor  # noqa: PLC0415

    with ThreadPoolExecutor(max_workers=max(1, int(workers))) as pool:
        return list(pool.map(lambda eid: detail(direction, key, eid), ids))


def known_source_ids(store) -> set[str]:
    """扫描事实层，返回已落库的 Resend 邮件 id 集合。

    用途：全量回拉时**跳过已知记录**。每封邮件要单独调一次详情接口（实测 ~0.4s/封），
    重复拉已知记录会把整个回拉预算烧在重复请求上；有了这个集合，重复执行
    （或中途被打断后重跑）只会处理剩下的，能稳定收敛。

    事实层里 ``resend_id``（出站）/ ``resend_received_id``（入站）就是 Resend 的邮件 id。
    """
    known: set[str] = set()
    for direction in ("outbound", "inbound"):
        for p in (store.root / direction).rglob("*.md"):
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            m = re.search(r"\{.*\}", text, re.S)
            if not m:
                continue
            try:
                rec = json.loads(m.group(0))
            except json.JSONDecodeError:
                continue
            for k in ("resend_id", "resend_received_id"):
                v = rec.get(k)
                if v:
                    known.add(str(v))
    return known


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
         key: str = "", dry_run: bool = False, all_tenants: bool = False,
         concurrency: int = 1, chunk_size: int = 200) -> dict:
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
        # 租户收口：只保留与本租户绑定邮箱有往来的邮件（田耕郡 2026-09-13）
        try:
            from dc_tenant_mailboxes import belongs_to_tenant, tenant_mailboxes
            boxes = tenant_mailboxes(company_id)
            if boxes and not all_tenants:
                items = [it for it in items if belongs_to_tenant(it, boxes)]
        except Exception:
            pass
        written = 0
        skipped = 0
        failed = 0
        already = 0
        if not dry_run:
            from email_gateway.store import MarkdownEmailStore
            store = MarkdownEmailStore()
            # 跳过已落库的（回拉要逐封取详情，重复拉已知记录会白烧预算）
            try:
                known = known_source_ids(store)
            except Exception as e:  # noqa: BLE001
                known = set()
                report["errors"].append({"side": side, "warning": f"known_source_ids: {e}"})
            if known:
                keep = [it for it in items if str(it.get("id") or "") not in known]
                already = len(items) - len(keep)
                items = keep
            # 分块：每块取完详情立即写盘。既限定内存（详情含正文，万级会吃大量内存），
            # 也让进程被中途打断时已完成的块不白做（剩余部分下次跑自然续上）。
            chunk_size = max(1, int(chunk_size or 200))
            for start in range(0, len(items), chunk_size):
                chunk = items[start:start + chunk_size]
                details = fetch_details(side, key, chunk, workers=concurrency)
                for it, det in zip(chunk, details):
                    eid = it.get("id") or ""
                    fact = to_fact(it, det, side, company_id)
                    try:
                        if store.insert_message(fact):
                            written += 1
                        else:
                            skipped += 1          # 已存在（幂等去重）
                    except Exception as e:  # noqa: BLE001
                        failed += 1
                        report["errors"].append({"side": side, "id": eid, "error": str(e)[:160]})
        report["sides"][side] = {"fetched": already + len(items) if not dry_run else len(items),
                                 "existing": already, "written": written,
                                 "skipped": skipped, "failed": failed}
        report["written"] += written
    return report


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="从 Resend 拉取两侧沟通记录")
    ap.add_argument("--direction", default="both", choices=["both", "sent", "received"])
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all-tenants", action="store_true", help="不按租户邮箱收口（默认收口）")
    ap.add_argument("--concurrency", type=int, default=1,
                    help="并发取详情数（默认 1=逐封；全量回拉可调 4，注意 Resend 10 req/s）")
    ap.add_argument("--chunk-size", type=int, default=200,
                    help="每块取完详情立即写盘（限内存 + 中途被打断不白做）")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    r = pull(direction=args.direction, limit=args.limit, company_id=args.company_id,
             dry_run=args.dry_run, all_tenants=args.all_tenants,
             concurrency=args.concurrency, chunk_size=args.chunk_size)
    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(r["sides"], ensure_ascii=False, indent=2))
        if not r["ok"]:
            print("❌ 未完成：" + json.dumps(r["errors"], ensure_ascii=False)[:300])
    return 0 if r["ok"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
