"""邮件回复通知失灵的等价修复（2026-09-16 田耕郡转来的补丁说明，走 B 方案自行实现）。

修的是两处：
  ① `dc_record_outbound.py` / `dc_backfill_outbound.py`：发信落库不再写死 `resend_gs`
     （不存在的账号 → 回信按账号匹配永远配不上），改为按发件地址反查真实账号；
     查不到就落空**不造假**，交给 `dc_email_selfcheck.py` 标无归属 + 自愈。
  ② `dc_email_signals.py`：补「确认到展」识别词（be back / will come / see you / 会来 / 到场…）。

跑法：
  cd <mio-api> && python3 -m unittest tests.test_email_reply_fix
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[1]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

PROXY = "proxy@mail.dealclaw.io"
ENT = "test-tuozhu"


class RecordOutboundResolvesAccount(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name)
        self.env = dict(os.environ, DC_DATA_DIR=str(self.data), MIO_CDP_SUPPLIER_ID=ENT)
        sys.path.insert(0, str(_MIO))
        from email_gateway.store import EmailStore  # noqa: PLC0415

        self.store = EmailStore(self.data)
        self.account = self.store.add_account(
            enterprise_id=ENT, owner_open_id="ou_x", email_address=PROXY,
            provider="resend", mailbox_kind="dealclaw_proxy", secret_ref="env:RESEND_API_KEY",
        )

    def tearDown(self):
        self._tmp.cleanup()

    def test_resolver_matches_bare_and_display_name(self):
        import dc_record_outbound as rec  # noqa: PLC0415

        self.assertEqual(rec.resolve_account_id(self.store, PROXY), self.account["account_id"])
        self.assertEqual(rec.resolve_account_id(self.store, f"Agent <{PROXY}>"),
                         self.account["account_id"])
        self.assertEqual(rec.resolve_account_id(self.store, "nobody@example.com"), "")

    def test_cli_records_real_account_not_placeholder(self):
        """回归：发信落库必须落真实账号，且不得再出现 resend_gs。"""
        out = subprocess.run(
            [sys.executable, "dc_record_outbound.py", "--company-id", ENT,
             "--from", PROXY, "--to", "buyer@x.com", "--subject", "hi",
             "--text", "hello", "--resend-id", "re_test_123"],
            cwd=str(_MIO), env=self.env, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(out.returncode, 0, out.stderr[-500:])
        payload = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["account_id"], self.account["account_id"])
        self.assertTrue(payload["account_resolved"])

        facts = list((self.data / "email-facts" / "outbound").rglob("*.md"))
        self.assertTrue(facts, "应当落一条 outbound 事实")
        raw = facts[0].read_text(encoding="utf-8")
        record = json.loads([ln for ln in raw.splitlines() if ln.strip().startswith("{")][0])
        self.assertEqual(record["account_id"], self.account["account_id"])
        self.assertNotIn("resend_gs", raw, "不得再写死假账号")

    def test_unknown_sender_records_empty_account_and_warns(self):
        out = subprocess.run(
            [sys.executable, "dc_record_outbound.py", "--company-id", ENT,
             "--from", "unknown@nowhere.com", "--to", "buyer@x.com", "--subject", "hi",
             "--resend-id", "re_test_456"],
            cwd=str(_MIO), env=self.env, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(out.returncode, 0, out.stderr[-500:])
        payload = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["account_id"], "")
        self.assertFalse(payload["account_resolved"])
        self.assertIn("unresolved", out.stderr)


class ArrivalSignalsRecognized(unittest.TestCase):
    """「确认到展」的说法要能识别成 meeting_interest。"""

    CASES = [
        "I'll be back on the 20th, see you there.",
        "We will come to the booth tomorrow.",
        "好的，我会来现场的",
        "我们到场了，在门口",
        "See you at the expo!",
    ]

    def test_arrival_phrases_map_to_meeting_interest(self):
        from dc_email_controller.dc_email_signals import classify_reply_signals  # noqa: PLC0415

        for text in self.CASES:
            with self.subTest(text=text):
                types = [s.get("signal_type") for s in classify_reply_signals(text)]
                self.assertIn("meeting_interest", types, f"未识别：{text}")

    def test_unrelated_text_is_not_arrival(self):
        from dc_email_controller.dc_email_signals import classify_reply_signals  # noqa: PLC0415

        types = [s.get("signal_type") for s in classify_reply_signals("Thanks, noted.")]
        self.assertNotIn("meeting_interest", types)


if __name__ == "__main__":
    unittest.main()
