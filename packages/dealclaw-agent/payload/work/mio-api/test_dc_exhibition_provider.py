#!/usr/bin/env python3
"""test_dc_exhibition_provider.py — ExhibitionProvider 五阶段测试（标准库 unittest）

覆盖需求 1-9：
  - 五阶段各自输出 result/action/risk/insight
  - 规则 3：只允许本届展会买家进入候选（线索池不扩充范围）
  - 规则 4：展前专项卡已提醒 → 早报只摘要；逾期/状态变化仍进重点
  - 规则 5：开展后停止展前进度提醒，切换到场/会议/现场承诺
  - 规则 6：闭展后未到场 → 未会面再激活（不生成二次邀约）
  - 规则 7：数据未同步不得报 0，输出数据质量风险
  - 规则 8：跨 Provider 去重保留证据更完整 action
  - 规则 9：跨时区 / 阶段切换 / 当前展会范围 / 跨 Provider 去重

运行：cd work/mio-api && python3 test_dc_exhibition_provider.py
"""
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_daily_brief import BriefContext, make_dedupe_key  # noqa: E402
from dc_exhibition_provider import (  # noqa: E402
    ExhibitionProvider, resolve_current_exhibition, resolve_stage,
)
from dc_daily_pipeline import dedupe_cross_provider  # noqa: E402

COMPANY = "152600996207"
EXH = "E1"


def d(delta):
    return (datetime.now(timezone.utc) + timedelta(days=delta)).date().isoformat()


def ctx(report_type="morning"):
    return BriefContext(tenant="meorient", company=COMPANY, report_type=report_type,
                        date=d(0), tz="Asia/Shanghai", as_of=datetime.now(timezone.utc).isoformat(),
                        window_start="", window_end="")


def meta(stage, start, end, tz="Asia/Shanghai", understanding_done=False, plan_done=False):
    return {"exhibition_stage": stage, "understanding_done": understanding_done,
            "plan_done": plan_done,
            "exhibitions": [{"exhibition_id": EXH, "name": "巴西展", "start": start,
                             "end": end, "timezone": tz}]}


def inv(cdp, company, checkin=0, meeting=0, state=0, exh_id=EXH, email=""):
    return {"companyCdpId": cdp, "companyName": company, "country": "BR",
            "website": f"{cdp}.example", "exhibitionId": exh_id, "sendTime": d(-3),
            "isCheckIn": checkin, "isMeeting": meeting, "inviationState": state,
            "email": email or f"{cdp}@x.com"}


def sync(records=10, status="completed", exh_id=EXH, through="2030-01-01T00:00:00Z"):
    return {"exhibition_id": exh_id, "status": status, "synced_through": through,
            "records": records}


class FakeStore:
    def __init__(self, meta_d, invitations=None, interactions=None, sync_d=None):
        self._meta, self._inv, self._inter, self._sync = meta_d, invitations or [], interactions or [], sync_d

    def read_meta(self, cid):
        return self._meta

    def list_invitations(self, cid, exh_id=""):
        return self._inv

    def list_interactions(self, cid):
        return self._inter

    def read_sync(self, cid, exh_id=""):
        return self._sync if self._sync is not None else {}


def kinds(items):
    return {i.kind for i in items}


# ── 五阶段四类输出 ──────────────────────────────────────────
class TestFiveStages(unittest.TestCase):
    def _collect(self, stage, start, end, invitations, sync_d, interactions=None, **mk):
        store = FakeStore(meta(stage, start, end, **mk), invitations,
                          interactions or [], sync_d)
        return ExhibitionProvider(store=store).collect(ctx())

    def test_profiling(self):
        res = self._collect("profiling", d(10), d(12), [], None)
        self.assertTrue({"result", "action", "risk", "insight"} <= kinds(res.items))
        self.assertTrue(any(i.category == "stage_profiling" for i in res.items))

    def test_planning(self):
        res = self._collect("planning", d(10), d(12), [], None)
        self.assertTrue({"result", "action", "risk", "insight"} <= kinds(res.items))
        self.assertTrue(any(i.category == "stage_planning" for i in res.items))

    def test_inviting(self):
        invs = [inv("C1", "A Co"), inv("C2", "B Co", state=3)]  # 一家拒绝 → risk
        res = self._collect("inviting", d(10), d(12), invs, sync(2))
        self.assertTrue({"result", "action", "risk", "insight"} <= kinds(res.items))
        self.assertTrue(any(i.category == "stage_inviting" for i in res.items))

    def test_live(self):
        invs = [inv("C1", "A Co", checkin=1, meeting=1), inv("C2", "B Co", checkin=1, state=3)]
        res = self._collect("live", d(-1), d(1), invs, sync(2))
        self.assertTrue({"result", "action", "risk", "insight"} <= kinds(res.items))

    def test_followup(self):
        invs = [inv("C1", "A Co", checkin=3), inv("C2", "B Co", checkin=1),
                inv("C3", "Rejected Co", state=3)]
        res = self._collect("followup", d(-5), d(-3), invs, sync(3))
        self.assertTrue({"result", "action", "risk", "insight"} <= kinds(res.items))


# ── 规则 3：本届范围 ────────────────────────────────────────
class TestScope(unittest.TestCase):
    def test_out_of_scope_excluded(self):
        invs = [inv("C1", "In Scope", exh_id=EXH), inv("C9", "Other", exh_id="OTHER")]
        store = FakeStore(meta("inviting", d(10), d(12)), invs, [], sync(2))
        res = ExhibitionProvider(store=store).collect(ctx())
        result = next(i for i in res.items if i.kind == "result")
        self.assertEqual(result.detail["invited"], 1)  # 只有本届进入

    def test_no_exhibition_id_not_in_scope(self):
        invs = [inv("C1", "NoId", exh_id="")]
        store = FakeStore(meta("inviting", d(10), d(12)), invs, [], sync(2))
        res = ExhibitionProvider(store=store).collect(ctx())
        self.assertEqual(next(i for i in res.items if i.kind == "result").detail["invited"], 0)


# ── 规则 4：专项卡已提醒 → 只摘要；逾期/状态变化仍进重点 ────
class TestReminded(unittest.TestCase):
    def _stage_key(self, stage):
        return make_dedupe_key(source="exhibition", category=f"stage_{stage}", scope=EXH,
                               business_id=f"stage:{EXH}:{stage}", occurrence="1")

    def test_reminded_stage_action_demoted_to_summary(self):
        key = self._stage_key("planning")
        store = FakeStore(meta("planning", d(10), d(12)), [], [], None)
        res = ExhibitionProvider(store=store, reminded_keys=[key]).collect(ctx())
        stage_items = [i for i in res.items if i.category == "stage_planning"]
        self.assertEqual(stage_items[0].kind, "insight")
        self.assertTrue(stage_items[0].detail.get("reminded"))

    def test_not_reminded_keeps_action(self):
        store = FakeStore(meta("planning", d(10), d(12)), [], [], None)
        res = ExhibitionProvider(store=store).collect(ctx())
        stage_items = [i for i in res.items if i.category == "stage_planning"]
        self.assertEqual(stage_items[0].kind, "action")

    def test_overdue_still_action(self):
        provider = ExhibitionProvider()
        from dc_exhibition_provider import ExhibitionProvider as EP
        store = FakeStore(meta("planning", d(10), d(12)), [], [], None)
        key = self._stage_key("planning")
        res = EP(store=store, reminded_keys=[key]).collect(ctx())
        item = next(i for i in res.items if i.category == "stage_planning")
        # 手动标记逾期 → _is_changed 为真 → 仍进重点
        item.due_at = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        self.assertTrue(EP._is_changed(item, datetime.now(timezone.utc)))


# ── 规则 5：开展后停止展前进度提醒 ──────────────────────────
class TestLiveSwitch(unittest.TestCase):
    def test_live_has_no_inviting_progress_and_uses_onsite(self):
        invs = [inv("C1", "A Co", checkin=1, meeting=1), inv("C2", "B Co", checkin=1, meeting=0)]
        store = FakeStore(meta("live", d(-1), d(1)), invs, [], sync(2))
        res = ExhibitionProvider(store=store).collect(ctx())
        cats = {i.category for i in res.items if i.kind == "action"}
        self.assertNotIn("stage_inviting", cats)     # 停止展前进度提醒
        self.assertIn("stage_live", cats)            # 切到展中
        self.assertIn("onsite_followup", cats)       # 到场+会议
        self.assertIn("missed_meeting_reengage", cats)  # 到场无会议

    def test_live_result_reports_attendance(self):
        invs = [inv("C1", "A Co", checkin=1), inv("C2", "B Co", checkin=3)]
        store = FakeStore(meta("live", d(-1), d(1)), invs, [], sync(2))
        res = ExhibitionProvider(store=store).collect(ctx())
        result = next(i for i in res.items if i.kind == "result")
        self.assertEqual(result.detail["arrived"], 1)
        self.assertEqual(result.detail["not_arrived"], 1)


# ── 规则 6：闭展未到场 → 再激活（不二次邀约） ───────────────
class TestFollowupReactivate(unittest.TestCase):
    def test_not_arrived_reactivate_no_second_invite(self):
        invs = [inv("C1", "A Co", checkin=3), inv("C2", "B Co", checkin=2),
                inv("C3", "Attended", checkin=1)]
        store = FakeStore(meta("followup", d(-5), d(-3)), invs, [], sync(3))
        res = ExhibitionProvider(store=store).collect(ctx())
        cats = {i.category for i in res.items if i.kind == "action"}
        self.assertIn("reactivate_no_meeting", cats)
        self.assertNotIn("second_invite", cats)
        react = [i for i in res.items if i.category == "reactivate_no_meeting"]
        self.assertEqual(len(react), 2)  # 只未到场


# ── 规则 7：数据未同步 ──────────────────────────────────────
class TestDataQuality(unittest.TestCase):
    def test_no_sync_reports_risk_not_zero(self):
        invs = [inv("C1", "A Co", checkin=1)]
        store = FakeStore(meta("live", d(-1), d(1)), invs, [], None)  # 无 sync
        res = ExhibitionProvider(store=store).collect(ctx())
        risks = [i for i in res.items if i.kind == "risk" and i.category == "data_quality"]
        self.assertEqual(len(risks), 1)
        result = next(i for i in res.items if i.kind == "result")
        self.assertFalse(result.detail["data_ready"])
        self.assertIn("未同步", result.title)

    def test_syncing_status_not_ready(self):
        store = FakeStore(meta("live", d(-1), d(1)), [inv("C1", "A")], [], sync(1, status="syncing"))
        res = ExhibitionProvider(store=store).collect(ctx())
        self.assertTrue(any(i.category == "data_quality" and i.kind == "risk" for i in res.items))

    def test_completed_empty_is_ready_not_risk(self):
        store = FakeStore(meta("live", d(-1), d(1)), [], [], sync(0, status="completed_empty"))
        res = ExhibitionProvider(store=store).collect(ctx())
        self.assertFalse(any(i.category == "data_quality" for i in res.items))


# ── 规则 8：跨 Provider 去重 ────────────────────────────────
class TestCrossProviderDedup(unittest.TestCase):
    def _act(self, source, category, target, n_ev):
        from dc_daily_brief import (BriefItem, CompletionRule, EvidenceRef, FactRef,
                                    TargetRef, make_action_key, make_item_key, make_dedupe_key)
        return BriefItem(
            item_key=make_item_key(tenant="t", company=COMPANY, scope="g", kind="action",
                                   source=source, category=category, business_id=target,
                                   occurrence="1"),
            kind="action",
            dedupe_key=make_dedupe_key(source=source, category=category, scope="g",
                                       business_id=target, occurrence="1"),
            source=source, scope="g", category=category, priority="commitment", title=f"{source} {category}",
            reason_facts=[FactRef(fact_id="f", kind="text", value="x")],
            reason="r", target_refs=[TargetRef(type="buyer", id=target)],
            evidence_refs=[EvidenceRef(type="record", source="s", id=f"e{i}") for i in range(n_ev)],
            due_at=datetime.now(timezone.utc).isoformat(), detail={},
            completion_rule=CompletionRule(type="followup_sent", params={"target_ids": [target]}, expected_count=1),
            action_key=make_action_key(tenant="t", company=COMPANY, scope="g", opportunity=target,
                                       action_type=category, target_id=target, occurrence="1"),
            policy_version=None)

    def test_keep_more_evidence(self):
        less = self._act("exhibition", "onsite_followup", "buyer1@x.com", 1)
        more = self._act("opportunity", "followup", "buyer1@x.com", 3)
        kept, dropped = dedupe_cross_provider([less, more])
        self.assertEqual(len(kept), 1)
        self.assertIs(kept[0], more)
        self.assertEqual(len(dropped), 1)

    def test_different_targets_kept(self):
        a = self._act("exhibition", "onsite_followup", "b1@x.com", 1)
        b = self._act("opportunity", "followup", "b2@x.com", 2)
        kept, dropped = dedupe_cross_provider([a, b])
        self.assertEqual(len(kept), 2)
        self.assertEqual(dropped, [])

    def test_non_buyer_actions_untouched(self):
        stage = self._act("exhibition", "stage_live", "E1", 1)
        stage.target_refs = []
        kept, dropped = dedupe_cross_provider([stage])
        self.assertEqual(len(kept), 1)


# ── 规则 9：跨时区 + 阶段切换 ───────────────────────────────
class TestTimezoneAndStageSwitch(unittest.TestCase):
    def test_cross_timezone_current_exhibition(self):
        # UTC 2026-09-11 20:00 = UTC+14 当地 09-12（展期内）；若误用 UTC 会判非展期
        now = datetime(2026, 9, 11, 20, 0, tzinfo=timezone.utc)
        m = {"exhibitions": [{"exhibition_id": "E1", "start": "2026-09-12",
                              "end": "2026-09-12", "timezone": "Pacific/Kiritimati"}]}
        cur = resolve_current_exhibition(m, now)
        self.assertEqual(cur["_phase"], "live")

    def test_stage_switch_changes_output(self):
        invs = [inv("C1", "A Co", checkin=1, meeting=1)]
        store_inv = FakeStore(meta("inviting", d(10), d(12)), invs, [], sync(1))
        store_live = FakeStore(meta("live", d(-1), d(1)), invs, [], sync(1))
        r1 = ExhibitionProvider(store=store_inv).collect(ctx())
        r2 = ExhibitionProvider(store=store_live).collect(ctx())
        t1 = next(i.title for i in r1.items if i.kind == "result")
        t2 = next(i.title for i in r2.items if i.kind == "result")
        self.assertNotEqual(t1, t2)
        self.assertIn("邀约", t1)      # inviting：邀约进度
        self.assertIn("到展", t2)      # live：到场/会议
        self.assertTrue(any(i.category == "onsite_followup" for i in r2.items))

    def test_resolve_stage_date_backstop(self):
        m = meta("inviting", d(-1), d(1))
        self.assertEqual(resolve_stage(m, resolve_current_exhibition(m)), "live")
        m2 = meta("live", d(-5), d(-3))
        self.assertEqual(resolve_stage(m2, resolve_current_exhibition(m2)), "followup")


if __name__ == "__main__":
    unittest.main(verbosity=2)
