"""P0-E1 / P0-E1.1 邮件事实链 + Svix 验签 + 事件幂等 + Campaign 指标闭环 — 自检测试。"""

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway.store import EmailStore
from email_gateway.smtp_send import SmtpSender, build_idempotency_key

WH_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"


def _mp_update_status(data_dir, resend_id, status, queue):
    """多进程测试 worker：在子进程里对同一 data_dir 更新 provider_status。"""
    from email_gateway.store import EmailStore
    s = EmailStore(data_dir)
    changed = s.update_provider_status(resend_id, status)
    queue.put(changed)


class P0E1FactsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        self.store = EmailStore(self.data_dir)
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        os.environ["RESEND_WEBHOOK_SECRET"] = WH_SECRET
        os.environ["RESEND_WEBHOOK_TOLERANCE_SECONDS"] = "300"
        os.environ["RESEND_WEBHOOK_DEV_MODE"] = ""
        os.environ.pop("RESEND_API_KEY", None)
        os.environ.pop("FEISHU_WEBHOOK_URL", None)

        from dc_email_controller import dc_webhook_handler
        self.handler = dc_webhook_handler
        self.handler._store = None
        self.handler._store_db_path = None
        # 信号层 BY_ID 是模块级静态路径，需 reload 以指向当前 DC_DATA_DIR
        importlib.reload(importlib.import_module("dc_email_controller.dc_email_signals"))

    def tearDown(self):
        self.tmp.cleanup()

    # ── helpers ──────────────────────────────────────────
    def add_resend_account(self, email="proxy@mail.dealclaw.io"):
        return self.store.add_account(
            enterprise_id="co1", owner_open_id="ou_owner_1",
            email_address=email, provider="resend", secret_ref="env:TEST_EMAIL_SECRET",
        )

    def insert_outbound(self, **overrides):
        row = {
            "account_id": overrides.pop("account_id", "ema_x"),
            "direction": "outbound",
            "message_id": overrides.pop("message_id", "<out-1@example.com>"),
            "sender": overrides.pop("sender", "proxy@mail.dealclaw.io"),
            "recipients": overrides.pop("recipients", ["buyer@example.net"]),
            "subject": overrides.pop("subject", "Hello"),
            "status": "sent",
            "resend_id": overrides.pop("resend_id", "re_1"),
            "company_id": overrides.pop("company_id", "co1"),
            "campaign_id": overrides.pop("campaign_id", "camp1"),
            "lead_id": overrides.pop("lead_id", "lead1"),
            "contact_id": overrides.pop("contact_id", "ct1"),
            "provider_status": overrides.pop("provider_status", "accepted"),
        }
        row.update(overrides)
        self.store.insert_message(row)
        return row

    def sendlog_records(self):
        f = self.data_dir / "send_log.jsonl"
        if not f.exists():
            return []
        out = []
        for line in f.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except Exception:
                pass
        return out

    def svix_headers(self, payload, svix_id="msg_1", ts=None):
        ts = ts or str(int(__import__("time").time()))
        sig = self.handler._svix_signature(WH_SECRET, svix_id, ts, payload)
        return svix_id, ts, f"v1,{sig}"

    def make_fetch(self, *, message_id="<reply-1@example.net>", in_reply_to="<out-1@example.com>",
                   references=None, text="Interested, send catalog", from_="buyer@example.net",
                   to=None, subject="Re: Hello"):
        to = to or ["proxy@mail.dealclaw.io"]
        def fetch(email_id):
            return {
                "id": email_id,
                "from": from_,
                "to": to,
                "subject": subject,
                "text": text,
                "html": "",
                "headers": [
                    {"name": "Message-ID", "value": message_id},
                    {"name": "In-Reply-To", "value": in_reply_to},
                    {"name": "References", "value": " ".join(references or [])},
                ],
            }
        return fetch

    # ── 1 / 11 ───────────────────────────────────────────
    @patch("email_gateway.smtp_send.resend_send", return_value="re_real_123")
    def test_01_resend_id_persisted_with_identity(self, _mock):
        account = self.add_resend_account()
        sender = SmtpSender(self.store, secret_resolver=lambda _: "k")
        r = sender.send(
            account_id=account["account_id"], confirmed_by="ou_owner_1",
            to=["buyer@example.net"], subject="Hi", text="Body",
            company_id="co1", campaign_id="camp1", lead_id="lead1", contact_id="ct1",
        )
        self.assertTrue(r["ok"])
        self.assertEqual(r["resend_id"], "re_real_123")
        outbound = self.store.find_outbound_by_resend_id("re_real_123")
        # 因 2026-09-14「退信分流」变更：发信成功即乐观记 delivered（失败才留空），
        # 旧的 accepted 不再出现；后续退信由 webhook/IMAP NDR 回写 bounced。
        self.assertEqual(outbound["provider_status"], "delivered")
        self.assertEqual(outbound["campaign_id"], "camp1")

    # ── 2 ────────────────────────────────────────────────
    @patch("email_gateway.smtp_send.resend_send", return_value="re_real_123")
    def test_02_same_idempotency_key_does_not_send_twice(self, mock_send):
        account = self.add_resend_account()
        sender = SmtpSender(self.store, secret_resolver=lambda _: "k")
        kwargs = dict(account_id=account["account_id"], confirmed_by="ou_owner_1",
                      to=["buyer@example.net"], subject="Hi", text="Body",
                      company_id="co1", campaign_id="camp1", lead_id="lead1", contact_id="ct1",
                      touch_number=1, content_version="v1")
        self.assertTrue(sender.send(**kwargs)["ok"])
        r2 = sender.send(**kwargs)
        self.assertFalse(r2["ok"])
        self.assertTrue(r2.get("duplicate"))
        self.assertEqual(mock_send.call_count, 1)

    # ── 3 / 4 / 5 / 6 ────────────────────────────────────
    def test_03_delivered_webhook_idempotent(self):
        self.insert_outbound(account_id=self.add_resend_account()["account_id"], resend_id="re_1")
        self.assertTrue(self.handler.handle_status_event("email.delivered", {"email_id": "re_1"})["changed"])
        self.assertFalse(self.handler.handle_status_event("email.delivered", {"email_id": "re_1"})["changed"])
        self.assertEqual(self.store.find_outbound_by_resend_id("re_1")["provider_status"], "delivered")

    def test_04_bounced_marks_contact_no_push(self):
        self.insert_outbound(account_id=self.add_resend_account()["account_id"], resend_id="re_1")
        r = self.handler.handle_status_event("email.bounced", {"email_id": "re_1", "bounce": {"type": "Permanent", "message": "address not found"}})
        self.assertTrue(r["contact_invalid"])
        self.assertNotIn("push", r)

    def test_05_complained_blocks_future_send(self):
        self.insert_outbound(account_id=self.add_resend_account()["account_id"], resend_id="re_1")
        r = self.handler.handle_status_event("email.complained", {"email_id": "re_1"})
        self.assertTrue(r["suppressed"])
        self.assertEqual(self.store.find_outbound_by_resend_id("re_1")["provider_status"], "complained")

    def test_06_failed_saves_reason(self):
        self.insert_outbound(account_id=self.add_resend_account()["account_id"], resend_id="re_1")
        self.handler.handle_status_event("email.failed", {"email_id": "re_1", "reason": "smtp timeout"})
        self.assertIn("smtp timeout", self.store.find_outbound_by_resend_id("re_1")["failure_reason"])

    # ── 7 Svix 验签 ──────────────────────────────────────
    def test_07_missing_secret_rejects(self):
        os.environ.pop("RESEND_WEBHOOK_SECRET", None)
        os.environ["RESEND_WEBHOOK_DEV_MODE"] = ""
        ok, err, code = self.handler.signature_check("{}", "m", "1700000000", "v1,abc")
        self.assertFalse(ok)
        self.assertEqual(code, 503)

    def test_07_missing_headers_400(self):
        ok, err, code = self.handler.signature_check("{}", "", "1700000000", "v1,abc")
        self.assertFalse(ok)
        self.assertEqual(code, 400)
        self.assertIn("svix headers", err)

    def test_07_bad_signature_400(self):
        ok, err, code = self.handler.signature_check("{}", "m", "1700000000", "v1,badsig")
        self.assertFalse(ok)
        self.assertEqual(code, 400)

    def test_07_valid_signature_passes(self):
        svix_id, ts, sig = self.svix_headers('{"type":"email.delivered"}', svix_id="msg_x")
        ok, _, _ = self.handler.signature_check('{"type":"email.delivered"}', svix_id, ts, sig)
        self.assertTrue(ok)

    def test_07_timestamp_outside_window(self):
        ts = str(int(__import__("time").time()) - 100000)
        sig = self.handler._svix_signature(WH_SECRET, "m", ts, "{}")
        ok, err, code = self.handler.signature_check("{}", "m", ts, f"v1,{sig}")
        self.assertFalse(ok)
        self.assertEqual(code, 400)

    def test_07_dev_mode_bypass_warns(self):
        os.environ.pop("RESEND_WEBHOOK_SECRET", None)
        os.environ["RESEND_WEBHOOK_DEV_MODE"] = "true"
        ok, _, _ = self.handler.signature_check("{}", "m", "1700000000", "")
        self.assertTrue(ok)

    # ── 8 / 9 / 10 inbound（Receiving API 两层 fixture）──
    def test_08_inbound_binds_by_in_reply_to_and_logs_reply(self):
        acct = self.add_resend_account()
        self.insert_outbound(account_id=acct["account_id"], message_id="<out-1@example.com>", resend_id="re_1")
        fetch = self.make_fetch(in_reply_to="<out-1@example.com>")
        r = self.handler.handle_inbound_event({"email_id": "em_1", "from": "buyer@example.net", "to": ["proxy@mail.dealclaw.io"]}, fetch=fetch)
        self.assertTrue(r["matched"])
        self.assertEqual(r["campaign_id"], "camp1")
        self.assertEqual(r["lead_id"], "lead1")
        from dc_email_controller import dc_email_signals
        importlib.reload(dc_email_signals)
        replies = [s for s in dc_email_signals.list_signals("co1")
                   if s.get("signal_type") in ("quote_request", "sample_request", "meeting_interest", "missing_info")]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["campaign_id"], "camp1")

    def test_09_references_recovers_thread(self):
        acct = self.add_resend_account()
        self.insert_outbound(account_id=acct["account_id"], message_id="<out-2@example.com>", resend_id="re_2")
        fetch = self.make_fetch(in_reply_to="", references=["<out-2@example.com>"])
        r = self.handler.handle_inbound_event({"email_id": "em_2", "from": "buyer@example.net", "to": ["proxy@mail.dealclaw.io"]}, fetch=fetch)
        self.assertTrue(r["matched"])
        self.assertEqual(r["thread_id"], "<out-2@example.com>")

    def test_10_receiving_api_failure_retryable_no_reply(self):
        self.add_resend_account()
        def fail_fetch(email_id):
            raise RuntimeError("API down")
        r = self.handler.handle_inbound_event({"email_id": "em_1", "from": "buyer@example.net", "to": ["proxy@mail.dealclaw.io"]}, fetch=fail_fetch)
        self.assertEqual(r["status"], "retryable")
        self.assertEqual(r["failure_reason"], "receiving_api_failed")
        self.assertEqual(len([x for x in self.sendlog_records() if x.get("type") == "reply"]), 0)

    def test_10b_retry_no_duplicate_log_reply(self):
        acct = self.add_resend_account()
        self.insert_outbound(account_id=acct["account_id"], message_id="<out-1@example.com>", resend_id="re_1")
        fetch = self.make_fetch(in_reply_to="<out-1@example.com>")
        args = {"email_id": "em_1", "from": "buyer@example.net", "to": ["proxy@mail.dealclaw.io"]}
        self.assertTrue(self.handler.handle_inbound_event(args, fetch=fetch)["matched"])
        self.assertTrue(self.handler.handle_inbound_event(args, fetch=fetch)["matched"])
        from dc_email_controller import dc_email_signals
        importlib.reload(dc_email_signals)
        replies = [s for s in dc_email_signals.list_signals("co1")
                   if s.get("signal_type") in ("quote_request", "sample_request", "meeting_interest", "missing_info")]
        self.assertEqual(len(replies), 1)

    # ── 12 / 14 ──────────────────────────────────────────
    def test_12_unmatched_does_not_guess(self):
        self.add_resend_account()
        fetch = self.make_fetch(in_reply_to="<unknown@x.com>", from_="stranger@unknown.net")
        r = self.handler.handle_inbound_event({"email_id": "em_1", "from": "stranger@unknown.net", "to": ["proxy@mail.dealclaw.io"]}, fetch=fetch)
        self.assertEqual(r["status"], "unmatched")
        self.assertEqual(r["failure_reason"], "no_matching_outbound")

    # ── 13 open_id 冲突（app-scoped）──────────────────────
    def test_13_open_id_conflict_same_app(self):
        # PROXY_MAP(ou_3fe4922d, app cli_a936...) vs dc_email_bindings.json(ou_48fd0d8d, 无 app_id)
        binding, conflict = self.handler.resolve_binding("thia@mail.dealclaw.io")
        self.assertIsNone(binding)
        self.assertIsNotNone(conflict)
        # bindings.json 无 app_id → 不判同 app 冲突（cross_app）
        self.assertFalse(conflict.get("binding_conflict"))

    # ── 15 ───────────────────────────────────────────────
    def test_15_no_new_agent_push(self):
        self.insert_outbound(account_id=self.add_resend_account()["account_id"], resend_id="re_1")
        self.handler.handle_status_event("email.delivered", {"email_id": "re_1"})
        types = {r.get("type") for r in self.sendlog_records()}
        self.assertNotIn("push", types)

    # ── 18 svix-id 幂等存储 ──────────────────────────────
    def test_18_svix_id_idempotent_store(self):
        self.assertTrue(self.store.record_webhook_event("msg_1", "email.delivered", "re_1"))
        self.assertFalse(self.store.record_webhook_event("msg_1", "email.delivered", "re_1"))
        # 同一 email_id 不同 svix_id → 分别处理
        self.assertTrue(self.store.record_webhook_event("msg_2", "email.bounced", "re_1"))

    # ── 19 状态顺序保护 ──────────────────────────────────
    def test_19_status_ordering_late_delivered_no_override(self):
        self.insert_outbound(account_id=self.add_resend_account()["account_id"], resend_id="re_1", provider_status="accepted")
        self.assertTrue(self.store.update_provider_status("re_1", "delivered"))
        self.assertTrue(self.store.update_provider_status("re_1", "bounced", "not found"))
        # 迟到 delivered 不得覆盖 bounced
        self.assertFalse(self.store.update_provider_status("re_1", "delivered"))
        self.assertEqual(self.store.find_outbound_by_resend_id("re_1")["provider_status"], "bounced")

    # ── 20 Campaign 指标闭环 ─────────────────────────────
    def test_20_campaign_metrics_closure(self):
        import dc_campaign
        importlib.reload(dc_campaign)
        from dc_email_controller import dc_email_signals
        importlib.reload(dc_email_signals)  # BY_ID 是模块级静态路径，reload 以指向当前 DC_DATA_DIR
        acct = self.add_resend_account()
        # campaign1: sent + delivered + reply（quote_request 信号）
        self.store.insert_message({"account_id": acct["account_id"], "direction": "outbound",
                                   "local_message_id": "<out-1@example.com>", "resend_id": "re_1",
                                   "sender": "proxy@mail.dealclaw.io", "recipients": ["buyer@example.net"],
                                   "subject": "Hi", "status": "sent", "company_id": "co1",
                                   "campaign_id": "camp1", "lead_id": "lead1", "contact_id": "ct1",
                                   "provider_status": "delivered"})
        for s in dc_email_signals.classify_reply_signals(
                "Please send quote and MOQ.", source_message_id="<reply-1>",
                company_id="co1", campaign_id="camp1", lead_id="lead1", contact_id="ct1",
                thread_id="<out-1@example.com>"):
            dc_email_signals.record_signal(s)
        # campaign2（另一 Campaign，不得混入）
        self.store.insert_message({"account_id": acct["account_id"], "direction": "outbound",
                                   "local_message_id": "<out-2@example.com>", "resend_id": "re_2",
                                   "sender": "proxy@mail.dealclaw.io", "recipients": ["b2@example.net"],
                                   "subject": "Hi", "status": "sent", "company_id": "co1",
                                   "campaign_id": "camp2", "provider_status": "delivered"})

        m = dc_campaign.calculate_metrics("co1", "camp1")
        self.assertEqual(m["sent"], 1)
        self.assertEqual(m["delivered"], 1)
        self.assertEqual(m["replied"], 1)
        self.assertEqual(m["valid_inquiries"], 1)
        self.assertEqual(m["bounced"], 0)

        # 第二封 bounced
        self.store.insert_message({"account_id": acct["account_id"], "direction": "outbound",
                                   "local_message_id": "<out-3@example.com>", "resend_id": "re_3",
                                   "sender": "proxy@mail.dealclaw.io", "recipients": ["b3@example.net"],
                                   "subject": "Hi", "status": "sent", "company_id": "co1",
                                   "campaign_id": "camp1", "provider_status": "bounced"})
        m2 = dc_campaign.calculate_metrics("co1", "camp1")
        self.assertEqual(m2["sent"], 2)
        self.assertEqual(m2["delivered"], 1)
        self.assertEqual(m2["replied"], 1)
        self.assertEqual(m2["bounced"], 1)

    # ── 21 failed 重试 / 22 processing 不抢占 ──
    def test_21_webhook_failed_retry(self):
        self.store.record_webhook_event("svix_f1", "email.delivered", "re_1")
        self.store.mark_webhook_event_processed("svix_f1", "failed", "receiving_api_failed")
        self.assertEqual(self.store.claim_webhook_event("svix_f1"), "retry")

    def test_22_processing_not_preempted(self):
        self.store.record_webhook_event("svix_p1", "email.delivered", "re_1")
        self.assertEqual(self.store.claim_webhook_event("svix_p1"), "busy")
        self.store.mark_webhook_event_processed("svix_p1", "processed")
        self.assertEqual(self.store.claim_webhook_event("svix_p1"), "already_processed")

    # ── 23 Receiving API 路径 ──
    def test_23_receiving_api_path(self):
        captured = {}
        class _R:
            def __init__(self): self._d = b'{"id":"em_1","text":"hi","headers":[]}'
            def read(self): return self._d
            def __enter__(self): return self
            def __exit__(self, *a): return False
        def opener(req, timeout=None):
            captured["url"] = req.full_url
            return _R()
        self.handler.fetch_received_email("em_1", api_key="k", opener=opener)
        self.assertIn("/emails/receiving/em_1", captured["url"])

    # ── 24 进程重启后索引/幂等仍有效 ──
    def test_24_restart_indexes_persist(self):
        from email_gateway.store import MarkdownEmailStore
        self.insert_outbound(account_id=self.add_resend_account()["account_id"], resend_id="re_r1", idempotency_key="ik_r1")
        store2 = MarkdownEmailStore(self.data_dir)
        self.assertIsNotNone(store2.find_outbound_by_resend_id("re_r1"))
        self.assertTrue(store2.has_idempotency_key("ik_r1"))

    # ── 25 路径穿越拒绝 ──
    def test_25_path_traversal_rejected(self):
        self.insert_outbound(account_id=self.add_resend_account()["account_id"], resend_id="../../evil", idempotency_key="")
        self.assertFalse((self.data_dir.parent / "evil.md").exists())
        self.assertIsNotNone(self.store.find_outbound_by_resend_id("../../evil"))

    # ── 26 正文特殊字符可完整恢复 ──
    def test_26_body_special_chars_roundtrip(self):
        body = "line1\nline2\twith\"quotes\" and 中文\n\nend"
        acct = self.add_resend_account()
        self.store.insert_message({
            "account_id": acct["account_id"], "direction": "outbound",
            "local_message_id": "<out-special@example.com>", "resend_id": "re_s1",
            "sender": "proxy@mail.dealclaw.io", "recipients": ["buyer@example.net"],
            "subject": "S", "text": body, "company_id": "co1", "status": "sent",
        })
        self.assertEqual(self.store.find_outbound_by_resend_id("re_s1")["text"], body)

    # ── 27 跨日 svix replay ──
    def test_27_cross_day_svix_replay(self):
        self.assertEqual(self.store.claim_webhook_event("svix_123", "email.delivered", "re_1", "2026-08-15T00:00:00Z"), "claimed")
        self.store.mark_webhook_event_processed("svix_123", "processed")
        self.assertEqual(self.store.claim_webhook_event("svix_123", "email.delivered", "re_1", "2026-08-16T00:00:00Z"), "already_processed")
        by_id = list((self.data_dir / "email-facts" / "webhook-events" / "by-id").glob("*.md"))
        self.assertEqual(len(by_id), 1)
        history = []
        for f in (self.data_dir / "email-facts" / "webhook-events" / "history").glob("*.md"):
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    history.append(json.loads(line))
        statuses = [h["status"] for h in history]
        self.assertIn("received", statuses)
        self.assertIn("duplicate", statuses)
        self.assertIn("processed", statuses)

    # ── 28 delivery-events 历史保留 ──
    def test_28_delivery_events_history_preserved(self):
        self.insert_outbound(account_id=self.add_resend_account()["account_id"], resend_id="re_1", provider_status="accepted")
        self.assertTrue(self.store.update_provider_status("re_1", "delivered"))
        self.assertTrue(self.store.update_provider_status("re_1", "bounced", "not found"))
        events = []
        for f in (self.data_dir / "email-facts" / "delivery-events").glob("*.md"):
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    events.append(json.loads(line))
        self.assertEqual([e["event_type"] for e in events], ["delivered", "bounced"])
        self.assertEqual(self.store.find_outbound_by_resend_id("re_1")["provider_status"], "bounced")

    # ── 29 多进程锁（flock 进程级）──
    def test_29_multiprocess_lock(self):
        import multiprocessing
        self.insert_outbound(account_id=self.add_resend_account()["account_id"], resend_id="re_mp", provider_status="accepted")
        q = multiprocessing.Queue()
        p1 = multiprocessing.Process(target=_mp_update_status, args=(str(self.data_dir), "re_mp", "delivered", q))
        p2 = multiprocessing.Process(target=_mp_update_status, args=(str(self.data_dir), "re_mp", "bounced", q))
        p1.start(); p2.start(); p1.join(); p2.join()
        self.assertEqual(self.store.find_outbound_by_resend_id("re_mp")["provider_status"], "bounced")


if __name__ == "__main__":
    unittest.main()
