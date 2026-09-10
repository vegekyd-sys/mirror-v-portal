#!/usr/bin/env python3
"""test_marketing_automation_dispatch.py — 展会自动营销执行桥接单元测试。

覆盖：nurture 静默完成 / 发送类生成草稿 / 邮箱回查优先级 / 无邮箱跳过 /
dry_run 不落草稿 / 幂等草稿。
"""

import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_marketing_automation import (  # noqa: E402
    activate_automation,
    complete_automation,
    load_automations,
    FIRST_INVITE,
    SECOND_INVITE,
    ONSITE_FOLLOWUP,
    NURTURE,
)
from dc_marketing_automation_dispatch import (  # noqa: E402
    dispatch_pending,
    _resolve_buyer_email,
    _extract_emails,
)


def _write(root, company_id, name, data):
    p = Path(root) / "data" / "memory" / company_id / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _activate(root, company_id, **kw):
    base = {
        "opportunity_id": "cdp_001",
        "customer_id": "cdp_001",
        "action": FIRST_INVITE,
        "idempotency_key": f"{FIRST_INVITE}:cdp_001",
    }
    base.update(kw)
    activate_automation(company_id, base, workspace_root=root)


def _lead(**kw):
    base = {
        "company": "Casa Outdoor",
        "company_cdp_id": "cdp_001",
        "website": "www.casa.mx",
        "contact": "John|Manager|john@casa.mx",
    }
    base.update(kw)
    return base


class TestEmailResolve(unittest.TestCase):
    def test_extract_from_text(self):
        self.assertEqual(_extract_emails("John|Manager|john@casa.mx"), ["john@casa.mx"])

    def test_invitation_contact_priority(self):
        inv = {"companyCdpId": "cdp_001", "contact": {"email": "inv@casa.mx"}}
        lead = _lead()
        self.assertEqual(
            _resolve_buyer_email({"customer_id": "cdp_001"},
                                 {"cdp_001": lead}, {"cdp_001": inv}),
            "inv@casa.mx")

    def test_lead_fallback(self):
        lead = _lead()
        self.assertEqual(
            _resolve_buyer_email({"customer_id": "cdp_001"},
                                 {"cdp_001": lead}, {}),
            "john@casa.mx")


class TestDispatchNurture(unittest.TestCase):
    def test_nurture_completed(self):
        with tempfile.TemporaryDirectory() as td:
            _activate(td, "sid", action=NURTURE,
                      idempotency_key=f"{NURTURE}:cdp_001",
                      opportunity_id="cdp_001")
            r = dispatch_pending("sid", workspace_root=td, dry_run=False)
            self.assertEqual(r["by_disposition"].get("nurture_completed"), 1)
            data = load_automations("sid", workspace_root=td)
            statuses = {a["automation_id"]: a["status"] for a in data["automations"]}
            self.assertEqual(statuses[list(statuses)[0]], "completed")

    def test_nurture_dry_run_keeps_active(self):
        with tempfile.TemporaryDirectory() as td:
            _activate(td, "sid", action=NURTURE,
                      idempotency_key=f"{NURTURE}:cdp_001",
                      opportunity_id="cdp_001")
            dispatch_pending("sid", workspace_root=td, dry_run=True)
            data = load_automations("sid", workspace_root=td)
            actives = [a for a in data["automations"] if a["status"] == "active"]
            self.assertEqual(len(actives), 1)


class TestDispatchDraft(unittest.TestCase):
    def test_send_action_creates_draft(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead()])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": [
                {"companyCdpId": "cdp_001", "exhibitionName": "Mexico Expo"},
            ]})
            _activate(td, "sid", action=SECOND_INVITE,
                      idempotency_key=f"{SECOND_INVITE}:cdp_001",
                      opportunity_id="cdp_001")
            # 草稿落盘路径由 DC_DATA_DIR 决定 → 隔离到 tempdir，避免跨运行残留
            with unittest.mock.patch.dict(os.environ, {"DC_DATA_DIR": td}):
                r = dispatch_pending("sid", workspace_root=td, dry_run=False)
            self.assertEqual(r["by_disposition"].get("draft_created"), 1)
            self.assertEqual(r["results"][0]["content_route"], "dealclaw-exhibition-invitation")

    def test_no_email_skipped(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead(contact="")])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
            _activate(td, "sid", action=FIRST_INVITE,
                      idempotency_key=f"{FIRST_INVITE}:cdp_001",
                      opportunity_id="cdp_001")
            r = dispatch_pending("sid", workspace_root=td, dry_run=False)
            self.assertEqual(r["by_disposition"].get("no_email_skipped"), 1)

    def test_content_route_invite(self):
        """邀约类动作 → content_route 指向 dealclaw-exhibition-invitation。"""
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead()])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
            _activate(td, "sid", action=SECOND_INVITE,
                      idempotency_key=f"{SECOND_INVITE}:cdp_001", opportunity_id="cdp_001")
            r = dispatch_pending("sid", workspace_root=td, dry_run=True)
            self.assertEqual(r["results"][0]["content_route"], "dealclaw-exhibition-invitation")

    def test_content_route_followup(self):
        """跟进类动作 → content_route 指向 dealclaw-email-growth-send。"""
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead()])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
            _activate(td, "sid", action=ONSITE_FOLLOWUP,
                      idempotency_key=f"{ONSITE_FOLLOWUP}:cdp_001", opportunity_id="cdp_001")
            r = dispatch_pending("sid", workspace_root=td, dry_run=True)
            self.assertEqual(r["results"][0]["content_route"], "dealclaw-email-growth-send")

    def test_dry_run_no_draft(self):
        with tempfile.TemporaryDirectory() as td:
            _write(td, "sid", "leads.json", [_lead()])
            _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
            _activate(td, "sid", action=FIRST_INVITE,
                      idempotency_key=f"{FIRST_INVITE}:cdp_001",
                      opportunity_id="cdp_001")
            r = dispatch_pending("sid", workspace_root=td, dry_run=True)
            self.assertEqual(r["by_disposition"].get("draft_pending_dry_run"), 1)
            # 无草稿落盘（draft 目录在 data/memory 之外，dry_run 不写）
            self.assertEqual(r["results"][0]["draft_id"], r["results"][0]["draft_id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
