#!/usr/bin/env python3
"""test_marketing_automation_runner.py — 展会自动营销编排层单元测试。

覆盖：memory 组装（leads+followup+invitations+interactions+meta）/
到场状态注入 / 决策落库 / dry_run 不落库 / 单活跃互斥 / 脱敏摘要。
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_marketing_automation_runner import (  # noqa: E402
    assemble_opportunities,
    run_cycle,
    _customer_id_of,
)
from dc_marketing_automation import (  # noqa: E402
    load_automations,
    FIRST_INVITE,
    SECOND_INVITE,
    ONSITE_FOLLOWUP,
)


def _write(root, company_id, name, data):
    p = Path(root) / "data" / "memory" / company_id / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _lead(**kw):
    base = {
        "company": "Casa Outdoor",
        "company_cdp_id": "cdp_001",
        "website": "www.casa.mx",
        "country": "MX",
        "stage": "待触达",
        "contact_policy": "active",
        "opportunity_status": "active",
        "reply_count": 0,
    }
    base.update(kw)
    return base


def _meta(stage="live"):
    return {"exhibition_stage": stage, "exhibitions": []}


class TestAssemble(unittest.TestCase):
    def test_customer_id_cdp_priority(self):
        self.assertEqual(_customer_id_of(_lead()), "cdp_001")

    def test_customer_id_hash_fallback(self):
        self.assertEqual(_customer_id_of(_lead(company_cdp_id="", company="X", website="y.com")),
                         "c_" + __import__("hashlib").sha1(b"x|y.com").hexdigest()[:16])

    def test_assemble_with_invitation_and_status(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead()])
            _write(td, "sid", "email_followup.json", [
                {"company": "Casa Outdoor", "company_cdp_id": "cdp_001",
                 "touch_number": 2, "inbound_count": 0},
            ])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": [
                {"companyCdpId": "cdp_001", "exhibitionId": "exh_1", "sendTime": "2026-08-01T00:00:00Z"},
            ]})
            _write(td, "sid", "interactions.json", [])
            _write(td, "sid", "meta.json", _meta())

            inputs = assemble_opportunities("sid", workspace_root=td,
                                            invitation_statuses=[
                                                {"companyCdpId": "cdp_001", "isCheckIn": 3, "isMeeting": 0},
                                            ])
            self.assertEqual(len(inputs), 1)
            inp = inputs[0]
            self.assertEqual(inp["customer"]["touch_number"], 2)
            self.assertEqual(inp["invitation"]["isCheckIn"], 3)
            self.assertEqual(inp["invitation"]["exhibitionId"], "exh_1")


class TestRunCycle(unittest.TestCase):
    def test_first_invite_uninvited(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead()])
            _write(td, "sid", "email_followup.json", [])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
            _write(td, "sid", "interactions.json", [])
            _write(td, "sid", "meta.json", _meta("live"))

            r = run_cycle("sid", workspace_root=td, dry_run=True)
            self.assertEqual(r["scanned"], 1)
            self.assertEqual(r["tasks_created"], 1)
            self.assertEqual(r["tasks"][0]["action"], FIRST_INVITE)

    def test_second_invite_arrived_status_3(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead(stage="已邀约")])
            _write(td, "sid", "email_followup.json", [])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": [
                {"companyCdpId": "cdp_001", "exhibitionId": "exh_1", "sendTime": "2026-08-01T00:00:00Z"},
            ]})
            _write(td, "sid", "interactions.json", [])
            _write(td, "sid", "meta.json", _meta("live"))

            r = run_cycle("sid", workspace_root=td, dry_run=True,
                           invitation_statuses=[
                               {"companyCdpId": "cdp_001", "isCheckIn": 3},
                           ])
            self.assertEqual(r["tasks"][0]["action"], SECOND_INVITE)

    def test_onsite_followup_arrived_with_meeting(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead(stage="已触达")])
            _write(td, "sid", "email_followup.json", [])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": [
                {"companyCdpId": "cdp_001", "exhibitionId": "exh_1", "sendTime": "2026-08-01T00:00:00Z"},
            ]})
            _write(td, "sid", "interactions.json", [
                {"interaction_id": "it_1", "customer_id": "cdp_001", "source": "meeting",
                 "channel": "meeting", "summary": "要样品"},
            ])
            _write(td, "sid", "meta.json", _meta("live"))

            r = run_cycle("sid", workspace_root=td, dry_run=True,
                           invitation_statuses=[
                               {"companyCdpId": "cdp_001", "isCheckIn": 1, "isMeeting": 1},
                           ])
            self.assertEqual(r["tasks"][0]["action"], ONSITE_FOLLOWUP)

    def test_dry_run_does_not_persist(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead()])
            _write(td, "sid", "email_followup.json", [])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
            _write(td, "sid", "interactions.json", [])
            _write(td, "sid", "meta.json", _meta("live"))

            run_cycle("sid", workspace_root=td, dry_run=True)
            data = load_automations("sid", workspace_root=td)
            self.assertEqual(data["automations"], [])

    def test_activate_persists_single_active(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead()])
            _write(td, "sid", "email_followup.json", [])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
            _write(td, "sid", "interactions.json", [])
            _write(td, "sid", "meta.json", _meta("live"))

            r = run_cycle("sid", workspace_root=td, dry_run=False)
            self.assertEqual(r["tasks"][0]["activated"], True)
            data = load_automations("sid", workspace_root=td)
            actives = [a for a in data["automations"] if a["status"] == "active"]
            self.assertEqual(len(actives), 1)
            self.assertEqual(actives[0]["action"], FIRST_INVITE)

    def test_rerun_no_duplicate_active(self):
        """第二次跑：同一 opportunity 已有 active → 不重复落库。"""
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead()])
            _write(td, "sid", "email_followup.json", [])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
            _write(td, "sid", "interactions.json", [])
            _write(td, "sid", "meta.json", _meta("live"))

            run_cycle("sid", workspace_root=td, dry_run=False)
            r2 = run_cycle("sid", workspace_root=td, dry_run=False)
            # 第二次扫描：同一 opp 已有 active → evaluate 返回 none → skipped_active
            self.assertEqual(r2["tasks_created"], 0)
            self.assertEqual(r2["skipped_active"], 1)
            data = load_automations("sid", workspace_root=td)
            actives = [a for a in data["automations"] if a["status"] == "active"]
            self.assertEqual(len(actives), 1)


class TestSummary(unittest.TestCase):
    def test_summary_by_action(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [
                _lead(),
                _lead(company="B", company_cdp_id="cdp_002"),
            ])
            _write(td, "sid", "email_followup.json", [])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
            _write(td, "sid", "interactions.json", [])
            _write(td, "sid", "meta.json", _meta("live"))

            r = run_cycle("sid", workspace_root=td, dry_run=True)
            self.assertEqual(r["scanned"], 2)
            self.assertEqual(r["tasks_created"], 2)
            self.assertEqual(r["by_action"][FIRST_INVITE], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
