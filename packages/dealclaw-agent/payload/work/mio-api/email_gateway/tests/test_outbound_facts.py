"""Outbound 事实落地测试：收信匹配的唯一依据，漏落即静默失效。

本次修复背景：网关直发通道（cli send）原先不落 outbound 事实，导致回信
`no_matching_outbound`，通知永不触发且不报错。
"""

import sys
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway import outbound_facts as of  # noqa: E402


class FakeStore:
    def __init__(self, accounts=None, raise_on_list=False, raise_on_insert=False):
        self.accounts = accounts if accounts is not None else [
            {"account_id": "ema_1", "email_address": "bambu-lab@mail.dealclaw.io",
             "enterprise_id": "test-tuozhu"}]
        self.raise_on_list = raise_on_list
        self.raise_on_insert = raise_on_insert
        self.inserted = []

    def list_accounts(self, enterprise_id=None):
        if self.raise_on_list:
            raise RuntimeError("store down")
        return self.accounts

    def insert_message(self, rec):
        if self.raise_on_insert:
            raise RuntimeError("insert failed")
        self.inserted.append(rec)


class AccountResolutionTests(unittest.TestCase):
    def test_matches_display_name_form(self):
        store = FakeStore()
        self.assertEqual(
            of.resolve_account_id("DealClaw <bambu-lab@mail.dealclaw.io>", "test-tuozhu", store=store),
            "ema_1")

    def test_case_insensitive(self):
        store = FakeStore()
        self.assertEqual(
            of.resolve_account_id("BAMBU-LAB@mail.dealclaw.io", "test-tuozhu", store=store), "ema_1")

    def test_unknown_address_returns_empty(self):
        store = FakeStore()
        self.assertEqual(of.resolve_account_id("nobody@x.com", "test-tuozhu", store=store), "")

    def test_store_failure_returns_empty(self):
        store = FakeStore(raise_on_list=True)
        self.assertEqual(of.resolve_account_id("bambu-lab@mail.dealclaw.io", "t", store=store), "")


class LandFactTests(unittest.TestCase):
    def test_lands_fact_with_account_and_resend_id(self):
        store = FakeStore()
        r = of.land_outbound_fact(from_addr="bambu-lab@mail.dealclaw.io", to_list=["buyer@x.com"],
                                  subject="hello", resend_id="re_123", enterprise="test-tuozhu",
                                  store=store)
        self.assertTrue(r["ok"])
        self.assertEqual(r["account_id"], "ema_1")
        rec = store.inserted[0]
        self.assertEqual(rec["direction"], "outbound")
        self.assertEqual(rec["resend_id"], "re_123")
        self.assertEqual(rec["recipients"], ["buyer@x.com"])
        self.assertEqual(rec["company_id"], "test-tuozhu")

    def test_no_fact_when_account_unresolved(self):
        """宁可不落，也不能兜底到别的账号（会把回复串租户）。"""
        store = FakeStore(accounts=[{"account_id": "ema_9", "email_address": "other@x.com"}])
        r = of.land_outbound_fact(from_addr="unknown@mail.dealclaw.io", to_list=["a@b.com"],
                                  subject="s", resend_id="re_1", enterprise="t", store=store)
        self.assertFalse(r["ok"])
        self.assertIn("account_not_resolved", r["error"])
        self.assertEqual(store.inserted, [])

    def test_never_raises_on_insert_failure(self):
        store = FakeStore(raise_on_insert=True)
        r = of.land_outbound_fact(from_addr="bambu-lab@mail.dealclaw.io", to_list=["a@b.com"],
                                  subject="s", resend_id="re_1", enterprise="t", store=store)
        self.assertFalse(r["ok"])
        self.assertIn("insert failed", r["error"])

    def test_stores_real_provider_message_id_for_reply_matching(self):
        """回信按 In-Reply-To 匹配，所以事实里必须是**真实发送 Message-ID**。"""
        store = FakeStore()
        mid = "<178945054690.2688873.883469746086914931@mail.dealclaw.io>"
        r = of.land_outbound_fact(from_addr="bambu-lab@mail.dealclaw.io", to_list=["buyer@x.com"],
                                  subject="s", resend_id="re_1", message_id=mid,
                                  enterprise="t", store=store)
        self.assertTrue(r["ok"])
        self.assertEqual(store.inserted[0]["message_id"], mid)

    def test_falls_back_to_local_id_when_message_id_missing(self):
        store = FakeStore()
        of.land_outbound_fact(from_addr="bambu-lab@mail.dealclaw.io", to_list=["a@b.com"],
                              subject="s", resend_id="re_1", enterprise="t", store=store)
        self.assertTrue(str(store.inserted[0]["message_id"]).startswith("local_"))

    def test_empty_recipients_still_lands(self):
        store = FakeStore()
        r = of.land_outbound_fact(from_addr="bambu-lab@mail.dealclaw.io", to_list=[],
                                  subject="s", resend_id="", enterprise="t", store=store)
        self.assertTrue(r["ok"])
        self.assertEqual(store.inserted[0]["recipients"], [])


if __name__ == "__main__":
    unittest.main()
