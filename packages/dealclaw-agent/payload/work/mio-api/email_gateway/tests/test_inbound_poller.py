"""入站取信管子测试：游标语义、只通知归属成功的、异常不推进游标。"""

import sys
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway import inbound_poller as ip  # noqa: E402


def item(rid, created="2026-09-15T03:00:00Z", sender="buyer@x.com", to_addr="bambu-lab@mail.dealclaw.io"):
    return {"id": rid, "created_at": created, "from": sender, "to": [to_addr], "subject": "Re: hi"}


class FakeDeps:
    def __init__(self, items, ingest_results=None, cursor=None, list_status=200, deliver_ok=True):
        self.items = items
        self.ingest_results = ingest_results or {}
        self.cursor = cursor or {}
        self.list_status = list_status
        self.deliver_ok = deliver_ok
        self.ingested = []
        self.notified = []
        self.saved = []

    def deps(self):
        return {
            "list_received": lambda limit=50: (self.list_status, {"data": self.items}),
            "load_cursor": lambda: dict(self.cursor),
            "save_cursor": lambda hw, created, processed: self.saved.append((hw, created, processed)),
            "to_ingest_event": lambda it: {"event_type": "email.received",
                                           "payload": {"email_id": it["id"], "from": it["from"],
                                                       "to": it["to"], "subject": it["subject"]}},
            "ingest": self._ingest,
            "deliver": self._deliver,
        }

    def _ingest(self, event):
        rid = event["payload"]["email_id"]
        self.ingested.append(rid)
        return self.ingest_results.get(rid, {"ok": True, "matched": True})

    def _deliver(self, binding, *, text):
        self.notified.append({"binding": binding, "text": text})
        return {"ok": self.deliver_ok, "channel": "app_bot"}


class FakeStore:
    def __init__(self, accounts=None, bindings=None):
        self._accounts = accounts if accounts is not None else [
            {"account_id": "ema_1", "email": "bambu-lab@mail.dealclaw.io"}]
        self._bindings = bindings if bindings is not None else [
            {"account_id": "ema_1", "notify_enabled": 1, "chat_id": "ou_me"}]

    def list_accounts(self):
        return self._accounts

    def list_bindings(self):
        return self._bindings


class BaselineTests(unittest.TestCase):
    def test_baseline_saves_high_water_and_ingests_nothing(self):
        f = FakeDeps([item("r3"), item("r2"), item("r1")])
        r = ip.poll_once(baseline=True, deps=f.deps(), store=FakeStore())
        self.assertEqual(r["mode"], "baseline")
        self.assertEqual(r["baseline_id"], "r3")
        self.assertEqual(f.ingested, [])
        self.assertEqual(f.saved[0][0], "r3")
        self.assertTrue(r["cursor_advanced"])

    def test_baseline_dry_run_does_not_save(self):
        f = FakeDeps([item("r3")])
        r = ip.poll_once(baseline=True, dry_run=True, deps=f.deps(), store=FakeStore())
        self.assertEqual(f.saved, [])
        self.assertFalse(r["cursor_advanced"])


class PollTests(unittest.TestCase):
    def test_only_processes_items_after_high_water(self):
        f = FakeDeps([item("r3"), item("r2"), item("r1")], cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertEqual(f.ingested, ["r3"])
        self.assertEqual(r["considered"], 1)
        self.assertEqual(r["ingested"], 1)

    def test_matched_reply_notifies_user_dm(self):
        f = FakeDeps([item("r3")], cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(notify=True, deps=f.deps(), store=FakeStore())
        self.assertEqual(r["matched"], 1)
        self.assertEqual(r["notified"], 1)
        self.assertEqual(f.notified[0]["binding"]["chat_id"], "ou_me")
        self.assertIn("解读", f.notified[0]["text"])
        self.assertIn("建议下一步", f.notified[0]["text"])

    def test_ingest_unmatched_but_mailbox_attributable_is_collected(self):
        """新语义（2026-09-15）：ingest 未匹配，但能按收件箱归属 → 仍算归属成功。

        背景：实测 Resend 详情接口可能不给 In-Reply-To，只靠头部精确匹配会“拉到了却认不出”。
        因此归属改为双口径：收件箱优先，In-Reply-To 仅作精修。
        """
        f = FakeDeps([item("r3")], ingest_results={"r3": {"ok": True, "matched": False}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertEqual(r["unmatched"], 0)
        self.assertEqual(r["matched"], 1)
        self.assertEqual(len(r["replies"]), 1)
        self.assertEqual(r["replies"][0]["attribution"]["method"], "recipient")
        self.assertEqual(f.notified, [])   # 默认不通知机器人

    def test_truly_unattributable_reply_is_counted_not_collected(self):
        """收件箱也认不出时，才计为未归属且不收集（不能乱挂接）。"""
        f = FakeDeps([item("r3")], ingest_results={"r3": {"ok": True, "matched": False}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore(accounts=[]))
        self.assertEqual(r["unmatched"], 1)
        self.assertEqual(r["replies"], [])

    def test_duplicate_fact_is_skipped(self):
        f = FakeDeps([item("r3")], ingest_results={"r3": {"ok": True, "duplicate_fact": True}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertEqual(r["skipped"], 1)
        self.assertEqual(r["ingested"], 0)

    def test_ingest_failure_does_not_advance_cursor(self):
        f = FakeDeps([item("r3")], ingest_results={"r3": {"ok": False, "status": "retryable"}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertFalse(r["cursor_advanced"])
        self.assertEqual(f.saved, [])
        self.assertTrue(r["errors"])

    def test_no_notify_when_binding_missing(self):
        f = FakeDeps([item("r3")], cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(notify=True, deps=f.deps(), store=FakeStore(bindings=[]))
        self.assertEqual(r["notified"], 0)
        self.assertTrue(any("notify skipped" in e for e in r["errors"]))

    def test_collect_returns_reply_facts_for_agent(self):
        f = FakeDeps([item("r3")],
                     ingest_results={"r3": {"ok": True, "matched": True,
                                            "text_preview": "Please send your catalog",
                                            "signals": [{"signal_type": "quote_request",
                                                         "evidence": "need price"}]}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertEqual(f.notified, [])          # 不推给任何机器人
        self.assertEqual(len(r["replies"]), 1)
        rep = r["replies"][0]
        self.assertEqual(rep["from"], "buyer@x.com")
        self.assertEqual(rep["excerpt"], "Please send your catalog")
        self.assertEqual(rep["signals"][0]["type"], "quote_request")
        self.assertTrue(rep["thread_matched"])

    def test_unmatched_reply_not_collected(self):
        f = FakeDeps([item("r3")], ingest_results={"r3": {"ok": True, "matched": False}},
                     cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore(accounts=[]))
        self.assertEqual(r["replies"], [])

    def test_notify_disabled_by_flag(self):
        f = FakeDeps([item("r3")], cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(notify=False, deps=f.deps(), store=FakeStore())
        self.assertEqual(f.notified, [])
        self.assertEqual(r["notified"], 0)

    def test_dry_run_does_not_save_or_notify(self):
        f = FakeDeps([item("r3")], cursor={"high_water_received_id": "r2"})
        r = ip.poll_once(dry_run=True, deps=f.deps(), store=FakeStore())
        self.assertEqual(f.saved, [])
        self.assertEqual(f.notified, [])

    def test_list_failure_is_reported(self):
        f = FakeDeps([], list_status=500)
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertFalse(r["ok"])
        self.assertTrue(r["errors"])

    def test_empty_inbox_is_ok(self):
        f = FakeDeps([])
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertTrue(r["ok"])
        self.assertEqual(r["pulled"], 0)

    def test_cursor_advances_to_newest_after_success(self):
        f = FakeDeps([item("r3"), item("r2")], cursor={"high_water_received_id": "r1"})
        r = ip.poll_once(deps=f.deps(), store=FakeStore())
        self.assertTrue(r["cursor_advanced"])
        self.assertEqual(r["advanced_to"], "r3")
        self.assertEqual(sorted(f.ingested), ["r2", "r3"])


if __name__ == "__main__":
    unittest.main()
