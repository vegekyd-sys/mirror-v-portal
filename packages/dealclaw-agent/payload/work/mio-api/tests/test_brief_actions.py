"""早晚报卡片按钮回调接线测试（2026-09-17）。

按钮值：``brief:gen_draft`` / ``brief:mark_done:<buyer>``
硬规则：不自动发送；认不出的动作如实报错；动作落决策日志（可回放）。
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[1]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

import dc_brief_actions as ba  # noqa: E402


class ParseAction(unittest.TestCase):
    def test_known_actions(self):
        self.assertEqual(ba.parse_action("brief:gen_draft")["action"], "gen_draft")
        parsed = ba.parse_action("brief:mark_done:ACME Co")
        self.assertEqual(parsed["action"], "mark_done")
        self.assertEqual(parsed["buyer"], "ACME Co")

    def test_unknown_and_empty(self):
        self.assertEqual(ba.parse_action("nonsense")["action"], "")
        self.assertEqual(ba.parse_action("brief:whatever")["action"], "")
        self.assertEqual(ba.parse_action("")["action"], "")


class HandleAction(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_unknown_action_reports_error(self):
        out = ba.handle_action("brief:nope", company_id="testco")
        self.assertFalse(out["ok"])
        self.assertIn("unknown action", out["error"])

    def test_mark_done_requires_buyer(self):
        out = ba.handle_action("brief:mark_done", company_id="testco")
        self.assertFalse(out["ok"])
        self.assertIn("买家", out["error"])

    def test_mark_done_writes_decision_log(self):
        out = ba.handle_action("brief:mark_done:ACME Co", company_id="testco",
                               open_id="ou_x", dry_run=False, data_dir=self.data)
        self.assertTrue(out["ok"], out)
        from dc_brief_render import list_decisions  # noqa: PLC0415

        logs = list_decisions(self.data)
        self.assertEqual(logs[-1]["action"], "brief_mark_done")
        self.assertEqual(logs[-1]["buyer"], "ACME Co")
        self.assertEqual(logs[-1]["source"], "brief_card")

    def test_mark_done_dry_run_writes_nothing(self):
        ba.handle_action("brief:mark_done:ACME Co", company_id="testco", data_dir=self.data)
        self.assertFalse((self.data / "touch-decisions.jsonl").exists())

    def test_gen_draft_builds_drafts_for_due_rows(self):
        rows = [{"buyer": "Electromart SA", "tier": "T1", "round": 2,
                 "angle": "价值强化：认证 / 产能", "reason": "R1 后 3 天未回"}]
        original = ba._due_rows
        ba._due_rows = lambda company_id, limit: (rows, "")
        try:
            out = ba.handle_action("brief:gen_draft", company_id="testco", dry_run=False,
                                   data_dir=self.data)
        finally:
            ba._due_rows = original
        self.assertTrue(out["ok"], out)
        self.assertEqual(len(out["items"]), 1)
        item = out["items"][0]
        self.assertEqual(item["buyer"], "Electromart SA")
        self.assertEqual(item["round"], 2)
        self.assertTrue(item["draft"], "必须产出草稿文本")
        self.assertIn("不会自动发", out["note"])

    def test_gen_draft_with_no_due_returns_note_not_error(self):
        original = ba._due_rows
        ba._due_rows = lambda company_id, limit: ([], "touch_queue_unavailable:ImportError")
        try:
            out = ba.handle_action("brief:gen_draft", company_id="testco")
        finally:
            ba._due_rows = original
        self.assertTrue(out["ok"])
        self.assertEqual(out["items"], [])
        self.assertIn("没有该触达的买家", out["note"])

    def test_missing_queue_never_raises(self):
        """真实环境下队列取不到时，也不能抛异常（回调必须稳）。"""
        out = ba.handle_action("brief:gen_draft", company_id="不存在的企业", dry_run=True)
        self.assertIn("ok", out)


if __name__ == "__main__":
    unittest.main()
