#!/usr/bin/env python3
"""test_marketing_automation_send.py — 内容生成 + 发送桥接单元测试。

覆盖：build_content_task / 正文写入 / 发送成功→关闭 automation / 空正文拦截 /
requires_approval 待确认 / dry_run / 批量编排。
generator 与 send_fn 均注入，不触真实发送。
"""

import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_marketing_automation import (  # noqa: E402
    activate_automation,
    load_automations,
    SECOND_INVITE,
    ONSITE_FOLLOWUP,
)
from dc_marketing_automation_send import (  # noqa: E402
    build_content_task,
    send_one,
    run_send_cycle,
    list_pending_marketing_drafts,
)


def _activate(td, action=SECOND_INVITE):
    act = activate_automation("sid", {
        "opportunity_id": "cdp_1",
        "customer_id": "cdp_1",
        "action": action,
        "idempotency_key": f"{action}:cdp_1",
    }, workspace_root=td)
    return act["record"]["automation_id"]


def _make_draft(td, automation_id, **kw):
    from dc_email_controller.dc_reply_draft import record_draft
    base = {
        "draft_id": "am_test1",
        "company_id": "sid",
        "buyer_email": "buyer@x.com",
        "subject": "Invitation",
        "text": "",
        "status": "pending_confirmation",
        "missing_fields": [],
        "automation_id": automation_id,
        "automation_action": SECOND_INVITE,
        "automation_requires_approval": False,
        "content_route": "dealclaw-exhibition-invitation",
        "company_name": "Casa Outdoor",
        "exhibition_name": "Mexico Expo",
    }
    base.update(kw)
    record_draft(base)
    return base["draft_id"]


def _gen(task):
    return {"subject": "S", "text": f"Hello from {task['content_route']}"}


def _send_ok(draft_id, confirmed_by=""):
    return {"status": "sent", "draft_id": draft_id, "resend_id": "re_123"}


class TestBuildTask(unittest.TestCase):
    def test_task_fields(self):
        d = {"draft_id": "am_x", "automation_action": SECOND_INVITE,
             "content_route": "dealclaw-exhibition-invitation",
             "company_id": "sid", "company_name": "C", "buyer_email": "b@x.com",
             "exhibition_name": "E", "subject": "S", "automation_requires_approval": False,
             "automation_id": "am_1"}
        t = build_content_task(d)
        self.assertEqual(t["content_route"], "dealclaw-exhibition-invitation")
        self.assertEqual(t["buyer_email"], "b@x.com")
        self.assertFalse(t["requires_approval"])


class TestSendOne(unittest.TestCase):
    def test_success_writes_text_and_completes(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch.dict(os.environ, {"DC_DATA_DIR": td}):
                aid = _activate(td)
                did = _make_draft(td, aid)
                r = send_one("sid", did, _gen, send_fn=_send_ok, workspace_root=td)
                self.assertEqual(r["status"], "sent")
                # 正文已写回草稿
                from dc_email_controller.dc_reply_draft import get_draft
                self.assertIn("dealclaw-exhibition-invitation", get_draft(did)["text"])
                # automation 已关闭
                data = load_automations("sid", workspace_root=td)
                a = [x for x in data["automations"] if x["automation_id"] == aid][0]
                self.assertEqual(a["status"], "completed")
                self.assertEqual(a["execution_ref"], "re_123")

    def test_empty_content_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch.dict(os.environ, {"DC_DATA_DIR": td}):
                aid = _activate(td)
                did = _make_draft(td, aid)
                r = send_one("sid", did, lambda t: {"text": "   "},
                             send_fn=_send_ok, workspace_root=td)
                self.assertEqual(r["status"], "error")
                self.assertEqual(r["error"], "empty_content")

    def test_already_sent_skipped(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch.dict(os.environ, {"DC_DATA_DIR": td}):
                aid = _activate(td)
                did = _make_draft(td, aid, status="sent")
                r = send_one("sid", did, _gen, send_fn=_send_ok, workspace_root=td)
                self.assertEqual(r["status"], "skip")


class TestRunCycle(unittest.TestCase):
    def test_requires_approval_pending(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch.dict(os.environ, {"DC_DATA_DIR": td}):
                aid = _activate(td)
                _make_draft(td, aid, automation_requires_approval=True)
                r = run_send_cycle("sid", _gen, send_fn=_send_ok,
                                   workspace_root=td, dry_run=False)
                self.assertEqual(r["pending_approval"], 1)
                self.assertEqual(r["sent"], 0)

    def test_dry_run_no_send(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch.dict(os.environ, {"DC_DATA_DIR": td}):
                aid = _activate(td)
                _make_draft(td, aid)
                r = run_send_cycle("sid", _gen, send_fn=_send_ok,
                                   workspace_root=td, dry_run=True)
                self.assertEqual(r["sent"], 0)
                self.assertEqual(r["results"][0]["disposition"], "would_send_dry_run")

    def test_auto_send_success(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch.dict(os.environ, {"DC_DATA_DIR": td}):
                aid = _activate(td)
                _make_draft(td, aid)
                r = run_send_cycle("sid", _gen, send_fn=_send_ok,
                                   workspace_root=td, dry_run=False)
                self.assertEqual(r["sent"], 1)
                self.assertEqual(r["results"][0]["disposition"], "sent")
                data = load_automations("sid", workspace_root=td)
                self.assertEqual(data["automations"][0]["status"], "completed")

    def test_list_pending_only_marketing(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch.dict(os.environ, {"DC_DATA_DIR": td}):
                aid = _activate(td)
                _make_draft(td, aid)
                # 一条非营销草稿（无 automation_id）不应被列出
                from dc_email_controller.dc_reply_draft import record_draft
                record_draft({"draft_id": "plain_1", "company_id": "sid",
                              "buyer_email": "x@y.com", "status": "pending_confirmation",
                              "missing_fields": [], "text": "hi"})
                drafts = list_pending_marketing_drafts("sid")
                self.assertEqual(len(drafts), 1)
                self.assertEqual(drafts[0]["automation_id"], aid)


if __name__ == "__main__":
    unittest.main(verbosity=2)
