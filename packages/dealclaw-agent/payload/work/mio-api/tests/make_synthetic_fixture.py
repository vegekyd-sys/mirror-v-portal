#!/usr/bin/env python3
"""make_synthetic_fixture.py — 生成**合成**邮件事实样本，用于对账演练。

⚠️ 全部为合成数据，不含任何真实租户信息。仅用于验证 Adapter / 回放 / 对账链路。

用法：
    python3 tests/make_synthetic_fixture.py --out /tmp/dc-synthetic
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

COMPANY = "152600996207"
CAMPAIGN = "cmp-synthetic-2026-09"

# 合成盘子：80 封发送（5 封无 provider id）+ 12 封真人回复 + 2 自动回复 + 3 未归属
N_SENT_WITH_PROVIDER = 75
N_SENT_WITHOUT_PROVIDER = 5
N_DELIVERED = 68
N_BOUNCED = 1
N_REPLY_LEADS = 8          # 8 个不同 lead → unique_repliers = 8
N_AUTO_REPLY = 2
N_UNASSIGNED = 2
N_AMBIGUOUS = 1


def _snapshot(rec: dict) -> str:
    return "# DealClaw Email Fact\n\n" + json.dumps(rec, ensure_ascii=False) + "\n"


def build(out_dir: str | Path) -> dict:
    out = Path(out_dir)
    root = out / "email-facts"
    odir = root / "outbound" / COMPANY / "2026-09"
    idir = root / "inbound" / COMPANY / "2026-09"
    ddir = root / "delivery-events"
    for d in (odir, idir, ddir):
        d.mkdir(parents=True, exist_ok=True)

    counts = {"sent_with_provider": 0, "sent_without_provider": 0,
              "delivered": 0, "bounced": 0, "inbound": 0, "auto_reply": 0,
              "unassigned": 0, "ambiguous": 0}

    rid_by_index = {}
    for i in range(N_SENT_WITH_PROVIDER):
        rid = f"syn-r{i:03d}"
        rid_by_index[i] = rid
        if i < N_DELIVERED:
            status = "delivered"
            counts["delivered"] += 1
        elif i < N_DELIVERED + N_BOUNCED:
            status = "bounced"
            counts["bounced"] += 1
        else:
            status = ""          # 有 accepted、无终态 → pending
        counts["sent_with_provider"] += 1
        rec = {
            "resend_id": rid,
            "smtp_message_id": f"<syn.{i:03d}@mail.dealclaw.io>",
            "sent_at": f"2026-09-{(i % 9) + 1:02d}T01:{i % 60:02d}:00+00:00",
            "company_id": COMPANY,
            "campaign_id": CAMPAIGN,
            "lead_id": f"L{i:03d}",
            "provider_status": status,
            "thread_id": f"th{i:03d}",
            "account_id": "ema_synthetic",
        }
        (odir / f"ob{i:03d}.md").write_text(_snapshot(rec), encoding="utf-8")

    for j in range(N_SENT_WITHOUT_PROVIDER):
        counts["sent_without_provider"] += 1
        (odir / f"legacy{j:02d}.md").write_text(_snapshot({
            "sent_at": f"2026-08-{20 + j:02d}T02:00:00+00:00",
            "company_id": COMPANY,
            "campaign_id": CAMPAIGN,
            "lead_id": f"LX{j:02d}",
            "provider_status": "delivered",
        }), encoding="utf-8")

    for k in range(N_REPLY_LEADS):
        counts["inbound"] += 1
        (idir / f"in{k:02d}.md").write_text(_snapshot({
            "resend_received_id": f"syn-in-{k:02d}",
            "message_id": f"<reply.{k:03d}@buyer.example>",
            "received_at": f"2026-09-{(k % 9) + 2:02d}T0{k % 9}:10:00+00:00",
            "company_id": COMPANY,
            "campaign_id": CAMPAIGN,
            "lead_id": f"L{k:03d}",
            "in_reply_to": f"<syn.{k:03d}@mail.dealclaw.io>",
            "binding_status": "bound",
        }), encoding="utf-8")

    # 跨日回复：业务日比发送日晚 2 天
    counts["inbound"] += 1
    (idir / "in_crossday.md").write_text(_snapshot({
        "resend_received_id": "syn-in-crossday",
        "message_id": "<reply.crossday@buyer.example>",
        "received_at": "2026-09-11T16:40:00+00:00",
        "company_id": COMPANY,
        "campaign_id": CAMPAIGN,
        "lead_id": "L000",
        "in_reply_to": "<syn.000@mail.dealclaw.io>",
        "binding_status": "bound",
    }), encoding="utf-8")

    for a in range(N_AUTO_REPLY):
        counts["auto_reply"] += 1
        (idir / f"auto{a}.md").write_text(_snapshot({
            "resend_received_id": f"syn-auto-{a}",
            "message_id": f"<ooo.{a}@buyer.example>",
            "received_at": f"2026-09-06T0{a}:00:00+00:00",
            "company_id": COMPANY, "campaign_id": CAMPAIGN,
            "in_reply_to": "<syn.001@mail.dealclaw.io>",
            "binding_status": "bound", "auto_reply": True,        }), encoding="utf-8")

    for u in range(N_UNASSIGNED):
        counts["unassigned"] += 1
        (idir / f"un{u}.md").write_text(_snapshot({
            "resend_received_id": f"syn-un-{u}",
            "message_id": f"<unmatched.{u}@somewhere.example>",
            "received_at": "2026-09-07T03:00:00+00:00",
            "binding_status": "unmatched",
        }), encoding="utf-8")

    for m in range(N_AMBIGUOUS):
        counts["ambiguous"] += 1
        (idir / f"amb{m}.md").write_text(_snapshot({
            "resend_received_id": f"syn-amb-{m}",
            "message_id": f"<weak.{m}@somewhere.example>",
            "received_at": "2026-09-08T04:00:00+00:00",
            "in_reply_to": "<unknown-parent@nowhere>",
            "binding_status": "unmatched",
        }), encoding="utf-8")

    # 投递事件：一条与 outbound 状态重复（验证事件级幂等/去重不重复计数）
    (ddir / "2026-09-01.md").write_text(
        json.dumps({"event_id": "syn-d1", "event_type": "delivered",
                    "resend_id": "syn-r000", "created_at": "2026-09-01T01:00:05+00:00"}) + "\n"
        + json.dumps({"event_id": "syn-d2", "event_type": "bounced",
                      "resend_id": "syn-r074", "created_at": "2026-09-04T09:00:00+00:00"}) + "\n",
        encoding="utf-8")

    return counts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/dc-synthetic")
    args = ap.parse_args()
    counts = build(args.out)
    print(f"合成样本已生成：{args.out}")
    print(json.dumps(counts, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
