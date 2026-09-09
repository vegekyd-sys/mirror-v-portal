#!/usr/bin/env python3
"""DC-PendingSend — 待发队列 + 定时发送调度器

解决「约 HH:00 自动发」空头承诺：不在买家当地工作日 8-18 窗口的邮件落持久化队列，
由 cron 每 30 分钟扫「到点且未发」的项 → 触发真实发送 → 回执推回发起会话。

队列文件：data/pending_sends.jsonl（每行一个 JSON，原子写 + 文件锁）

子命令：
  enqueue  —— 落一条待发项（供 dc_email_send 窗口路由调用，也可手动）
  run      —— 调度器主循环：扫到点未发项 → 发送 → 标记结果（cron 调用）
  list     —— 查看队列（status/pending 过滤）
  retry    —— 重发 failed 项（可选）
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent            # work/mio-api
DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(HERE / "data")))
QUEUE_FILE = DATA_DIR / "pending_sends.jsonl"
LOCK_FILE = DATA_DIR / "pending_sends.lock"

HEADER = "# DealClaw Pending Sends — DO NOT EDIT MANUALLY. One JSON per line.\n"


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _lock():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    f = open(LOCK_FILE, "a")
    fcntl.flock(f, fcntl.LOCK_EX)
    return f


def _unlock(f):
    fcntl.flock(f, fcntl.LOCK_UN)
    f.close()


def _read_all() -> list[dict]:
    if not QUEUE_FILE.exists():
        return []
    out = []
    for line in QUEUE_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _write_all(records: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = QUEUE_FILE.with_suffix(".jsonl.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(HEADER)
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    tmp.replace(QUEUE_FILE)


def _item_id(channel: str, from_addr: str, to_list: list[str], subject: str,
             target_window: str) -> str:
    key = "|".join([channel, from_addr, ",".join(sorted(to_list)), subject, target_window])
    return "ps_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def enqueue(channel: str, from_addr: str, to_list: list[str], subject: str,
            html: str = "", text: str = "", cc: list[str] | None = None,
            bcc: list[str] | None = None, country: str = "", city: str = "",
            receipt_target: str = "", enterprise: str = "",
            target_window: str = "") -> dict:
    """落一条待发项。幂等：同 id 已 pending/sending 则跳过。"""
    to_list = [t for t in (to_list or []) if t and t.strip()]
    if not enterprise:
        return {"status": "rejected", "error": "missing enterprise（发送必须带 --enterprise）"}
    iid = _item_id(channel, from_addr, to_list, subject, target_window or _now_utc())

    rec = {
        "id": iid,
        "channel": channel.upper(),
        "from": from_addr,
        "to": to_list,
        "subject": subject,
        "html": html,
        "text": text,
        "cc": cc or [],
        "bcc": bcc or [],
        "country": country,
        "city": city,
        "receipt_target": receipt_target,
        "enterprise": enterprise,
        "target_window": target_window,   # UTC ISO
        "status": "pending",
        "created_at": _now_utc(),
        "sent_at": "",
        "error": "",
        "attempts": 0,
    }

    f = _lock()
    try:
        records = _read_all()
        for r in records:
            if r.get("id") == iid and r.get("status") in ("pending", "sending"):
                return {"status": "duplicate", "id": iid}
        records.append(rec)
        _write_all(records)
    finally:
        _unlock(f)
    return {"status": "enqueued", "id": iid}


def _due(records: list[dict], now: str) -> list[dict]:
    out = []
    for r in records:
        if r.get("status") != "pending":
            continue
        tw = r.get("target_window") or ""
        if tw and tw <= now:
            out.append(r)
    return out


def _dispatch(item: dict) -> dict:
    """对单条待发项执行发送（复用 dc_email_send.send_batch，含回执）。"""
    if not item.get("enterprise"):
        # 防御：历史遗留空 enterprise 项不静默跳过落库，直接判失败
        return {"success": False, "error": "missing enterprise（待发项缺 enterprise）", "count": 0}
    from dc_email_send import send_batch
    return send_batch(
        channel=item.get("channel", "GS"),
        from_addr=item.get("from", ""),
        to_list=item.get("to", []),
        subject=item.get("subject", ""),
        html=item.get("html", ""),
        text=item.get("text", ""),
        cc=item.get("cc") or None,
        bcc=item.get("bcc") or None,
        receipt_target=item.get("receipt_target", ""),
        enterprise=item.get("enterprise", ""),
    )


def run(dry_run: bool = False) -> dict:
    """调度主循环：扫到点未发项，逐条发送并落结果。返回结构化汇总。"""
    now = _now_utc()
    f = _lock()
    try:
        records = _read_all()
        due = _due(records, now)
        if not due:
            return {"status": "quiet", "due": 0, "results": []}

        # 先全部标记 sending，避免并发重复发送
        due_ids = {d["id"] for d in due}
        for r in records:
            if r.get("id") in due_ids:
                r["status"] = "sending"
        _write_all(records)

        results = []
        for d in due:
            if dry_run:
                results.append({"id": d["id"], "status": "dry_run",
                                "to": d.get("to"), "target_window": d.get("target_window")})
                continue
            res = _dispatch(d)
            results.append({"id": d["id"], "status": "sent" if res.get("success") else "failed",
                            "count": res.get("count"), "error": res.get("error", "")})

        # 回写终态（dry-run 则还原为 pending）
        final = {r["id"]: r for r in results}
        for r in records:
            if r.get("id") in due_ids:
                fr = final.get(r["id"])
                if fr is None:
                    continue
                if dry_run:
                    r["status"] = "pending"
                else:
                    r["status"] = fr["status"]
                    r["sent_at"] = _now_utc() if fr["status"] == "sent" else r.get("sent_at", "")
                    r["error"] = fr.get("error", "")[:500]
                    if fr["status"] == "failed":
                        r["attempts"] = int(r.get("attempts", 0)) + 1
        _write_all(records)

        return {"status": "dispatched", "due": len(due), "dry_run": dry_run,
                "results": results}
    finally:
        _unlock(f)


def list_queue(status: str = "") -> list[dict]:
    records = _read_all()
    if status:
        records = [r for r in records if r.get("status") == status]
    return records


def _cli() -> int:
    ap = argparse.ArgumentParser(description="待发队列 + 定时发送调度器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("enqueue", help="落一条待发项")
    e.add_argument("--channel", required=True, choices=["GS", "FD"])
    e.add_argument("--from", dest="from_addr", required=True)
    e.add_argument("--to", required=True)
    e.add_argument("--subject", required=True)
    e.add_argument("--html", default="")
    e.add_argument("--text", default="")
    e.add_argument("--country", default="")
    e.add_argument("--city", default="")
    e.add_argument("--receipt-target", default="")
    e.add_argument("--enterprise", default="")
    e.add_argument("--target-window", default="")

    r = sub.add_parser("run", help="调度器主循环")
    r.add_argument("--dry-run", action="store_true")

    l = sub.add_parser("list", help="查看队列")
    l.add_argument("--status", default="")

    args = ap.parse_args()

    if args.cmd == "enqueue":
        to_list = [x.strip() for x in args.to.split(",") if x.strip()]
        res = enqueue(channel=args.channel, from_addr=args.from_addr, to_list=to_list,
                      subject=args.subject, html=args.html, text=args.text,
                      country=args.country, city=args.city,
                      receipt_target=args.receipt_target, enterprise=args.enterprise,
                      target_window=args.target_window)
        print(json.dumps(res, ensure_ascii=False))
        return 0
    if args.cmd == "run":
        print(json.dumps(run(dry_run=args.dry_run), ensure_ascii=False))
        return 0
    if args.cmd == "list":
        for rec in list_queue(args.status):
            print(json.dumps(rec, ensure_ascii=False))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
