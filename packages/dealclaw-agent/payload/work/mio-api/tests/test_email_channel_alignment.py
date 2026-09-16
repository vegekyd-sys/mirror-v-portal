"""渠道口径对齐（2026-09-16）：事实里显式落 `send_channel`，不再靠 `account_id == resend_gs` 推断。

背景：同一天取消了 `dc_record_outbound.py` 写死假账号 `resend_gs`（那是回信匹配不上的根因），
GS 直发开始带**真实账号** → 旧推断（按账号名判渠道）会失灵，growth_send 统计会漂。
对齐方式：
  · 写入方显式落 `send_channel`：GS 直发（dc_record_outbound / dc_backfill_outbound）→ growth_send；
    Founder Direct（email_gateway.outbound_facts.land_outbound_fact）→ founder_direct
  · `store._normalize` 白名单同步加字段（否则被静默丢弃）
  · `quality_metrics.channel_of_record()`：**显式字段优先**，历史事实无该字段时回退旧规则

跑法：
  cd <mio-api> && python3 -m unittest discover -s tests -t . -p "test_email_channel_alignment.py"
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


class ChannelFieldRoundTrip(unittest.TestCase):
    """写进事实 → 读回来必须还在（store._normalize 是白名单）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name)
        sys.path.insert(0, str(_MIO))
        from email_gateway.store import EmailStore  # noqa: PLC0415

        self.store = EmailStore(self.data)
        self.account = self.store.add_account(
            enterprise_id=ENT, owner_open_id="ou_x", email_address=PROXY,
            provider="resend", mailbox_kind="dealclaw_proxy", secret_ref="env:RESEND_API_KEY",
        )

    def tearDown(self):
        self._tmp.cleanup()

    def test_send_channel_survives_normalize(self):
        self.store.insert_message({
            "direction": "outbound", "account_id": self.account["account_id"],
            "sender": PROXY, "recipients": ["buyer@x.com"], "subject": "s",
            "resend_id": "re_ch_1", "message_id": "re_ch_1",
            "send_channel": "growth_send", "company_id": ENT,
        })
        got = self.store.find_outbound_by_resend_id("re_ch_1")
        self.assertIsNotNone(got)
        self.assertEqual(got.get("send_channel"), "growth_send")


class ChannelOfRecord(unittest.TestCase):
    def _ch(self, rec):
        from email_metrics.quality_metrics import channel_of_record  # noqa: PLC0415

        return channel_of_record(rec)

    def test_explicit_field_wins(self):
        self.assertEqual(self._ch({"send_channel": "growth_send", "account_id": "ema_x"}), "growth_send")
        self.assertEqual(self._ch({"send_channel": "founder_direct", "account_id": "resend_gs"}),
                         "founder_direct")

    def test_legacy_records_fall_back_to_account_rule(self):
        """历史事实没有 send_channel → 仍按旧规则推断（不回溯改写）。"""
        self.assertEqual(self._ch({"account_id": "resend_gs"}), "growth_send")
        self.assertEqual(self._ch({"account_id": "ema_real"}), "founder_direct")
        self.assertEqual(self._ch({}), "unattributed")

    def test_unknown_channel_value_falls_back(self):
        self.assertEqual(self._ch({"send_channel": "weird", "account_id": "resend_gs"}), "growth_send")


class WritersEmitChannel(unittest.TestCase):
    """两个写入方必须真的落字段：GS 走 CLI，FD 走 land_outbound_fact。"""

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

    def test_gs_cli_writes_growth_send(self):
        out = subprocess.run(
            [sys.executable, "dc_record_outbound.py", "--company-id", ENT, "--from", PROXY,
             "--to", "buyer@x.com", "--subject", "s", "--resend-id", "re_ch_gs_1"],
            cwd=str(_MIO), env=self.env, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(out.returncode, 0, out.stderr[-400:])
        facts = list((self.data / "email-facts" / "outbound").rglob("*.md"))
        record = json.loads([ln for ln in facts[0].read_text(encoding="utf-8").splitlines()
                             if ln.strip().startswith("{")][0])
        self.assertEqual(record.get("send_channel"), "growth_send")

    def test_fd_land_writes_founder_direct(self):
        from email_gateway import outbound_facts as of  # noqa: PLC0415
        from email_gateway.store import EmailStore  # noqa: PLC0415

        store = EmailStore(self.data)
        res = of.land_outbound_fact(from_addr=PROXY, to_list=["buyer@x.com"], subject="s",
                                    resend_id="re_ch_fd_1", enterprise=ENT, store=store)
        self.assertTrue(res["ok"], res)
        got = store.find_outbound_by_resend_id("re_ch_fd_1")
        self.assertIsNotNone(got)
        self.assertEqual(got.get("send_channel"), "founder_direct")


if __name__ == "__main__":
    unittest.main()
