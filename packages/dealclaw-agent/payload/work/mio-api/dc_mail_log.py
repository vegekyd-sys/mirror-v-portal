#!/usr/bin/env python3
"""收发信记录查询与导出：按时间顺序查询；支持一次性取某企业全部收发件。

数据源：事实层 `data/email-facts/{outbound,inbound}/<company_id>/<YYYY-MM>/*.md`
（`EmailStore.insert_message` 写入的 Markdown 快照，内含 JSON）。

能力：
  · 按时间升序输出（最老 → 最新），支持 `--desc` 倒序
  · 按企业（company_id）、账号、方向（inbound/outbound）、时间区间过滤
  · 一次性导出整个企业的全部记录（`--all`），支持 json / md / csv

用法::

    python3 dc_mail_log.py list   --enterprise <company_id> [--direction all|inbound|outbound]
                                  [--account-id <id>] [--start 2026-09-01] [--end 2026-09-30]
                                  [--limit 50] [--desc]
    python3 dc_mail_log.py export --enterprise <company_id> [--all] [--format json|md|csv]
                                  [--out <path>]
    python3 dc_mail_log.py summary --enterprise <company_id>
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
FACTS = BASE / "data" / "email-facts"

_TIME_KEYS = {
    "outbound": ("sent_at", "created_at", "updated_at"),
    "inbound": ("received_at", "created_at", "updated_at"),
}


def _load_records(direction: str, company_id: str = "") -> list[dict]:
    """读取事实层记录；company_id 为空表示全部企业。"""
    root = FACTS / direction
    if not root.exists():
        return []
    dirs = [root / company_id] if company_id else [d for d in root.iterdir() if d.is_dir()]
    out = []
    for d in dirs:
        if not d.exists():
            continue
        for p in sorted(d.glob("**/*.md")):
            try:
                raw = p.read_text(encoding="utf-8")
                rec = json.loads(raw[raw.find("{"):raw.rfind("}") + 1])
            except Exception:  # noqa: BLE001
                continue
            rec["_direction"] = direction
            rec["_path"] = str(p.relative_to(BASE))
            rec["_company_dir"] = d.name
            out.append(rec)
    return out


def _time_of(rec: dict) -> str:
    for key in _TIME_KEYS.get(rec.get("_direction", "outbound"), ("created_at",)):
        val = rec.get(key)
        if val:
            return str(val)
    return ""


def _norm_day(value: str, *, end: bool = False) -> str:
    """把 yyyy-MM-dd 归一为可比字符串；end 时补到当天末尾。"""
    s = str(value or "").strip()
    if not s:
        return ""
    if len(s) == 10:
        return s + ("T23:59:59.999999+00:00" if end else "T00:00:00+00:00")
    return s


def query(*, enterprise: str = "", account_id: str = "", direction: str = "all",
          start: str = "", end: str = "", limit: int = 0, desc: bool = False) -> dict:
    """按条件查询收发信记录，**默认按时间升序**。返回结构化结果。"""
    dirs = ["outbound", "inbound"] if direction == "all" else [direction]
    rows: list[dict] = []
    for d in dirs:
        rows.extend(_load_records(d, enterprise))
    if account_id:
        rows = [r for r in rows if r.get("account_id") == account_id]
    s = _norm_day(start)
    e = _norm_day(end, end=True)
    if s or e:
        kept = []
        for r in rows:
            t = _time_of(r)
            if not t:
                continue
            if s and t < s:
                continue
            if e and t > e:
                continue
            kept.append(r)
        rows = kept
    rows.sort(key=lambda r: _time_of(r), reverse=bool(desc))
    total = len(rows)
    if limit and limit > 0:
        rows = rows[:limit]
    items = [{
        "time": _time_of(r),
        "direction": r.get("_direction", ""),
        "company": r.get("company_id") or r.get("_company_dir", ""),
        "account_id": r.get("account_id", ""),
        "from": r.get("sender", ""),
        "to": r.get("recipients") or [],
        "subject": r.get("subject", ""),
        "status": r.get("status") or r.get("provider_status") or "",
        "resend_id": r.get("resend_id", ""),
        "message_id": r.get("smtp_message_id") or r.get("message_id", ""),
        "attachments": len(r.get("attachments") or []),
    } for r in rows]
    return {"total": total, "returned": len(items), "direction": direction,
            "enterprise": enterprise, "start": start, "end": end,
            "first_time": items[0]["time"] if items else "",
            "last_time": items[-1]["time"] if items else "",
            "items": items}


def render(items: list[dict], fmt: str = "json") -> str:
    if fmt == "json":
        return json.dumps(items, ensure_ascii=False, indent=1)
    if fmt == "md":
        lines = ["| 时间 | 方向 | 对方 | 主题 | 状态 |", "|---|---|---|---|---|"]
        for it in items:
            peer = it["to"][0] if it["direction"] == "outbound" and it["to"] else it.get("from", "")
            lines.append(f"| {it['time'][:19]} | {it['direction']} | {peer} | "
                         f"{(it['subject'] or '')[:40]} | {it['status']} |")
        return "\n".join(lines)
    if fmt == "csv":
        import io
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["time", "direction", "company", "account_id", "from", "to", "subject", "status"])
        for it in items:
            w.writerow([it["time"], it["direction"], it["company"], it["account_id"],
                        it["from"], ";".join(it["to"]), it["subject"], it["status"]])
        return buf.getvalue()
    raise ValueError(f"unsupported format: {fmt}")


def summary(*, enterprise: str = "") -> dict:
    outbound = _load_records("outbound", enterprise)
    inbound = _load_records("inbound", enterprise)
    def span(rows):
        ts = sorted(t for t in (_time_of(r) for r in rows) if t)
        return {"count": len(rows), "first": ts[0] if ts else "", "last": ts[-1] if ts else ""}
    return {"enterprise": enterprise or "(全部)", "outbound": span(outbound), "inbound": span(inbound)}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="收发信记录：按时间查询 / 一次性导出")
    sub = p.add_subparsers(dest="command", required=True)

    l = sub.add_parser("list", help="按时间顺序查询")
    l.add_argument("--enterprise", default="")
    l.add_argument("--account-id", default="")
    l.add_argument("--direction", choices=["all", "inbound", "outbound"], default="all")
    l.add_argument("--start", default="")
    l.add_argument("--end", default="")
    l.add_argument("--limit", type=int, default=50)
    l.add_argument("--desc", action="store_true", help="按时间倒序（默认升序）")
    l.add_argument("--format", choices=["json", "md", "csv"], default="json")

    e = sub.add_parser("export", help="导出（默认整企业全量）")
    e.add_argument("--enterprise", default="")
    e.add_argument("--account-id", default="")
    e.add_argument("--direction", choices=["all", "inbound", "outbound"], default="all")
    e.add_argument("--start", default="")
    e.add_argument("--end", default="")
    e.add_argument("--all", action="store_true", help="不限条数（默认即全量）")
    e.add_argument("--limit", type=int, default=0)
    e.add_argument("--desc", action="store_true")
    e.add_argument("--format", choices=["json", "md", "csv"], default="json")
    e.add_argument("--out", default="", help="写入文件（默认打印）")

    s = sub.add_parser("summary", help="企业收发信概览")
    s.add_argument("--enterprise", default="")

    a = p.parse_args(argv)
    if a.command == "list":
        r = query(enterprise=a.enterprise, account_id=a.account_id, direction=a.direction,
                  start=a.start, end=a.end, limit=a.limit, desc=a.desc)
        print(render(r["items"], a.format))
        print(f"\n# 命中 {r['total']} 条，返回 {r['returned']} 条；时间范围 {r['first_time'][:19]} ~ {r['last_time'][:19]}",
              file=sys.stderr)
        return 0
    if a.command == "export":
        r = query(enterprise=a.enterprise, account_id=a.account_id, direction=a.direction,
                  start=a.start, end=a.end, limit=a.limit, desc=a.desc)
        text = render(r["items"], a.format)
        if a.out:
            Path(a.out).write_text(text, encoding="utf-8")
            print(json.dumps({"ok": True, "path": a.out, "records": r["returned"],
                              "total": r["total"]}, ensure_ascii=False))
        else:
            print(text)
            print(f"\n# 导出 {r['returned']} 条（该企业总记录 {r['total']} 条）", file=sys.stderr)
        return 0
    if a.command == "summary":
        print(json.dumps(summary(enterprise=a.enterprise), ensure_ascii=False, indent=1))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
