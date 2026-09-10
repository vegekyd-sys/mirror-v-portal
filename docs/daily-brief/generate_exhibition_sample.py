#!/usr/bin/env python3
"""generate_exhibition_sample.py — ExhibitionProvider 五阶段真实早晚报样例（证据用）

对 profiling / planning / inviting / live / followup 五个阶段各生成一份早报 + 晚报，
覆盖：阶段化 result/action/risk/insight、本届范围、专项卡摘要、展中切换、
未会面再激活、数据质量风险。

用法：python3 docs/daily-brief/generate_exhibition_sample.py [--out docs/daily-brief/exhibition]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MIO = HERE.parents[1] / "packages" / "dealclaw-agent" / "payload" / "work" / "mio-api"
sys.path.insert(0, str(MIO))

from dc_daily_brief import BriefContext  # noqa: E402
from dc_daily_pipeline import run_morning_brief, run_evening_brief  # noqa: E402

COMPANY = "152600996207"
EXH = "E1"


def d(delta: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=delta)).date().isoformat()


def iso_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


class ExhStore:
    def __init__(self, meta, invitations, interactions=None, sync=None):
        self._meta, self._inv, self._inter, self._sync = meta, invitations, interactions or [], sync

    def read_meta(self, cid):
        return self._meta

    def list_invitations(self, cid, exh_id=""):
        return self._inv

    def list_interactions(self, cid):
        return self._inter

    def read_sync(self, cid, exh_id=""):
        return self._sync


class Empty:
    def __init__(self, key):
        self._key = key

    def __getattr__(self, name):
        def _f(*a, **k):
            return [] if "list" in name or "read" in name else {}
        return _f


class EmailStore:
    def __init__(self, outbounds=None):
        self._o = outbounds or []

    def list_outbound_records(self, company_id=None):
        return self._o

    def list_inbound_records(self, company_id=None):
        return []


def meta(stage, start, end, understanding_done=False, plan_done=False):
    return {"exhibition_stage": stage, "understanding_done": understanding_done,
            "plan_done": plan_done,
            "exhibitions": [{"exhibition_id": EXH, "name": "巴西圣保罗展", "start": start,
                             "end": end, "timezone": "America/Sao_Paulo"}]}


def inv(cdp, name, checkin=0, meeting=0, state=0, exh_id=EXH):
    return {"companyCdpId": cdp, "companyName": name, "country": "BR",
            "website": f"{cdp}.example", "exhibitionId": exh_id, "sendTime": d(-3),
            "isCheckIn": checkin, "isMeeting": meeting, "inviationState": state,
            "email": f"{cdp}@x.com"}


def sync(records, status="completed"):
    return {"exhibition_id": EXH, "status": status,
            "synced_through": "2030-01-01T00:00:00Z", "records": records}


def scenarios():
    live_inv = [
        inv("C1", "Casa Outdoor", checkin=1, meeting=1),
        inv("C2", "Hotel Group BR", checkin=1, meeting=0),
        inv("C3", "Retail SA", checkin=3),
        inv("C4", "No Thanks Ltd", state=3),
    ]
    return {
        "profiling": (meta("profiling", d(10), d(12)), [], sync(0, "completed_empty")),
        "planning": (meta("planning", d(10), d(12)), [], sync(0, "completed_empty")),
        "inviting": (meta("inviting", d(10), d(12)),
                     [inv("C1", "Casa Outdoor"), inv("C2", "Hotel Group BR"),
                      inv("C4", "No Thanks Ltd", state=3)], sync(3)),
        "live": (meta("live", d(-1), d(1)), live_inv, sync(4)),
        "followup": (meta("followup", d(-5), d(-3)),
                     [inv("C1", "Casa Outdoor", checkin=1, meeting=1),
                      inv("C2", "Hotel Group BR", checkin=3),
                      inv("C3", "Retail SA", checkin=3)], sync(3)),
    }


def ctx(report_type):
    now = datetime.now(timezone.utc).isoformat()
    return BriefContext(tenant="meorient", company=COMPANY, report_type=report_type,
                        date=d(0), tz="Asia/Shanghai", as_of=now, window_start=now, window_end=now)


def _evening_events(stage, plan):
    """各阶段晚报真实事件。"""
    acts = plan["actions"]
    def key(cat):
        return next((a["action_key"] for a in acts if a["category"] == cat), None)
    if stage == "planning":
        return [{"action_key": key("stage_planning"), "kind": "signal", "status": "resolved",
                 "signal_id": f"stage:{EXH}:planning", "event_id": "st1",
                 "occurred_at": iso_ago(0)}]  # 阶段推进 → 方案完成
    if stage == "live":
        buyer = next((a for a in acts if a["category"] == "onsite_followup"), None)
        if buyer:
            return [{"action_key": buyer["action_key"], "kind": "followup_sent",
                     "target_id": buyer["detail"]["buyer_email"], "event_id": "fu1",
                     "occurred_at": iso_ago(0)}]
    if stage == "followup":
        ev = []
        for i, a in enumerate([x for x in acts if x["category"] == "reactivate_no_meeting"]):
            if i == 0:  # 只完成 1/2 → partial
                ev.append({"action_key": a["action_key"], "kind": "followup_sent",
                           "target_id": a["detail"]["buyer_email"], "event_id": f"fu{i}",
                           "occurred_at": iso_ago(0)})
        return ev
    return []


def render(stage, slot, plan, review):
    lines = [f"# {('早报' if slot == 'morning' else '晚报')} · {d(0)} · 展会阶段：{stage}", ""]
    if slot == "morning":
        for label, kinds in (("结果", "result"), ("动作", "action"), ("风险", "risk"),
                             ("洞察", "insight")):
            group = [c for c in plan["context"] if c["kind"] == kinds] if kinds != "action" else plan["actions"]
            if not group:
                continue
            lines.append(f"## {label}")
            for c in group:
                tag = f"[{c.get('priority')}] " if kinds == "action" else ""
                lines.append(f"- {tag}{c['title']}")
            lines.append("")
    else:
        by_key = {a["action_key"]: a for a in plan["actions"]}
        lines.append("## 核销结果（只依据真实事件）")
        for rv in review["reviews"]:
            a = by_key.get(rv["action_key"], {})
            lines.append(f"- {a.get('title', rv['action_key'])}：**{rv['status']}**")
        if review.get("warnings"):
            lines += ["", "## 警告"] + [f"- {w}" for w in review["warnings"]]
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "exhibition"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    email_store = EmailStore([{"direction": "outbound", "provider_status": "delivered",
                               "recipients": ["x@y.com"], "resend_id": "re0",
                               "sent_at": iso_ago(0.2), "created_at": iso_ago(0.2),
                               "touch_number": 0, "company_id": COMPANY, "subject": "邀请"}])
    summary = []
    for stage, (m, invs, sync_d) in scenarios().items():
        store = ExhStore(m, invs, [], sync_d)
        base = out / "_run" / stage
        mr = run_morning_brief(ctx("morning"), base, email_store=email_store,
                               opp_store=Empty("opp"), exh_store=store)
        plan = mr["plan"]
        (out / f"{stage}-morning.json").write_text(
            json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
        (out / f"{stage}-morning.md").write_text(render(stage, "morning", plan, None),
                                                 encoding="utf-8")
        er = run_evening_brief(ctx("evening"), base, email_store=email_store,
                               exh_store=store, events=_evening_events(stage, plan))
        (out / f"{stage}-evening.json").write_text(
            json.dumps(er["review"], ensure_ascii=False, indent=2), encoding="utf-8")
        (out / f"{stage}-evening.md").write_text(render(stage, "evening", plan, er["review"]),
                                                 encoding="utf-8")
        summary.append((stage, [a["title"] for a in plan["actions"]],
                        [r["status"] for r in er["review"]["reviews"]]))
    import shutil
    shutil.rmtree(out / "_run", ignore_errors=True)
    for stage, acts, statuses in summary:
        print(f"{stage}: actions={acts} review={statuses}")


if __name__ == "__main__":
    main()
