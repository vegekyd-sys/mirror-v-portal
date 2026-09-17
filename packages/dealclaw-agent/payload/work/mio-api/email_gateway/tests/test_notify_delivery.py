"""通知投递层测试：通道选择、失败回退、一键回退模式、全局开关尊重。

对应改造：去群机器人（应用机器人优先），但保留 webhook 回退与 webhook_only 一键回退。
"""

import os
import sys
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from dc_notify import MockSender, SendResult  # noqa: E402
from email_gateway import notify_delivery as nd  # noqa: E402


class FakeWebhook:
    """记录 webhook 调用；可注入失败。"""

    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def __call__(self, url, secret, payload):
        self.calls.append({"url": url, "secret": secret, "payload": payload})
        if self.fail:
            raise RuntimeError("webhook down")


class DeliveryModeTests(unittest.TestCase):
    def tearDown(self):
        os.environ.pop(nd.DELIVERY_MODE_ENV, None)

    def test_default_is_app_bot_first(self):
        self.assertEqual(nd.delivery_mode(), "app_bot_first")

    def test_env_override_and_unknown_falls_back_to_default(self):
        os.environ[nd.DELIVERY_MODE_ENV] = "webhook_only"
        self.assertEqual(nd.delivery_mode(), "webhook_only")
        os.environ[nd.DELIVERY_MODE_ENV] = "nonsense"
        self.assertEqual(nd.delivery_mode(), "app_bot_first")

    def test_explicit_arg_wins(self):
        os.environ[nd.DELIVERY_MODE_ENV] = "webhook_only"
        self.assertEqual(nd.delivery_mode("app_bot_only"), "app_bot_only")


class PlanChannelsTests(unittest.TestCase):
    def test_both_available_app_bot_first(self):
        b = {"chat_id": "ou_x", "webhook_url": "https://hook"}
        self.assertEqual(nd.plan_channels(b), ["app_bot", "webhook"])

    def test_only_chat_id(self):
        self.assertEqual(nd.plan_channels({"chat_id": "oc_x"}), ["app_bot"])

    def test_only_webhook(self):
        self.assertEqual(nd.plan_channels({"webhook_url": "https://hook"}), ["webhook"])

    def test_none_available(self):
        self.assertEqual(nd.plan_channels({}), [])
        self.assertEqual(nd.plan_channels({"chat_id": "bad_target"}), [])

    def test_global_fallback_webhook_counts(self):
        self.assertEqual(nd.plan_channels({}, fallback_webhook="https://global"), ["webhook"])

    def test_webhook_only_mode_ignores_chat_id(self):
        b = {"chat_id": "ou_x", "webhook_url": "https://hook"}
        self.assertEqual(nd.plan_channels(b, "webhook_only"), ["webhook"])

    def test_app_bot_only_mode_ignores_webhook(self):
        b = {"chat_id": "ou_x", "webhook_url": "https://hook"}
        self.assertEqual(nd.plan_channels(b, "app_bot_only"), ["app_bot"])

    def test_app_bot_only_without_target_is_empty(self):
        self.assertEqual(nd.plan_channels({"webhook_url": "https://hook"}, "app_bot_only"), [])


class DeliverTests(unittest.TestCase):
    def test_app_bot_success(self):
        sender = MockSender()
        wh = FakeWebhook()
        b = {"chat_id": "ou_x", "webhook_url": "https://hook"}
        r = nd.deliver(b, text="hello", card={"msg_type": "interactive"}, sender=sender,
                       webhook_send=wh)
        self.assertTrue(r["ok"])
        self.assertEqual(r["channel"], "app_bot")
        self.assertFalse(r["fallback"])
        self.assertEqual(len(sender.sent), 1)
        self.assertEqual(wh.calls, [])  # 不应触碰 webhook

    def test_falls_back_to_webhook_when_app_bot_fails(self):
        sender = MockSender(fail_on=lambda rec: True)
        wh = FakeWebhook()
        b = {"chat_id": "ou_x", "webhook_url": "https://hook", "webhook_secret": "s"}
        r = nd.deliver(b, text="hello", card={"msg_type": "interactive"}, sender=sender,
                       webhook_send=wh)
        self.assertTrue(r["ok"])
        self.assertEqual(r["channel"], "webhook")
        self.assertTrue(r["fallback"])
        self.assertEqual(len(wh.calls), 1)
        self.assertTrue([a for a in r["attempts"] if a["channel"] == "app_bot" and not a["ok"]])

    def test_all_channels_fail_reports_error(self):
        sender = MockSender(fail_on=lambda rec: True)
        wh = FakeWebhook(fail=True)
        b = {"chat_id": "ou_x", "webhook_url": "https://hook"}
        r = nd.deliver(b, text="hello", sender=sender, webhook_send=wh)
        self.assertFalse(r["ok"])
        self.assertEqual(r["channel"], "")
        self.assertIn("app_bot", r["error"])
        self.assertIn("webhook", r["error"])

    def test_no_channel_available(self):
        r = nd.deliver({}, text="hello", sender=MockSender())
        self.assertFalse(r["ok"])
        self.assertIn("no delivery channel", r["error"])

    def test_empty_payload(self):
        r = nd.deliver({"chat_id": "ou_x"}, text="", card=None, sender=MockSender())
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "empty payload")

    def test_dry_run_does_not_fall_back_to_webhook(self):
        """全局发送开关关闭时，不得回退到 webhook（否则等于绕过开关）。"""
        class DrySender:
            def send(self, target, message, idempotency_key=None):
                return SendResult(ok=True, dry_run=True, sent=False, backend="feishu")

        wh = FakeWebhook()
        b = {"chat_id": "ou_x", "webhook_url": "https://hook"}
        r = nd.deliver(b, text="hello", sender=DrySender(), webhook_send=wh)
        self.assertFalse(r["ok"])
        self.assertEqual(wh.calls, [])
        self.assertIn("dry_run", r["error"])

    def test_webhook_only_mode_never_touches_app_bot(self):
        sender = MockSender()
        wh = FakeWebhook()
        b = {"chat_id": "ou_x", "webhook_url": "https://hook"}
        r = nd.deliver(b, text="hello", mode="webhook_only", sender=sender, webhook_send=wh)
        self.assertTrue(r["ok"])
        self.assertEqual(r["channel"], "webhook")
        self.assertEqual(sender.sent, [])

    def test_app_bot_receives_chat_id_target(self):
        sender = MockSender()
        nd.deliver({"chat_id": "ou_abc"}, text="hi", sender=sender)
        self.assertEqual(sender.sent[0]["target"], "ou_abc")

    def test_text_used_for_app_bot_and_card_for_webhook(self):
        sender = MockSender()
        wh = FakeWebhook()
        b = {"chat_id": "ou_x", "webhook_url": "https://hook"}
        nd.deliver(b, text="PLAIN", card={"msg_type": "interactive", "card": {}},
                   sender=sender, webhook_send=wh)
        self.assertEqual(sender.sent[0]["message"], "PLAIN")


if __name__ == "__main__":
    unittest.main()
