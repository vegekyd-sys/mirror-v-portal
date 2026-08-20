#!/usr/bin/env python3
"""DC-Campaign / DC-Daily-Cycle — P0-2.1 验收测试

使用临时目录（DC_DATA_DIR），禁止污染真实数据。
运行：cd work/mio-api && python3 test_dc_p02.py
"""

import os
import sys
import tempfile
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="dc-p02-test-")
os.environ["DC_DATA_DIR"] = _TMP

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_campaign import (
    create_campaign, get_active_campaign, get_campaign, update_campaign,
    evaluate_campaign, _days_until,
)
from dc_daily_cycle import (
    build_morning_plan, evaluate_evening, _plan_id, _save_plan,
    _list_experiments, CALIBRATION_SAMPLE_COUNT,
)


def main():
    passed = []
    failures = []

    def check(name, cond, extra=""):
        if cond:
            passed.append(name)
            print(f"  ✅ {name}")
        else:
            failures.append(name)
            print(f"  ❌ {name}  {extra}")

    print("=" * 70)

    # 1. 距展会3天、画像未确认：phase=pre_show, buyer_readiness=learning
    r = create_campaign("testco", "2026 Q4 印尼展", "2026-11-20",
                        target_invites=50, target_meetings=10)
    camp = get_active_campaign("testco")
    ev = evaluate_campaign(camp, {"delivered": 0}, today="2026-11-17")
    check("1. 距展会3天画像未确认 → pre_show + learning",
          ev["phase"] == "pre_show" and ev["buyer_readiness"] == "learning"
          and ev["days_remaining"] == 3,
          f"phase={ev['phase']} readiness={ev['buyer_readiness']} days={ev['days_remaining']}")

    # 2. 画像待确认时产生 requires_confirmation Todo
    morning = build_morning_plan("testco", date="2026-11-17", dry_run=True)
    confirm_todos = [t for t in morning["todos"] if t.get("requires_confirmation")]
    check("2. 画像待确认 → requires_confirmation Todo",
          any("确认买家画像" in t["action"] for t in confirm_todos),
          str([t["action"] for t in confirm_todos]))

    # 3. 已确认且在授权范围内时不重复询问（单一事实源=BuyerState）
    update_campaign(camp["campaign_id"], owner_open_id="ou_test_owner", automation_scope="full")
    from dc_buyer_state import BuyerState
    BuyerState().confirm_profile("testco", "ou_test_owner")
    camp2 = get_active_campaign("testco")
    morning2 = build_morning_plan("testco", date="2026-10-01", dry_run=True)
    confirm_actions = [t["action"] for t in morning2["todos"] if t.get("requires_confirmation")]
    check("3. 已确认+授权内 → 不重复询问画像",
          not any("确认买家画像" in a for a in confirm_actions),
          str(confirm_actions))

    # 4. 80次发送但送达未知 → insufficient_data
    ev4 = evaluate_campaign(camp2, {"sent": 80, "delivered": 0}, today="2026-10-01")
    check("4. 80发送无送达证据 → insufficient_data",
          ev4["strategy_health"] == "insufficient_data",
          f"health={ev4['strategy_health']}")

    # 5-7. 策略调整幂等回归（7 点：初始3 → 创建源3 → 持久化4 → 复用同实验 → 仍4 → 单实验 → 重启仍满足）
    update_campaign(camp["campaign_id"], strategy_version=3)
    camp3 = get_campaign(camp["campaign_id"])
    check("5a. 初始 Campaign strategy_version=3", camp3["strategy_version"] == 3,
          f"version={camp3['strategy_version']}")

    plan_id = _plan_id("testco", "2026-10-02")
    _save_plan({
        "plan_id": plan_id, "company_id": "testco",
        "campaign_id": camp["campaign_id"], "date": "2026-10-02",
        "strategy_version": 3, "todos": [],
        "evaluation": {"needs_strategy_review": True, "strategy_health": "needs_review",
                       "evidence": {"valid_delivered": 80, "valid_inquiries": 0,
                                    "sent": 80, "bounced": 2}},
    })

    e1 = evaluate_evening("testco", date="2026-10-02", dry_run=True)
    sc1 = e1["summary"]["strategy_change"]
    check("5b. 第一次 evening 创建实验，source_strategy_version=3",
          sc1["action"] == "created_experiment"
          and sc1["experiment"]["source_strategy_version"] == 3
          and sc1["strategy_version"] == 4,
          str(sc1))

    camp4 = get_campaign(camp["campaign_id"])
    check("5c. Campaign 持久化 strategy_version=4", camp4["strategy_version"] == 4,
          f"version={camp4['strategy_version']}")

    e2 = evaluate_evening("testco", date="2026-10-02", dry_run=True)
    sc2 = e2["summary"]["strategy_change"]
    check("6a. 第二次 evening 返回同一个 existing_experiment",
          sc2["action"] == "existing_experiment"
          and sc2["experiment"]["experiment_id"] == sc1["experiment"]["experiment_id"],
          str(sc2))

    camp5 = get_campaign(camp["campaign_id"])
    check("6b. Campaign strategy_version 仍为 4（不重复升级）", camp5["strategy_version"] == 4,
          f"version={camp5['strategy_version']}")

    exps = _list_experiments("testco")
    check("6c. experiments 目录只有一个实验", len(exps) == 1, f"count={len(exps)}")

    # 7. 重启进程后再次运行，仍满足
    import subprocess
    proc = subprocess.run(
        [sys.executable, "-c", f"""
import sys, json
sys.path.insert(0, '.')
from dc_daily_cycle import evaluate_evening
from dc_campaign import get_campaign
r = evaluate_evening('testco', date='2026-10-02', dry_run=True)
camp = get_campaign('{camp["campaign_id"]}')
print(json.dumps({{'action': r['summary']['strategy_change']['action'],
                   'version': camp['strategy_version']}}))
"""],
        env={**os.environ, "DC_DATA_DIR": _TMP}, cwd=".", capture_output=True, text=True,
    )
    proc_out = proc.stdout.strip()
    import json as _json
    try:
        proc_data = _json.loads(proc_out)
        check("7. 重启进程后仍 existing_experiment 且 version=4",
              proc_data.get("action") == "existing_experiment" and proc_data.get("version") == 4,
              proc_out)
    except Exception:
        check("7. 重启进程后仍满足", False, f"stdout={proc_out!r} stderr={proc.stderr!r}")

    # 7/8. plan_item 只进 morning, summary_item 只进 evening（dc_notify publish slot）
    from dc_notify import NotifyEngine, MockSender
    from test_dc_notify import MockAudit
    engine = NotifyEngine(data_dir=Path(tempfile.mkdtemp(prefix="dc-notify-slot-")),
                          sender=MockSender(), audit=MockAudit())
    engine.set_route("slotco", "oc_slot_123")
    p1 = engine.publish("slotco", "plan_item", {"x": 1})
    p2 = engine.publish("slotco", "summary_item", {"x": 1})
    pend = engine.store.read_pending()
    slots = {r["notification_id"]: r.get("slot") for r in pend}
    check("7/8. plan_item→morning, summary_item→evening",
          slots[p1["notification_id"]] == "morning"
          and slots[p2["notification_id"]] == "evening",
          str(slots))

    # 9. 不触碰邮件回复、IQ、自动回复和缺材料通知文件（源码无引用）
    import subprocess
    src_campaign = Path("dc_campaign.py").read_text()
    src_cycle = Path("dc_daily_cycle.py").read_text()
    forbidden = ["dc_webhook_handler", "dc_webhook_poll", "dc_iq_engine",
                 "email_gateway", "build_feishu_notice", "maybe_send_feishu_notice"]
    touched = [f for f in forbidden if f in src_campaign or f in src_cycle]
    check("9. 不触碰邮件/IQ/自动回复/缺材料通知文件", not touched, str(touched))

    # 10. 全程不真实发送 + 不注册 Cron
    from dc_notify import FeishuSender
    fs = FeishuSender()
    check("10. 不真实发送（FeishuSender 默认 disabled）+ dry-run",
          fs.enabled is False and morning["status"] == "planned"
          and e1["notify"] is None,  # dry_run 下不 emit
          f"feishu_enabled={fs.enabled}")

    print("=" * 70)
    print(f"\n结果：{len(passed)} passed, {len(failures)} failed")
    if failures:
        print("失败项：", failures)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
