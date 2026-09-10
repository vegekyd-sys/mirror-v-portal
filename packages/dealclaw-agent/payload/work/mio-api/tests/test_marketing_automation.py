#!/usr/bin/env python3
"""test_marketing_automation.py — 展会自动营销决策单元测试。

覆盖：五动作分流 / 排除层 / 单活跃互斥 / 频控（二次邀约） / nurture 阈值 /
幂等键稳定 / 无副作用（不写文件、不改输入）。
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_marketing_automation import (  # noqa: E402
    evaluate_next_action,
    activate_automation,
    complete_automation,
    load_automations,
    automations_path,
    FIRST_INVITE,
    SECOND_INVITE,
    ONSITE_FOLLOWUP,
    MISSED_MEETING_REENGAGE,
    NURTURE,
    NONE,
)


def cust(**kw):
    base = {"companyCdpId": "cdp_001", "companyName": "Casa Outdoor", "contact_policy": "active"}
    base.update(kw)
    return base


def opp(**kw):
    base = {"opportunity_id": "opp_001", "opportunity_status": "active", "stage": "待触达"}
    base.update(kw)
    return base


def inv(**kw):
    base = {
        "companyCdpId": "cdp_001",
        "companyName": "Casa Outdoor",
        "exhibitionId": "exh_2026_mexico",
        "sendTime": "2026-08-01T00:00:00+00:00",
        "inviationState": 4,   # 已接受
        "isCheckIn": 3,        # 未到展
        "isMeeting": 0,
    }
    base.update(kw)
    return base


def meta(**kw):
    base = {"exhibition_stage": "live"}
    base.update(kw)
    return base


def meeting_interaction():
    return {
        "interaction_id": "it_meeting_001",
        "source": "meeting",
        "channel": "meeting",
        "direction": "",
        "summary": "谈了户外家具，要样品",
        "raw_record_ref": "raw/meeting/n1.txt",
        "signals": [{"type": "product_need", "value": "outdoor furniture"}],
    }


class TestFirstInvite(unittest.TestCase):
    def test_uninvited_live_stage(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(), invitation=None,
                                 interactions=[], meta=meta(exhibition_stage="live"))
        self.assertEqual(r["action"], FIRST_INVITE)
        self.assertTrue(r["requires_approval"])
        self.assertEqual(r["idempotency_key"], f"first_invite:opp_001")

    def test_uninvited_inviting_stage(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(), invitation=None,
                                 interactions=[], meta=meta(exhibition_stage="inviting"))
        self.assertEqual(r["action"], FIRST_INVITE)

    def test_uninvited_followup_stage_no_action(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(), invitation=None,
                                 interactions=[], meta=meta(exhibition_stage="followup"))
        self.assertEqual(r["action"], NONE)
        self.assertIn("首邀阶段", r["reason"])


class TestSecondInvite(unittest.TestCase):
    def test_invited_not_arrived_live(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(), invitation=inv(isCheckIn=3),
                                 interactions=[], meta=meta(exhibition_stage="live"))
        self.assertEqual(r["action"], SECOND_INVITE)
        self.assertFalse(r["requires_approval"])
        self.assertEqual(r["idempotency_key"], f"second_invite:opp_001")

    def test_invited_pending_arrival_live(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(), invitation=inv(isCheckIn=2),
                                 interactions=[], meta=meta(exhibition_stage="live"))
        self.assertEqual(r["action"], SECOND_INVITE)

    def test_second_invite_used_up_no_action(self):
        state = {"automations": [
            {"automation_id": "am_1", "opportunity_id": "opp_001", "action": SECOND_INVITE,
             "status": "completed", "idempotency_key": f"{SECOND_INVITE}:opp_001"},
        ]}
        r = evaluate_next_action(customer=cust(), opportunity=opp(), invitation=inv(isCheckIn=3),
                                 interactions=[], meta=meta(exhibition_stage="live"),
                                 automation_state=state)
        self.assertEqual(r["action"], NONE)
        self.assertIn("二次邀约已用尽", r["reason"])

    def test_second_invite_not_in_live_stage(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(), invitation=inv(isCheckIn=3),
                                 interactions=[], meta=meta(exhibition_stage="followup"))
        self.assertEqual(r["action"], NONE)


class TestOnsiteFollowup(unittest.TestCase):
    def test_arrived_with_meeting(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(),
                                 invitation=inv(isCheckIn=1, isMeeting=1),
                                 interactions=[meeting_interaction()],
                                 meta=meta(exhibition_stage="live"))
        self.assertEqual(r["action"], ONSITE_FOLLOWUP)
        self.assertFalse(r["requires_approval"])

    def test_arrived_meeting_interaction_only(self):
        # isMeeting 未标 1，但 interaction 有 meeting 且 summary 非空
        r = evaluate_next_action(customer=cust(), opportunity=opp(),
                                 invitation=inv(isCheckIn=1, isMeeting=0),
                                 interactions=[meeting_interaction()],
                                 meta=meta(exhibition_stage="live"))
        self.assertEqual(r["action"], ONSITE_FOLLOWUP)

    def test_arrived_no_meeting_reengage(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(),
                                 invitation=inv(isCheckIn=1, isMeeting=0),
                                 interactions=[], meta=meta(exhibition_stage="live"))
        self.assertEqual(r["action"], MISSED_MEETING_REENGAGE)
        self.assertFalse(r["requires_approval"])


class TestNurture(unittest.TestCase):
    def test_nurture_after_three_touches_no_reply(self):
        r = evaluate_next_action(customer=cust(touch_number=3), opportunity=opp(),
                                 invitation=inv(isCheckIn=3),
                                 interactions=[], meta=meta(exhibition_stage="followup"))
        self.assertEqual(r["action"], NURTURE)
        self.assertFalse(r["requires_approval"])

    def test_no_nurture_if_replied(self):
        r = evaluate_next_action(customer=cust(touch_number=3, has_reply=True), opportunity=opp(),
                                 invitation=inv(isCheckIn=3),
                                 interactions=[], meta=meta(exhibition_stage="followup"))
        self.assertNotEqual(r["action"], NURTURE)

    def test_below_threshold_no_nurture(self):
        r = evaluate_next_action(customer=cust(touch_number=2), opportunity=opp(),
                                 invitation=inv(isCheckIn=3),
                                 interactions=[], meta=meta(exhibition_stage="live"))
        # touch=2 < 3，未到 nurture；live 阶段且二次邀约未用尽 → second_invite
        self.assertEqual(r["action"], SECOND_INVITE)


class TestExclusion(unittest.TestCase):
    def test_do_not_contact(self):
        r = evaluate_next_action(customer=cust(contact_policy="do_not_contact"),
                                 opportunity=opp(), invitation=inv(isCheckIn=3),
                                 interactions=[], meta=meta(exhibition_stage="live"))
        self.assertEqual(r["action"], NONE)
        self.assertEqual(r["excluded_reason"], "do_not_contact")

    def test_opportunity_won(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(opportunity_status="won"),
                                 invitation=inv(isCheckIn=3),
                                 interactions=[], meta=meta(exhibition_stage="live"))
        self.assertEqual(r["action"], NONE)
        self.assertEqual(r["excluded_reason"], "opportunity_status_won")

    def test_invitation_rejected(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(),
                                 invitation=inv(isCheckIn=3, inviationState=3),
                                 interactions=[], meta=meta(exhibition_stage="live"))
        self.assertEqual(r["action"], NONE)
        self.assertEqual(r["excluded_reason"], "invitation_rejected")

    def test_invitation_unreachable(self):
        r = evaluate_next_action(customer=cust(), opportunity=opp(),
                                 invitation=inv(inviationState=2),
                                 interactions=[], meta=meta(exhibition_stage="live"))
        self.assertEqual(r["action"], NONE)
        self.assertEqual(r["excluded_reason"], "invitation_unreachable")


class TestSingleActive(unittest.TestCase):
    def test_active_automation_blocks(self):
        state = {"automations": [
            {"automation_id": "am_1", "opportunity_id": "opp_001", "action": ONSITE_FOLLOWUP,
             "status": "active", "idempotency_key": f"{ONSITE_FOLLOWUP}:opp_001"},
        ]}
        r = evaluate_next_action(customer=cust(), opportunity=opp(),
                                 invitation=inv(isCheckIn=1, isMeeting=1),
                                 interactions=[meeting_interaction()],
                                 meta=meta(exhibition_stage="live"),
                                 automation_state=state)
        self.assertEqual(r["action"], NONE)
        self.assertIn("active automation", r["reason"])


class TestIdempotencyKey(unittest.TestCase):
    def test_key_stable_across_content_change(self):
        r1 = evaluate_next_action(customer=cust(), opportunity=opp(), invitation=inv(isCheckIn=3),
                                  interactions=[], meta=meta(exhibition_stage="live"))
        r2 = evaluate_next_action(customer=cust(companyName="Renamed"), opportunity=opp(),
                                  invitation=inv(isCheckIn=3, companyName="Renamed"),
                                  interactions=[], meta=meta(exhibition_stage="live"))
        self.assertEqual(r1["idempotency_key"], r2["idempotency_key"])


class TestPureFunction(unittest.TestCase):
    def test_no_side_effects(self):
        """输入对象在调用后不被修改（无副作用）。"""
        c = cust()
        o = opp()
        i = inv(isCheckIn=3)
        its = []
        c_snapshot = json.dumps(c, sort_keys=True)
        o_snapshot = json.dumps(o, sort_keys=True)
        i_snapshot = json.dumps(i, sort_keys=True)
        evaluate_next_action(customer=c, opportunity=o, invitation=i, interactions=its,
                             meta=meta(exhibition_stage="live"))
        self.assertEqual(json.dumps(c, sort_keys=True), c_snapshot)
        self.assertEqual(json.dumps(o, sort_keys=True), o_snapshot)
        self.assertEqual(json.dumps(i, sort_keys=True), i_snapshot)


class TestStore(unittest.TestCase):
    def test_activate_single_active(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            activate_automation("sid_test", {
                "opportunity_id": "opp_001", "customer_id": "cdp_001",
                "action": ONSITE_FOLLOWUP, "idempotency_key": f"{ONSITE_FOLLOWUP}:opp_001",
            }, workspace_root=td)
            activate_automation("sid_test", {
                "opportunity_id": "opp_001", "customer_id": "cdp_001",
                "action": NURTURE, "idempotency_key": f"{NURTURE}:opp_001",
            }, workspace_root=td)
            data = load_automations("sid_test", workspace_root=td)
            actives = [a for a in data["automations"] if a["status"] == "active"]
            self.assertEqual(len(actives), 1)
            self.assertEqual(actives[0]["action"], NURTURE)

    def test_complete_automation(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            activate_automation("sid_test", {
                "opportunity_id": "opp_001", "customer_id": "cdp_001",
                "action": ONSITE_FOLLOWUP, "idempotency_key": f"{ONSITE_FOLLOWUP}:opp_001",
            }, workspace_root=td)
            data = load_automations("sid_test", workspace_root=td)
            aid = data["automations"][0]["automation_id"]
            r = complete_automation("sid_test", aid, status="completed",
                                    execution_ref="draft_xyz", workspace_root=td)
            self.assertTrue(r["ok"])
            self.assertEqual(r["record"]["execution_ref"], "draft_xyz")

    def test_automations_not_copy_content(self):
        """automations.json 只存引用，不存正文。"""
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            activate_automation("sid_test", {
                "opportunity_id": "opp_001", "customer_id": "cdp_001",
                "action": ONSITE_FOLLOWUP, "idempotency_key": f"{ONSITE_FOLLOWUP}:opp_001",
            }, workspace_root=td)
            raw = automations_path("sid_test", workspace_root=td).read_text(encoding="utf-8")
            # 不含邮件正文字段
            self.assertNotIn("subject", raw.split("automations")[0] if "automations" in raw else raw)
            data = json.loads(raw)
            rec = data["automations"][0]
            for forbidden in ("email_body", "html", "text", "content"):
                self.assertNotIn(forbidden, rec)


if __name__ == "__main__":
    unittest.main(verbosity=2)
