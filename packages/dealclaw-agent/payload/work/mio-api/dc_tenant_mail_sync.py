#!/usr/bin/env python3
"""dc_tenant_mail_sync — 面向所有租户执行「租户绑定邮箱 → 各拉各的往来」。

口径（田耕郡 2026-09-13）：邮箱在租户 session 里创建并绑定（多对一）；
**每个租户只读取/调用自己绑定邮箱的往来内容**，不拉全量、不串租户。

对每个租户依次执行（全部带租户收口）：
  ① 拉邮件两侧（dc_resend_history，默认按租户邮箱过滤）
  ② 拉附件（dc_resend_attachments，同样收口）
  ③ 组装线程案卷（dc_thread_dossier，只并本租户邮件）
另外全局做一次：隔离区按归属回填（dc_tenant_mailboxes --rehome）

用法：
    python3 dc_tenant_mail_sync.py --all-tenants --apply --limit 200
    python3 dc_tenant_mail_sync.py --all-tenants            # 只报数，不写
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import dc_resend_attachments as att  # noqa: E402
import dc_resend_history as hist  # noqa: E402
import dc_tenant_mailboxes as tmb  # noqa: E402
import dc_thread_dossier as td  # noqa: E402


def run(*, apply: bool = False, limit: int = 200, att_limit: int = 50,
        data_dir=None, tenants: list[str] | None = None) -> dict:
    base = tmb._data_dir(data_dir)
    boxes = tmb.all_tenant_mailboxes(base)
    targets = tenants or sorted(boxes)
    report = {"apply": apply, "tenants": targets, "per_tenant": {}, "rehome": {}}

    for cid in targets:
        entry: dict = {"mailboxes": sorted(boxes.get(cid, [])), "pull": {}, "attachments": {},
                       "threads": 0, "facts": 0}
        try:
            entry["pull"] = hist.pull(direction="both", limit=limit, company_id=cid,
                                      dry_run=not apply)
        except Exception as e:
            entry["pull"] = {"error": str(e)[:160]}
        try:
            entry["attachments"] = att.pull(company_id=cid, limit=att_limit,
                                            apply=apply, data_dir=base)
        except Exception as e:
            entry["attachments"] = {"error": str(e)[:160]}
        try:
            facts = td.load_facts(base, cid)          # load_facts 内部已按租户邮箱收口
            entry["facts"] = len(facts)
            entry["threads"] = len(td.build_threads(facts))
        except Exception as e:
            entry["threads"] = f"error: {str(e)[:120]}"
        report["per_tenant"][cid] = entry

    # 全局一次：隔离区按归属回填
    try:
        report["rehome"] = tmb.rehome_quarantine(base, apply=apply)
    except Exception as e:
        report["rehome"] = {"error": str(e)[:160]}
    return report


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="所有租户：绑定邮箱 → 各拉各的往来")
    ap.add_argument("--all-tenants", action="store_true", help="对所有已注册账号的租户执行")
    ap.add_argument("--tenant", action="append", default=[], help="只做指定租户（可重复）")
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--att-limit", type=int, default=50)
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    r = run(apply=args.apply, limit=args.limit, att_limit=args.att_limit,
            data_dir=args.data_dir or None, tenants=args.tenant or None)
    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        for cid, e in r["per_tenant"].items():
            print(f"[{cid}] 邮箱={e['mailboxes']} | 事实 {e['facts']} | 线程 {e['threads']}")
            print(f"   拉取: {json.dumps(e['pull'], ensure_ascii=False)[:160]}")
            print(f"   附件: {json.dumps(e['attachments'], ensure_ascii=False)[:120]}")
        print("隔离区回填:", json.dumps(r["rehome"], ensure_ascii=False)[:200])
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
