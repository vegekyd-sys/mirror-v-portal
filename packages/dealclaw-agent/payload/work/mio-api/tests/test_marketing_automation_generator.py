#!/usr/bin/env python3
"""test_marketing_automation_generator.py — 正文生成器（agent 驱动）单元测试。

覆盖：skill 口径加载 / 提示组装 / CLI 输出解析 / 正文解析（含代码块与兜底）/
openclaw_generator（注入 runner）/ 端到端（generator → send_one → 关 automation）。
不触真实 agent、不发真实邮件（runner 与 send_fn 均注入）。
"""

import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_marketing_automation_generator import (  # noqa: E402
    load_skill_principles,
    build_prompt,
    extract_reply,
    parse_content,
    openclaw_generator,
)


class TestPrinciples(unittest.TestCase):
    def test_invitation_skill_loaded(self):
        p = load_skill_principles("dealclaw-exhibition-invitation")
        self.assertIn("展前邀约", p)

    def test_growth_skill_loaded(self):
        p = load_skill_principles("dealclaw-email-growth-send")
        self.assertIn("邮件内容原则", p)

    def test_unknown_route_empty(self):
        self.assertEqual(load_skill_principles("no-such-skill"), "")


class TestPrompt(unittest.TestCase):
    def test_prompt_contains_route_context_and_contract(self):
        pr = build_prompt({
            "content_route": "dealclaw-email-growth-send", "action": "onsite_followup",
            "buyer_email": "b@x.com", "company_name": "Casa", "exhibition_name": "Mexico Expo",
            "suggested_subject": "S"}, "PRINCIPLES")
        self.assertIn("dealclaw-email-growth-send", pr)
        self.assertIn("PRINCIPLES", pr)
        self.assertIn("b@x.com", pr)
        self.assertIn("Casa", pr)
        self.assertIn("JSON", pr)


class TestExtract(unittest.TestCase):
    def test_extract_from_payloads(self):
        raw = json.dumps({"result": {"payloads": [{"text": "OK"}]}})
        self.assertEqual(extract_reply(raw), "OK")

    def test_extract_bad_json(self):
        self.assertEqual(extract_reply("not-json"), "")

    def test_extract_missing_path(self):
        self.assertEqual(extract_reply(json.dumps({"result": {}})), "")


class TestParse(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(parse_content('{"subject":"S","text":"T"}'),
                         {"subject": "S", "text": "T"})

    def test_codefence(self):
        self.assertEqual(parse_content('```json\n{"subject":"S","text":"T"}\n```'),
                         {"subject": "S", "text": "T"})

    def test_json_embedded_in_text(self):
        self.assertEqual(parse_content('here: {"subject":"S","text":"T"} done')["text"], "T")

    def test_fallback_raw_text(self):
        self.assertEqual(parse_content("Hello body")["text"], "Hello body")

    def test_empty(self):
        self.assertEqual(parse_content(""), {})


def _runner_with(text_payload: str):
    def runner(agent_id, prompt, timeout):
        return json.dumps({"result": {"payloads": [{"text": text_payload}]}})
    return runner


class TestGenerator(unittest.TestCase):
    def test_stub_runner_json(self):
        out = openclaw_generator(
            {"content_route": "dealclaw-exhibition-invitation", "suggested_subject": "def"},
            runner=_runner_with('{"subject":"S","text":"T"}'))
        self.assertEqual(out["text"], "T")
        self.assertEqual(out["subject"], "S")

    def test_subject_fallback_to_suggested(self):
        out = openclaw_generator(
            {"content_route": "dealclaw-exhibition-invitation", "suggested_subject": "sugg"},
            runner=_runner_with('{"text":"T"}'))
        self.assertEqual(out["subject"], "sugg")

    def test_empty_runner_gives_empty_text(self):
        out = openclaw_generator({"content_route": "dealclaw-exhibition-invitation"},
                                 runner=lambda agent_id, prompt, timeout: "")
        self.assertEqual(out["text"], "")


class TestEndToEnd(unittest.TestCase):
    def test_generator_to_send_closes_automation(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch.dict(os.environ, {"DC_DATA_DIR": td}):
                from dc_marketing_automation import (activate_automation, load_automations,
                                                     SECOND_INVITE)
                from dc_marketing_automation_send import send_one
                from dc_email_controller.dc_reply_draft import record_draft, get_draft

                act = activate_automation("sid", {
                    "opportunity_id": "cdp_1", "customer_id": "cdp_1",
                    "action": SECOND_INVITE, "idempotency_key": f"{SECOND_INVITE}:cdp_1",
                }, workspace_root=td)
                aid = act["record"]["automation_id"]
                record_draft({
                    "draft_id": "am_e2e", "company_id": "sid", "buyer_email": "b@x.com",
                    "subject": "S", "text": "", "status": "pending_confirmation",
                    "missing_fields": [], "automation_id": aid,
                    "automation_action": SECOND_INVITE, "automation_requires_approval": False,
                    "content_route": "dealclaw-exhibition-invitation",
                    "company_name": "Casa", "exhibition_name": "Mexico Expo",
                })

                gen = lambda task: openclaw_generator(
                    task, runner=_runner_with('{"subject":"Inv","text":"Body from skill"}'))
                r = send_one("sid", "am_e2e", gen,
                             send_fn=lambda d, confirmed_by="": {"status": "sent", "resend_id": "re_1"},
                             workspace_root=td)
                self.assertEqual(r["status"], "sent")
                self.assertIn("Body from skill", get_draft("am_e2e")["text"])
                data = load_automations("sid", workspace_root=td)
                self.assertEqual(data["automations"][0]["status"], "completed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
