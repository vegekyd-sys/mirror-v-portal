"""webhook 事件管子测试：游标语义、只处理业务事件、幂等、异常不推进游标。

以及一条针对真实故障的回归：Resend Receiving API 的 ``headers`` 是**对象**，
旧 `_parse_email_headers` 只认数组 → In-Reply-To 被静默丢弃（实测线上 119/119 条
入站事实 ``in_reply_to`` 全为空），回信只能退到 contact fallback 猜母邮件。
"""

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway import webhook_poller as wp  # noqa: E402


def _event(seq, etype, email_id="e-1", svix="msg_1", sender="buyer@x.com", to="bambu-lab@mail.dealclaw.io"):
    return {"sequence": seq, "svix_id": svix, "event_type": etype,
            "received_at": seq,
            "payload": {"email_id": email_id, "from": sender, "to": [to], "subject": "Re: hi"}}


class FakeStore:
    def __init__(self, already=()):
        self.already = set(already)
        self.processed = []
        self.claims = []

    def claim_webhook_event(self, svix_id, event_type="", email_id="", event_created_at=""):
        self.claims.append((svix_id, event_type, email_id))
        return "already_processed" if svix_id in self.already else "claimed"

    def mark_webhook_event_processed(self, svix_id, status="processed", failure_reason=""):
        self.processed.append((svix_id, status))


class FakeDeps:
    def __init__(self, pages, ingest_results=None, deliver_ok=True, already=()):
        self.pages = list(pages)          # [{ok, events, next_cursor, has_more, error}]
        self.ingest_results = ingest_results or {}
        self.deliver_ok = deliver_ok
        self.store = FakeStore(already)
        self.calls = []
        self.ingested = []
        self.notified = []
        self.saved = []

    def deps(self):
        def fetch(after="", limit=200, base_url="", token=""):
            self.calls.append(after)
            if not self.pages:
                return {"ok": True, "status": 200, "events": [], "next_cursor": after, "has_more": False}
            return self.pages.pop(0)

        def ingest(ev):
            self.ingested.append(ev.get("svix_id"))
            return dict(self.ingest_results.get(ev.get("svix_id"), {"ok": True, "matched": True}))

        def deliver(binding, text="", **kw):
            self.notified.append((dict(binding), text))
            return {"ok": self.deliver_ok, "channel": "app_bot"}

        return {
            "fetch_events": fetch,
            "load_cursor": lambda: {"cursor": ""},
            "save_cursor": lambda c, last_event_at="", scanned=0: self.saved.append((c, scanned)),
            "ingest": ingest,
            "deliver": deliver,
            "resolve_notify_binding": lambda origin_notify_target="", account_id="", address="", store=None: (
                {"chat_id": origin_notify_target, "source": "origin", "notify_enabled": 1}
                if origin_notify_target else {}),
            "notify_text": lambda item, event, res=None: f"notify:{item.get('id')}",
            "reply_brief": lambda item, event, res=None, attribution=None: {"received_id": item.get("id")},
            "recipient": lambda event: (event.get("payload") or {}).get("to", [""])[0],
            "store": self.store,
        }


class CursorFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._dir, self._file = wp.POLLER_DIR, wp.CURSOR_FILE
        wp.POLLER_DIR = Path(self.tmp.name) / "webhook-poller"
        wp.CURSOR_FILE = wp.POLLER_DIR / "events-cursor.md"

    def tearDown(self):
        wp.POLLER_DIR, wp.CURSOR_FILE = self._dir, self._file
        self.tmp.cleanup()

    def test_missing_cursor_is_empty(self):
        self.assertEqual(wp.load_cursor()["cursor"], "")

    def test_save_then_load_roundtrip(self):
        wp.save_cursor("2026-09-15T07:00:00.000001+00:00", last_event_at="x", scanned=3)
        self.assertEqual(wp.load_cursor()["cursor"], "2026-09-15T07:00:00.000001+00:00")

    def test_corrupt_cursor_falls_back_to_empty(self):
        wp.POLLER_DIR.mkdir(parents=True, exist_ok=True)
        wp.CURSOR_FILE.write_text("# hdr\n\n{not json\n", encoding="utf-8")
        self.assertEqual(wp.load_cursor()["cursor"], "")


class SignatureHeaderParseTests(unittest.TestCase):
    """Resend Receiving API 的真实 headers 形态必须能解析出 In-Reply-To。"""

    def setUp(self):
        self.handler = importlib.import_module("dc_email_controller.dc_webhook_handler")

    def test_object_headers_are_parsed(self):
        headers = {"message-id": "<own@x>", "in-reply-to": "<parent@x>",
                   "references": "<a@x> <b@x>"}
        mid, irt, refs = self.handler._parse_email_headers(headers)
        self.assertEqual(mid, "<own@x>")
        self.assertEqual(irt, "<parent@x>")          # 修复前恒为空串
        self.assertEqual(refs, ["<a@x>", "<b@x>"])

    def test_object_headers_with_list_value(self):
        _, irt, _ = self.handler._parse_email_headers({"in-reply-to": ["<p1@x>", "<p2@x>"]})
        self.assertEqual(irt, "<p1@x>")

    def test_array_headers_still_supported(self):
        headers = [{"name": "Message-ID", "value": "<own@x>"},
                   {"key": "In-Reply-To", "value": "<parent@x>"},
                   {"name": "References", "value": "<a@x> <b@x>"}]
        mid, irt, refs = self.handler._parse_email_headers(headers)
        self.assertEqual((mid, irt), ("<own@x>", "<parent@x>"))
        self.assertEqual(refs, ["<a@x>", "<b@x>"])

    def test_raw_header_lines_supported(self):
        _, irt, _ = self.handler._parse_email_headers(["In-Reply-To: <parent@x>"])
        self.assertEqual(irt, "<parent@x>")

    def test_full_object_wins_over_headers(self):
        mid, irt, _ = self.handler._parse_email_headers(
            {"in-reply-to": "<hdr@x>"}, {"message_id": "<full@x>", "in_reply_to": "<top@x>"})
        self.assertEqual((mid, irt), ("<full@x>", "<top@x>"))


class PollOnceTests(unittest.TestCase):
    def test_baseline_records_high_water_and_ingests_nothing(self):
        f = FakeDeps([{"ok": True, "status": 200, "events": [_event("s1", "email.received")],
                       "next_cursor": "s1", "has_more": False}])
        r = wp.poll_once(baseline=True, deps=f.deps())
        self.assertEqual(r["mode"], "baseline")
        self.assertEqual(r["ingested"], 0)
        self.assertEqual(f.ingested, [])
        self.assertTrue(r["cursor_advanced"])
        self.assertEqual(r["advanced_to"], "s1")

    def test_dry_run_does_not_write(self):
        f = FakeDeps([{"ok": True, "status": 200, "events": [_event("s1", "email.received")],
                       "next_cursor": "s1", "has_more": False}])
        r = wp.poll_once(dry_run=True, deps=f.deps())
        self.assertEqual(r["considered"], 1)
        self.assertEqual(r["ingested"], 0)
        self.assertEqual(f.ingested, [])
        self.assertEqual(f.saved, [])
        self.assertFalse(r["cursor_advanced"])

    def test_only_business_events_are_ingested(self):
        events = [_event("s1", "email.opened"), _event("s2", "contact.created"),
                  _event("s3", "email.received"), _event("s4", "email.delivered", email_id="sent-1"),
                  _event("s5", "suppression.added")]
        f = FakeDeps([{"ok": True, "status": 200, "events": events,
                       "next_cursor": "s5", "has_more": False}])
        r = wp.poll_once(deps=f.deps())
        self.assertEqual(r["scanned"], 5)
        self.assertEqual(r["ignored"], 3)
        self.assertEqual(r["considered"], 2)
        self.assertEqual(sorted(f.ingested), ["msg_1", "msg_1"])  # svix_id 默认相同
        self.assertEqual(r["cursor_advanced"], True)
        self.assertEqual(r["advanced_to"], "s5")

    def test_non_business_events_leave_no_local_receipt(self):
        f = FakeDeps([{"ok": True, "status": 200, "events": [_event("s1", "email.clicked")],
                       "next_cursor": "s1", "has_more": False}])
        wp.poll_once(deps=f.deps())
        self.assertEqual(f.store.claims, [])

    def test_replay_is_skipped_by_local_receipt(self):
        f = FakeDeps([{"ok": True, "status": 200,
                       "events": [_event("s1", "email.received", svix="msg_dup")],
                       "next_cursor": "s1", "has_more": False}],
                     already={"msg_dup"})
        r = wp.poll_once(deps=f.deps())
        self.assertEqual(r["skipped"], 1)
        self.assertEqual(f.ingested, [])

    def test_duplicate_fact_from_other_source_is_skipped(self):
        f = FakeDeps([{"ok": True, "status": 200,
                       "events": [_event("s1", "email.received", svix="msg_2")],
                       "next_cursor": "s1", "has_more": False}],
                     ingest_results={"msg_2": {"ok": True, "duplicate_fact": True}})
        r = wp.poll_once(deps=f.deps())
        self.assertEqual(r["skipped"], 1)
        self.assertEqual(r["ingested"], 0)
        self.assertEqual(f.store.processed, [("msg_2", "duplicate")])

    def test_fetch_error_reports_and_keeps_cursor(self):
        f = FakeDeps([{"ok": False, "status": -1, "events": [], "next_cursor": "",
                       "has_more": False, "error": "boom"}])
        r = wp.poll_once(deps=f.deps())
        self.assertFalse(r["ok"])
        self.assertEqual(f.saved, [])
        self.assertFalse(r["cursor_advanced"])

    def test_ingest_failure_keeps_cursor(self):
        f = FakeDeps([{"ok": True, "status": 200,
                       "events": [_event("s1", "email.received", svix="msg_3")],
                       "next_cursor": "s1", "has_more": False}],
                     ingest_results={"msg_3": {"ok": False, "status": "retryable"}})
        r = wp.poll_once(deps=f.deps())
        self.assertEqual(f.saved, [])
        self.assertFalse(r["cursor_advanced"])

    def test_notify_uses_origin_target(self):
        f = FakeDeps([{"ok": True, "status": 200,
                       "events": [_event("s1", "email.received", svix="msg_4")],
                       "next_cursor": "s1", "has_more": False}],
                     ingest_results={"msg_4": {"ok": True, "matched": True,
                                               "origin_notify_target": "oc_group1"}})
        r = wp.poll_once(notify=True, deps=f.deps())
        self.assertEqual(r["notified"], 1)
        self.assertEqual(f.notified[0][0]["chat_id"], "oc_group1")
        self.assertEqual(r["notify_targets"][0]["source"], "origin")

    def test_unmatched_is_recorded_not_notified(self):
        f = FakeDeps([{"ok": True, "status": 200,
                       "events": [_event("s1", "email.received", svix="msg_5")],
                       "next_cursor": "s1", "has_more": False}],
                     ingest_results={"msg_5": {"ok": True, "matched": False,
                                               "failure_reason": "no_matching_outbound"}})
        r = wp.poll_once(notify=True, deps=f.deps())
        self.assertEqual(r["unmatched"], 1)
        self.assertEqual(r["notified"], 0)
        self.assertEqual(r["unmatched_items"][0]["reason"], "no_matching_outbound")

    def test_multi_page_walks_cursor(self):
        f = FakeDeps([
            {"ok": True, "status": 200, "events": [_event("s1", "email.opened")],
             "next_cursor": "s1", "has_more": True},
            {"ok": True, "status": 200, "events": [_event("s2", "email.opened")],
             "next_cursor": "s2", "has_more": False},
        ])
        r = wp.poll_once(deps=f.deps())
        self.assertEqual(f.calls, ["", "s1"])
        self.assertEqual(r["advanced_to"], "s2")


class InReplyToBindingRegressionTests(unittest.TestCase):
    """母邮件必须按 In-Reply-To 命中，而不是按「同联系人最近一封」猜。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._old = os.environ.get("DC_DATA_DIR")
        os.environ["DC_DATA_DIR"] = self.tmp.name
        from email_gateway.store import EmailStore
        self.store = EmailStore(self.tmp.name)

    def tearDown(self):
        if self._old is None:
            os.environ.pop("DC_DATA_DIR", None)
        else:
            os.environ["DC_DATA_DIR"] = self._old
        self.tmp.cleanup()

    def test_binds_by_in_reply_to_when_same_contact_has_several(self):
        handler = importlib.import_module("dc_email_controller.dc_webhook_handler")
        acct = self.store.add_account(enterprise_id="testco", owner_open_id="ou_x",
                                      email_address="probe@mail.dealclaw.io", provider="resend",
                                      mailbox_kind="dealclaw_proxy", secret_ref="env:RESEND_API_KEY")
        aid = acct["account_id"]
        for resend_id, local_mid in (("r-old", "<parent@x>"), ("r-new", "<other@x>")):
            self.store.insert_message({
                "account_id": aid, "direction": "outbound", "resend_id": resend_id,
                "local_message_id": local_mid, "smtp_message_id": local_mid,
                "sender": "probe@mail.dealclaw.io", "recipients": ["buyer@x.com"],
                "subject": "s", "company_id": "testco", "sent_at": "2026-09-01T00:00:00+00:00",
                "origin_notify_target": f"oc_{resend_id}",
            })
        full = {"message_id": "<reply@x>", "to": ["probe@mail.dealclaw.io"],
                "from": "buyer@x.com", "subject": "Re: s", "text": "quote please",
                "headers": {"in-reply-to": "<parent@x>"}}
        r = handler.handle_inbound_event({"email_id": "rx-1", "from": "buyer@x.com",
                                          "to": ["probe@mail.dealclaw.io"], "subject": "Re: s"},
                                         fetch=lambda _eid: full)
        self.assertTrue(r["matched"], r)
        # 命中 In-Reply-To 指向的那封（r-old），而不是更新的 r-new
        self.assertEqual(r["origin_notify_target"], "oc_r-old")


if __name__ == "__main__":
    unittest.main()
