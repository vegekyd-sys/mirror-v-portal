#!/usr/bin/env python3
"""test_cron_notify_outbound.py — A. 通知出口收敛（cron_notify → dc_notify）回归测试

覆盖：
  A1. 出口可配置：默认 webhook（现有行为不回归）；DC_NOTIFY_OUTBOUND=dc_notify
      → NotifyEngine（publish → dispatch → mark_sent），且只发本轮 publish 的那几条。
  A2. 失败可诊断：CLI 真实错误行透传进 last_error（通知记录 + candidate 记录），
      不再只写 "dispatch failed"。
  A3. webhook 分支回归：卡片结构 / 发送 / 失败上报 与收敛前一致。

全部离线：不触网、不调真 CLI、不发消息、不写真实 data/。

运行：cd work/mio-api && python3 -m unittest tests.test_cron_notify_outbound -v
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "dc_email_controller"))

from dc_notify import (  # noqa: E402
    MockSender, NotifyEngine, SendResult, Sender, _cli_error,
)
from dc_email_controller import dc_signal_push as sig  # noqa: E402

from email_gateway import cron_notify  # noqa: E402

REAL_ERROR = 'Unknown account "0ae3af3617e2-im-bot" for channel openclaw-weixin.'
WEIXIN_TARGET = "o9cq80wxuc1hT1x2t8NA_rbfx20o@im.wechat"

EVENTS = [
    {
        "type": "mail.received",
        "account_id": "ema_test",
        "enterprise_id": "100000834234",
        "owner_open_id": "ou_owner",
        "email_address": "gege@mail.dealclaw.io",
        "uid": 4711,
        "message_id": "<msg-1@mail.gmail.com>",
        "from": "buyer@example.com",
        "subject": "询盘：G25 报价",
        "related": True,
        "preview": "请问 G25 什么价格？数量 5 台",
    }
]


class _FakeSyncer:
    """替身 IMAP 同步器：返回固定 events，不碰网络。"""

    def __init__(self, store=None, events=None):
        self.store = store
        self._events = EVENTS if events is None else events

    def sync_account(self, account_id, **kwargs):
        events = self._events

        class _Result:
            def as_dict(self_inner):
                return {"account_id": account_id, "events": events}

        return _Result()


class _FailingSender(Sender):
    """固定失败的发送器：error 就是底层真实错误（模拟 WeixinSender 输出）。"""

    def __init__(self, error: str = REAL_ERROR):
        self.error = error
        self.sent: list[dict] = []

    def send(self, target, message, idempotency_key=None):
        return SendResult(ok=False, error=self.error, backend="weixin")


def _engine(tmp: Path, sender=None) -> NotifyEngine:
    return NotifyEngine(data_dir=tmp, sender=sender or MockSender())


def _env(**kv):
    kv.setdefault("DC_NOTIFY_ALLOWED_COMPANIES", "")
    return mock.patch.dict(os.environ, {k: str(v) for k, v in kv.items()}, clear=False)


# ── A1 · 出口默认 = webhook（不回归）─────────────────────


class OutboundModeTest(unittest.TestCase):
    def test_default_is_webhook(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DC_NOTIFY_OUTBOUND", None)
            self.assertEqual(cron_notify._outbound_mode(), "webhook")

    def test_dc_notify_mode(self):
        with _env(DC_NOTIFY_OUTBOUND="dc_notify"):
            self.assertEqual(cron_notify._outbound_mode(), "dc_notify")

    def test_card_structure_unchanged(self):
        card = cron_notify._build_webhook_card(EVENTS, "")
        self.assertEqual(card["msg_type"], "interactive")
        self.assertIn("新邮件提醒 · 1 封", card["card"]["header"]["title"]["content"])
        text = json.dumps(card, ensure_ascii=False)
        self.assertIn("buyer@example.com", text)
        self.assertIn("询盘：G25 报价", text)
        self.assertIn("数量 5 台", text)

    def test_webhook_path_still_used_by_default(self):
        tmp = Path(tempfile.mkdtemp(prefix="cron-notify-webhook-"))
        calls: list[tuple] = []
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(cron_notify, "ImapSynchronizer", _FakeSyncer), \
                mock.patch.object(cron_notify, "_send_webhook",
                                  lambda url, secret, payload: calls.append((url, payload))):
            os.environ.pop("DC_NOTIFY_OUTBOUND", None)
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = cron_notify.main(["--data-dir", str(tmp), "--account-id", "ema_test",
                                       "--webhook", "https://example.invalid/hook"])
        self.assertEqual(rc, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "https://example.invalid/hook")
        self.assertIn("NO_REPLY", buf.getvalue())
        # 默认模式下不应创建任何 dc_notify 通知文件
        self.assertFalse((tmp / "notifications" / "sent.md").exists())

    def test_webhook_failure_still_raises(self):
        tmp = Path(tempfile.mkdtemp(prefix="cron-notify-webhook-fail-"))

        def _boom(url, secret, payload):
            raise RuntimeError("webhook boom")

        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(cron_notify, "ImapSynchronizer", _FakeSyncer), \
                mock.patch.object(cron_notify, "_send_webhook", _boom):
            os.environ.pop("DC_NOTIFY_OUTBOUND", None)
            with self.assertRaises(RuntimeError):
                cron_notify.main(["--data-dir", str(tmp), "--account-id", "ema_test",
                                  "--webhook", "https://example.invalid/hook"])


# ── A1 · dc_notify 分支（publish → dispatch → mark_sent）──


class DcNotifyOutboundTest(unittest.TestCase):
    def test_publish_dispatch_mark_sent(self):
        tmp = Path(tempfile.mkdtemp(prefix="cron-notify-dc-"))
        sender = MockSender()
        engine = _engine(tmp, sender)
        cid = cron_notify._dc_notify_company_id("100000834234")
        engine.set_route(cid, WEIXIN_TARGET)
        with _env():
            out = cron_notify.notify_events_via_dc_notify(
                EVENTS, account_id="ema_test", enterprise_id="100000834234", engine=engine)
        self.assertEqual(out["status"], "dispatched")
        self.assertEqual(out["published"], 1)
        self.assertEqual([r["status"] for r in out["results"]], ["sent"])
        # sender 收到的是解析后的 weixin target + 纯文本正文
        self.assertEqual(len(sender.sent), 1)
        self.assertEqual(sender.sent[0]["target"], WEIXIN_TARGET)
        self.assertIn("询盘：G25 报价", sender.sent[0]["message"])
        self.assertIn("数量 5 台", sender.sent[0]["message"])
        # 通知记录：pending 清空、sent 落库
        self.assertEqual(engine.store.read_pending(), [])
        sent = engine.store.read_sent()
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["status"], "sent")
        self.assertEqual(sent[0]["kind"], "signal_item")
        self.assertEqual(sent[0]["company_id"], cid)
        self.assertTrue(sent[0]["sent_at"])

    def test_only_the_published_notifications_are_dispatched(self):
        """只发本轮 publish 的那条，不误带别人 pending 的通知一起发。"""
        tmp = Path(tempfile.mkdtemp(prefix="cron-notify-dc-only-"))
        sender = MockSender()
        engine = _engine(tmp, sender)
        cid = cron_notify._dc_notify_company_id("100000834234")
        engine.set_route(cid, WEIXIN_TARGET)
        other = engine.publish(cid, "signal_item", payload={"message": "别人的 pending"},
                               dedupe_key="signal-push:other", slot="realtime")
        with _env():
            out = cron_notify.notify_events_via_dc_notify(
                EVENTS, account_id="ema_test", enterprise_id="100000834234", engine=engine)
        self.assertEqual(out["status"], "dispatched")
        self.assertEqual(len(sender.sent), 1)
        self.assertIn("询盘：G25 报价", sender.sent[0]["message"])
        still_pending = [r["notification_id"] for r in engine.store.read_pending()]
        self.assertEqual(still_pending, [other["notification_id"]])

    def test_route_missing_reports_route_error_without_sending(self):
        tmp = Path(tempfile.mkdtemp(prefix="cron-notify-dc-noroute-"))
        sender = MockSender()
        engine = _engine(tmp, sender)  # 不设 route
        with _env():
            out = cron_notify.notify_events_via_dc_notify(
                EVENTS, account_id="ema_test", enterprise_id="100000834234", engine=engine)
        self.assertEqual(out["status"], "route_error")
        self.assertEqual(sender.sent, [])
        self.assertEqual(len(engine.store.read_pending()), 1)  # 保留 pending，不静默丢

    def test_main_in_dc_notify_mode_end_to_end(self):
        tmp = Path(tempfile.mkdtemp(prefix="cron-notify-dc-main-"))
        sender = MockSender()
        engine = _engine(tmp, sender)
        cid = cron_notify._dc_notify_company_id("")
        engine.set_route(cid, WEIXIN_TARGET)
        with _env(DC_NOTIFY_OUTBOUND="dc_notify", MIO_CDP_SUPPLIER_ID=""), \
                mock.patch.object(cron_notify, "ImapSynchronizer", _FakeSyncer), \
                mock.patch.object(cron_notify, "_dc_notify_engine", lambda: engine):
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = cron_notify.main(["--data-dir", str(tmp), "--account-id", "ema_test"])
        self.assertEqual(rc, 0)
        self.assertEqual(len(sender.sent), 1)
        self.assertEqual([r["status"] for r in engine.store.read_sent()], ["sent"])
        self.assertIn("NO_REPLY", buf.getvalue())

    def test_main_reports_real_error_on_failed_dispatch(self):
        tmp = Path(tempfile.mkdtemp(prefix="cron-notify-dc-fail-"))
        engine = _engine(tmp, _FailingSender())
        cid = cron_notify._dc_notify_company_id("")
        engine.set_route(cid, WEIXIN_TARGET)
        with _env(DC_NOTIFY_OUTBOUND="dc_notify", MIO_CDP_SUPPLIER_ID=""), \
                mock.patch.object(cron_notify, "ImapSynchronizer", _FakeSyncer), \
                mock.patch.object(cron_notify, "_dc_notify_engine", lambda: engine):
            with self.assertRaises(RuntimeError) as cm:
                cron_notify.main(["--data-dir", str(tmp), "--account-id", "ema_test"])
        self.assertIn("Unknown account", str(cm.exception))


# ── A2 · 真实错误透传 ──────────────────────────────────


class ErrorPropagationTest(unittest.TestCase):
    def test_cli_error_extracts_real_line_and_drops_cli_noise(self):
        stderr = ('\n Unknown account "0ae3af3617e2-im-bot" for channel openclaw-weixin.\n'
                  '[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace.\n'
                  '[openclaw] Try: openclaw doctor\n')
        self.assertEqual(_cli_error("", stderr), REAL_ERROR)

    def test_weixin_sender_error_is_real_reason(self):
        with mock.patch.dict(os.environ, {"DC_NOTIFY_WEIXIN_ACCOUNT": "0ae3af3617e2-im-bot"}), \
                mock.patch("subprocess.run", return_value=SimpleNamespace(
                    returncode=1, stdout="",
                    stderr='\n Unknown account "0ae3af3617e2-im-bot" for channel openclaw-weixin.\n'
                           '[openclaw] Help: openclaw --help\n')):
            from dc_notify import WeixinSender
            res = WeixinSender(enabled=True).send(WEIXIN_TARGET, "hi")
        self.assertFalse(res.ok)
        self.assertEqual(res.error, REAL_ERROR)

    def test_notification_record_keeps_real_error(self):
        tmp = Path(tempfile.mkdtemp(prefix="cron-notify-a2-rec-"))
        engine = _engine(tmp, _FailingSender())
        engine.set_route("c1", WEIXIN_TARGET)
        with _env():
            engine.publish("c1", "signal_item", payload={"message": "买家想报价"},
                           dedupe_key="signal-push:a2", slot="realtime")
            dr = engine.dispatch("c1", slot="realtime")
        self.assertEqual(dr["results"][0]["status"], "failed")
        self.assertEqual(dr["results"][0]["error"], REAL_ERROR)
        failed = engine.store.read_failed()
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["last_error"], REAL_ERROR)

    def test_candidate_records_real_error_instead_of_dispatch_failed(self):
        tmp = Path(tempfile.mkdtemp(prefix="cron-notify-a2-cand-"))
        (tmp / "by-id").mkdir(parents=True, exist_ok=True)
        (tmp / "locks").mkdir(parents=True, exist_ok=True)
        cid = "cand_a2_real_error"
        engine = _engine(tmp, _FailingSender())
        engine.set_route("c1", WEIXIN_TARGET)
        pub = engine.publish("c1", "signal_item", payload={"message": "买家想报价"},
                             dedupe_key=f"signal-push:{cid}", slot="realtime")
        with _env(), \
                mock.patch.object(sig, "BY_ID", tmp / "by-id"), \
                mock.patch.object(sig, "LOCKS", tmp / "locks"), \
                mock.patch.object(sig, "HISTORY", tmp / "history"), \
                mock.patch.object(sig, "publish_candidate",
                                  lambda c: {"status": "published",
                                             "notification_id": pub["notification_id"]}), \
                mock.patch("dc_notify.NotifyEngine", lambda *a, **k: engine):
            self.assertTrue(sig.record_candidate({"candidate_id": cid, "company_id": "c1",
                                                  "status": "proposed"}))
            pushed = sig._deliver_live([{"candidate_id": cid, "company_id": "c1"}])
            rec = sig.get_candidate(cid)
        self.assertEqual(pushed, [])
        self.assertEqual(rec["status"], "failed")
        self.assertIn(REAL_ERROR, rec["last_error"])
        self.assertIn("dispatch failed", rec["last_error"])

    def test_dispatch_failure_reason_falls_back_when_no_result_error(self):
        reason = sig._dispatch_failure_reason({"status": "dispatched", "results": [
            {"notification_id": "n_1", "status": "failed", "error": ""},
            {"notification_id": "n_2", "status": "sent"},
        ]})
        self.assertIn("dispatch failed", reason)


if __name__ == "__main__":
    unittest.main(verbosity=2)
