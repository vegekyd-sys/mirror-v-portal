"""发信前置闸门 fail-closed 行为测试：托管邮箱 vs 自有邮箱（2026-09-15 定）。"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

import dc_email_send  # noqa: E402


class ManagedAddressTests(unittest.TestCase):
    def test_detects_managed_addresses(self):
        self.assertTrue(dc_email_send._is_managed_address("v@mail.dealclaw.io"))
        self.assertTrue(dc_email_send._is_managed_address("V <v@mail.dealclaw.io>"))
        # 无 @ 时按托管域补全
        self.assertTrue(dc_email_send._is_managed_address("V"))

    def test_detects_self_owned_addresses(self):
        self.assertFalse(dc_email_send._is_managed_address("me@gmail.com"))
        self.assertFalse(dc_email_send._is_managed_address("me@company.com"))


class GateFailClosedTests(unittest.TestCase):
    def test_gate_exception_blocks_managed(self):
        with patch("email_gateway.provision.check_send_ready", side_effect=RuntimeError("boom")):
            gate, blocked = dc_email_send._preflight_gate("1000001", "v@mail.dealclaw.io")
        self.assertIsNone(gate)
        self.assertIsNotNone(blocked)
        self.assertFalse(blocked["success"])
        self.assertFalse(blocked["sent"])
        self.assertEqual(blocked["code"], "send_gate_error")
        self.assertEqual(blocked["count"], 0)

    def test_gate_exception_allows_self_owned(self):
        with patch("email_gateway.provision.check_send_ready", side_effect=RuntimeError("boom")):
            gate, blocked = dc_email_send._preflight_gate("1000001", "me@gmail.com")
        self.assertIsNone(blocked)

    def test_self_owned_not_applicable_is_allowed(self):
        """正常路径：自有邮箱 applicable=False → 放行，既有发信行为不变。"""
        gate, blocked = dc_email_send._preflight_gate("1000001", "me@gmail.com")
        self.assertIsNone(blocked)
        self.assertFalse(gate.get("applicable", False))


if __name__ == "__main__":
    unittest.main()
