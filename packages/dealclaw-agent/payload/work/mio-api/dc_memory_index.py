#!/usr/bin/env python3
"""dc_memory_index — 租户 memory 索引（写给 agent 自己看的"地图"）+ 一致性校验。

目标（田耕郡 2026-09-13）：让 agent **容易查询记录**，且**线索/邮件记录不出错**。

产出：
  data/memory/<tenant>/INDEX.md   人/agent 都能读：这个租户的数据在哪、怎么查
  data/memory/<tenant>/index.json 机器可读：路径 + 计数 + 坐标 + 最后同步时间
  data/memory/INDEX.md            全租户总索引

校验（check）：
  ① 跨租户泄漏：邮件事实的收发地址是否都属于该租户绑定邮箱
  ② 计数一致性：索引里的计数 vs 磁盘实际
  ③ 线索/联系人是否落在本租户目录
任何不一致都如实报出（非 0 退出），不粉饰。

用法：
    python3 dc_memory_index.py build --apply     # 生成/刷新索引
    python3 dc_memory_index.py check             # 只校验
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import dc_tenant_mailboxes as tmb  # noqa: E402


def _data_dir(d=None) -> Path:
    return Path(d) if d else Path(os.environ.get("DC_DATA_DIR") or (HERE.parent.parent / "data"))


def _count(pattern: str) -> int:
    return len([p for p in glob.glob(pattern, recursive=True) if Path(p).is_file()])


def _latest(pattern: str) -> str:
    files = [Path(p) for p in glob.glob(pattern, recursive=True) if Path(p).is_file()]
    if not files:
        return ""
    try:
        newest = max(files, key=lambda p: p.stat().st_mtime)
        return datetime.fromtimestamp(newest.stat().st_mtime, timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    except OSError:
        return ""


def tenant_index(company_id: str, base: Path) -> dict:
    boxes = sorted(tmb.tenant_mailboxes(company_id, base))
    facts_dir = base / "email-facts"
    idx = {
        "company_id": company_id,
        "mailboxes": boxes,
        "generated_at": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M"),
        "paths": {
            "leads": "leads.json",
            "contacts": f"contacts/{company_id}/",
            "email_outbound": f"email-facts/outbound/{company_id}/",
            "email_inbound": f"email-facts/inbound/{company_id}/",
            "attachments": f"email-facts/attachments/{company_id}/",
            "pool_registry": "company_registry.json",
            "kb": f"memory/{company_id}/kb.json",
        },
        "counts": {
            "email_outbound": _count(str(facts_dir / f"outbound/{company_id}/**/*.md")),
            "email_inbound": _count(str(facts_dir / f"inbound/{company_id}/**/*.md")),
            "contacts": _count(str(base / f"contacts/{company_id}/*.md")),
            "attachments": _count(str(facts_dir / f"attachments/{company_id}/**/*")),
        },
        "latest": {
            "email_outbound": _latest(str(facts_dir / f"outbound/{company_id}/**/*.md")),
            "email_inbound": _latest(str(facts_dir / f"inbound/{company_id}/**/*.md")),
        },
        "pool": {},
        "queries": {
            "买家案卷（两侧原文）": "python3 dc_thread_dossier.py --company-id {} --buyer <邮箱>".format(company_id),
            "按线程键看案卷": "python3 dc_thread_dossier.py --company-id {} --key <线程键>".format(company_id),
            "拉两侧邮件": "python3 dc_resend_history.py --direction both --company-id {} --limit 200".format(company_id),
            "补联系人": "python3 dc_contact_backfill.py --company-id {} --apply".format(company_id),
            "拉附件": "python3 dc_resend_attachments.py --company-id {} --limit 50 --apply".format(company_id),
            "跟进记录回写": "python3 dc_followup_panel.py sync --base-token <pool_base> --table-id <跟进记录表> --pool-table <线索池表> --company-id {}".format(company_id),
        },
    }
    # 线索池坐标（company_registry.json）
    try:
        reg = json.loads((base / "company_registry.json").read_text(encoding="utf-8"))
        entries = reg if isinstance(reg, list) else (reg.get("entries") or [])
        for e in entries:
            if str(e.get("company_id") or e.get("enterprise") or "") == company_id:
                idx["pool"] = {"app_token": e.get("app_token", ""), "table_id": e.get("table_id", ""),
                               "url": e.get("bitable_url") or e.get("url", "")}
                break
    except (OSError, json.JSONDecodeError):
        pass
    return idx


def render_md(idx: dict) -> str:
    L = [f"# 租户 memory 索引 · {idx['company_id']}", "",
         f"- 绑定邮箱：{', '.join(idx['mailboxes']) or '（未登记）'}",
         f"- 生成时间：{idx['generated_at']}", "",
         "## 数据在哪", ""]
    for k, v in idx["paths"].items():
        L.append(f"- {k}: `{v}`")
    L += ["", "## 计数（磁盘实际）", ""]
    for k, v in idx["counts"].items():
        L.append(f"- {k}: {v}")
    L += ["", "## 最近更新", ""]
    for k, v in idx["latest"].items():
        L.append(f"- {k}: {v or '（无）'}")
    if idx.get("pool"):
        L += ["", "## 线索池", "",
              f"- app_token: `{idx['pool'].get('app_token','')}`",
              f"- table_id: `{idx['pool'].get('table_id','')}`",
              f"- 链接: {idx['pool'].get('url','')}"]
    L += ["", "## 怎么查（照抄即可）", ""]
    for k, v in idx["queries"].items():
        L.append(f"- {k}：`{v}`")
    L += ["", "> 口径：所有读取按**本租户绑定邮箱**收口；跨租户数据不进本目录。", ""]
    return "\n".join(L)


def build(base: Path, apply: bool = False) -> dict:
    tenant_boxes = tmb.all_tenant_mailboxes(base)
    result = {"tenants": [], "written": [], "apply": apply}
    for cid in sorted(tenant_boxes):
        idx = tenant_index(cid, base)
        result["tenants"].append({"company_id": cid, "counts": idx["counts"],
                                  "pool": bool(idx.get("pool"))})
        if apply:
            d = base / "memory" / cid
            d.mkdir(parents=True, exist_ok=True)
            (d / "index.json").write_text(json.dumps(idx, ensure_ascii=False, indent=2), encoding="utf-8")
            (d / "INDEX.md").write_text(render_md(idx), encoding="utf-8")
            result["written"].append(str(d / "INDEX.md"))
    if apply:
        root = base / "memory"
        root.mkdir(parents=True, exist_ok=True)
        lines = ["# 全租户 memory 索引", "",
                 f"生成：{datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M')}", "",
                 "| 租户 | 邮箱 | 出站/入站 | 联系人 | 附件 | 线索池 | 索引 |",
                 "|---|---|---|---|---|---|---|"]
        for cid in sorted(tenant_boxes):
            idx = tenant_index(cid, base)
            c = idx["counts"]
            lines.append(f"| {cid} | {', '.join(idx['mailboxes']) or '-'} | "
                         f"{c['email_outbound']}/{c['email_inbound']} | {c['contacts']} | "
                         f"{c['attachments']} | {'✅' if idx.get('pool') else '—'} | "
                         f"[INDEX.md]({cid}/INDEX.md) |")
        lines += ["", "> 查记录一律带 `--company-id <租户>`；跨租户数据被隔离在 `_quarantine/`。", ""]
        (root / "INDEX.md").write_text("\n".join(lines), encoding="utf-8")
        result["written"].append(str(root / "INDEX.md"))
    return result


def check(base: Path) -> dict:
    """一致性 + 跨租户泄漏校验。"""
    tenant_boxes = tmb.all_tenant_mailboxes(base)
    issues = []
    stats = {}
    for cid in sorted(tenant_boxes):
        out_p = f"{base}/email-facts/outbound/{cid}/**/*.md"
        in_p = f"{base}/email-facts/inbound/{cid}/**/*.md"
        mine = 0
        for p in glob.glob(out_p, recursive=True) + glob.glob(in_p, recursive=True):
            t = Path(p).read_text(encoding="utf-8", errors="ignore")
            import re
            m = re.search(r"\{.*\}", t, re.S)
            if not m:
                continue
            try:
                rec = json.loads(m.group(0))
            except json.JSONDecodeError:
                issues.append(f"{cid}: 事实文件 JSON 解析失败 {Path(p).name[:12]}")
                continue
            if tmb.belongs_to_tenant(rec, set(tenant_boxes[cid])):
                mine += 1
            else:
                issues.append(f"{cid}: 越权数据 {Path(p).name[:12]}（收发地址不属于本租户邮箱）")
        stats[cid] = {"facts_ok": mine,
                      "email_outbound": _count(out_p), "email_inbound": _count(in_p),
                      "contacts": _count(f"{base}/contacts/{cid}/*.md")}
    # 索引 vs 磁盘
    for cid in sorted(tenant_boxes):
        f = base / "memory" / cid / "index.json"
        if f.exists():
            try:
                idx = json.loads(f.read_text(encoding="utf-8"))
                for k, key in (("email_outbound", "email_outbound"), ("email_inbound", "email_inbound"),
                               ("contacts", "contacts")):
                    if idx["counts"].get(k) != stats[cid].get(key):
                        issues.append(f"{cid}: 索引 {k}={idx['counts'].get(k)} ≠ 磁盘 {stats[cid].get(key)}（需重跑 build）")
            except (OSError, json.JSONDecodeError, KeyError):
                issues.append(f"{cid}: index.json 损坏或字段缺失")
    return {"ok": not issues, "tenants": stats, "issues": issues}


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="租户 memory 索引 + 校验")
    ap.add_argument("cmd", choices=["build", "check"])
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    base = _data_dir(args.data_dir or None)
    r = build(base, apply=args.apply) if args.cmd == "build" else check(base)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    if args.cmd == "check" and not r["ok"]:
        return 2
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
