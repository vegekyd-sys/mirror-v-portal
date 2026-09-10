#!/usr/bin/env python3
"""test_marketing_automation_loop.py — 出站全链路 + 入站触发桥 单元测试。

出站：run_all 三步编排（dry_run 无副作用 / 注入 generator+send_fn 全链路）。
入站：select_new_replies 去重与限额 / 提示组装 / 触发（注入 runner）/ 游标 / dry_run。
不触真实 agent、不发真实邮件。
"""

import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dc_marketing_automation_cron import run_all, make_send_fn  # noqa: E402
from dc_marketing_automation_inbound import (  # noqa: E402
    select_new_replies,
    build_smart_reply_prompt,
    trigger_smart_reply,
    load_state,
    save_state,
    run_inbound_cycle,
)


def _write(root, cid, name, data):
    p = Path(root) / "data" / "memory" / cid / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _setup(td):
    _write(td, "sid", "leads.json", [{
        "company": "Casa", "company_cdp_id": "cdp_1",
        "contact": "John|M|john@casa.mx",
        "contact_policy": "active", "opportunity_status": "active",
        "stage": "待触达", "reply_count": 0}])
    _write(td, "sid", "email_followup.json", [])
    _write(td, "sid", "exhibition-invitations.json", {"invitations": []})
    _write(td, "sid", "interactions.json", [])
    _write(td, "sid", "meta.json", {"exhibition_stage": "live", "exhibitions": []})


class TestOutboundCron(unittest.TestCase):
    def test_dry_run_no_side_effects(self):
        with tempfile.TemporaryDirectory() as td:
            _setup(td)
            from dc_marketing_automation import load_automations
            r = run_all("sid", workspace_root=td, dry_run=True)
            self.assertEqual(r["decided"]["scanned"], 1)
            self.assertEqual(r["decided"]["tasks_created"], 1)
            self.assertEqual(load_automations("sid", workspace_root=td)["automations"], [])

    def test_full_chain_with_stubs(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch.dict(os.environ, {"DC_DATA_DIR": td}):
                _setup(td)
                # 已邀约未到场 → second_invite（requires_approval=False）→ 走直接发
                _write(td, "sid", "exhibition-invitations.json", {"invitations": [
                    {"companyCdpId": "cdp_1", "exhibitionId": "exh_1",
                     "exhibitionName": "Mexico Expo", "sendTime": "2026-08-01T00:00:00Z"}]})
                gen = lambda task: {"subject": "S", "text": "Body"}
                sfn = lambda draft_id, confirmed_by="": {"status": "sent", "resend_id": "re_x"}
                r = run_all("sid", workspace_root=td, dry_run=False,
                            generator=gen, send_fn=sfn)
                self.assertEqual(r["decided"]["tasks_created"], 1)
                self.assertEqual(r["sent"]["sent"], 1)

    def test_make_send_fn_returns_callable(self):
        self.assertTrue(callable(make_send_fn(enterprise="sid")))


class TestInbound(unittest.TestCase):
    def test_select_new_replies_dedup(self):
        recs = [{"resend_id": "a"}, {"resend_id": "b"}, {"resend_id": "a"}]
        self.assertEqual([x["_id"] for x in select_new_replies(recs, {"b"})], ["a"])

    def test_select_new_replies_limit(self):
        recs = [{"resend_id": str(i)} for i in range(10)]
        self.assertEqual(len(select_new_replies(recs, set(), limit=3)), 3)

    def test_select_skips_missing_id(self):
        self.assertEqual(select_new_replies([{"subject": "x"}], set()), [])

    def test_prompt_contains_skill_and_reply(self):
        p = build_smart_reply_prompt(
            {"resend_id": "a", "from": "b@x.com", "subject": "S", "text": "T"})
        self.assertIn("dealclaw-smart-reply", p)
        self.assertIn("b@x.com", p)
        self.assertIn("T", p)

    def test_trigger_with_stub_runner(self):
        out = trigger_smart_reply(
            {"resend_id": "a", "text": "T"},
            runner=lambda aid, prompt, to: json.dumps(
                {"result": {"payloads": [{"text": "done"}]}}))
        self.assertTrue(out["triggered"])
        self.assertEqual(out["agent_output"], "done")

    def test_state_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            save_state(td, {"seen_ids": ["x"]})
            self.assertEqual(load_state(td)["seen_ids"], ["x"])

    def test_run_inbound_cycle_dry_run(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch("email_gateway.store.EmailStore") as ES:
                ES.return_value.list_inbound_records.return_value = [{"resend_id": "r1"}]
                r = run_inbound_cycle("sid", workspace_root=td, dry_run=True)
                self.assertEqual(r["new_replies"], 1)
                self.assertEqual(r["results"][0]["disposition"], "would_trigger_dry_run")

    def test_run_inbound_cycle_triggers_and_cursors(self):
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch("email_gateway.store.EmailStore") as ES:
                ES.return_value.list_inbound_records.return_value = [{"resend_id": "r1"}]
                r = run_inbound_cycle(
                    "sid", workspace_root=td, dry_run=False,
                    runner=lambda aid, prompt, to: json.dumps(
                        {"result": {"payloads": [{"text": "ok"}]}}))
                self.assertEqual(r["results"][0]["disposition"], "triggered")
                self.assertIn("r1", load_state(td)["seen_ids"])
                # 第二次跑：已有游标 → 不再重复触发
                r2 = run_inbound_cycle("sid", workspace_root=td, dry_run=True)
                self.assertEqual(r2["new_replies"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
