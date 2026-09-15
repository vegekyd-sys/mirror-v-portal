"""微信通道接入投递层（2026-09-15 田耕郡：「飞书这套投递方式在微信是否同样适用」）。

背景：投递层原先只认飞书目标（``oc_`` / ``ou_``），微信侧没有通道 → 「回信通知回
发信会话」这条新逻辑只在飞书生效。本次接法：
  · ``im_channel_for`` 统一目标形态判断：``oc_/ou_`` → ``app_bot``；``@im.wechat`` → ``weixin``
  · ``plan_channels`` 按形态排通道；微信**不排** webhook（群自定义机器人只有飞书有）
  · ``deliver`` 微信通道走 ``WeixinSender``（与 ``dc_notify`` 同一实现，不复制发送逻辑）
  · ``resolve_notify_binding`` 的 origin 目标不再限定飞书形态，微信会话也能当「发信窗口」

回滚：``DC_NOTIFY_DELIVERY=webhook_only``（不走 IM 通道）；或直接 revert 本提交。

跑法：
  cd <mio-api> && python3 -m unittest discover -s email_gateway/tests -t . -p "test_notify_delivery_weixin.py"
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway.inbound_poller import resolve_notify_binding  # noqa: E402
from email_gateway.notify_delivery import (  # noqa: E402
    deliver,
    im_channel_for,
    plan_channels,
)
from email_gateway.store import EmailStore  # noqa: E402

WX = "wxid_abc123@im.wechat"
FS_GROUP = "oc_some_group"
FS_DM = "ou_some_user"
ENT = "test-tuozhu"
ADDR = "proxy@mail.dealclaw.io"


class _Result:
    def __init__(self, ok=True, error="", dry_run=False, message_id="m1"):
        self.ok = ok
        self.error = error
        self.dry_run = dry_run
        self.message_id = message_id
        self.sent = ok and not dry_run


class _FakeSender:
    def __init__(self, ok=True, error="", dry_run=False):
        self.calls: list[tuple[str, str]] = []
        self._res = _Result(ok=ok, error=error, dry_run=dry_run)

    def send(self, target, message, idempotency_key=None):
        self.calls.append((target, message))
        return self._res


class ChannelDetection(unittest.TestCase):
    def test_target_shape_mapping(self):
        self.assertEqual(im_channel_for(WX), "weixin")
        self.assertEqual(im_channel_for(FS_GROUP), "app_bot")
        self.assertEqual(im_channel_for(FS_DM), "app_bot")
        self.assertEqual(im_channel_for(""), "")
        self.assertEqual(im_channel_for("random-id"), "")

    def test_wechat_target_plans_weixin_only(self):
        self.assertEqual(plan_channels({"chat_id": WX}), ["weixin"])

    def test_wechat_target_does_not_plan_webhook(self):
        """群自定义机器人只有飞书有：微信目标即便绑定了 webhook 也不排该通道。"""
        binding = {"chat_id": WX, "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/x"}
        self.assertEqual(plan_channels(binding), ["weixin"])

    def test_feishu_targets_unchanged(self):
        self.assertEqual(plan_channels({"chat_id": FS_GROUP}), ["app_bot"])
        self.assertEqual(
            plan_channels({"chat_id": FS_GROUP, "webhook_url": "https://hook/x"}),
            ["app_bot", "webhook"],
        )

    def test_modes_apply_to_weixin(self):
        self.assertEqual(plan_channels({"chat_id": WX}, "app_bot_only"), ["weixin"])
        self.assertEqual(plan_channels({"chat_id": WX}, "webhook_only"), [])


class DeliverViaWeixin(unittest.TestCase):
    def test_wechat_delivery_uses_injected_sender(self):
        sender = _FakeSender()
        res = deliver({"chat_id": WX}, text="买家回信了", weixin_sender=sender)
        self.assertTrue(res["ok"])
        self.assertEqual(res["channel"], "weixin")
        self.assertEqual(sender.calls, [(WX, "买家回信了")])
        self.assertFalse(res["fallback"])

    def test_wechat_failure_is_visible(self):
        sender = _FakeSender(ok=False, error="openclaw not found")
        res = deliver({"chat_id": WX}, text="x", weixin_sender=sender)
        self.assertFalse(res["ok"])
        self.assertIn("openclaw not found", res["error"])
        self.assertEqual(res["attempts"][0]["channel"], "weixin")

    def test_wechat_dry_run_respects_global_switch(self):
        sender = _FakeSender(dry_run=True)
        res = deliver({"chat_id": WX}, text="x", weixin_sender=sender)
        self.assertFalse(res["ok"], "全局发送开关关闭时不得当作成功")
        self.assertIn("dry_run", res["error"])

    def test_feishu_still_uses_app_bot_sender(self):
        fs_sender = _FakeSender()
        wx_sender = _FakeSender()
        res = deliver({"chat_id": FS_GROUP}, text="x", sender=fs_sender, weixin_sender=wx_sender)
        self.assertTrue(res["ok"])
        self.assertEqual(res["channel"], "app_bot")
        self.assertEqual(len(fs_sender.calls), 1)
        self.assertEqual(wx_sender.calls, [], "飞书目标不得走微信通道")


class OriginRouting(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._env = mock.patch.dict(os.environ, {"DC_DATA_DIR": self._tmp.name})
        self._env.start()
        self.store = EmailStore(Path(self._tmp.name))

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def test_wechat_origin_becomes_notify_target(self):
        out = resolve_notify_binding(origin_notify_target=WX, account_id="ema_x",
                                     address=ADDR, store=self.store)
        self.assertEqual(out["source"], "origin")
        self.assertEqual(out["chat_id"], WX)

    def test_feishu_origin_unchanged(self):
        out = resolve_notify_binding(origin_notify_target=FS_GROUP, account_id="ema_x",
                                     address=ADDR, store=self.store)
        self.assertEqual(out["source"], "origin")
        self.assertEqual(out["chat_id"], FS_GROUP)

    def test_invalid_origin_falls_back_or_empty(self):
        out = resolve_notify_binding(origin_notify_target="not-a-target", account_id="ema_x",
                                     address="", store=self.store)
        self.assertEqual(out, {}, "非法 origin 且无绑定时应返回空，不能当成有效目标")

    def test_wechat_origin_then_delivers_via_weixin(self):
        binding = resolve_notify_binding(origin_notify_target=WX, account_id="ema_x",
                                         address=ADDR, store=self.store)
        self.assertEqual(plan_channels(binding), ["weixin"])
        sender = _FakeSender()
        res = deliver(binding, text="草稿已就绪", weixin_sender=sender)
        self.assertTrue(res["ok"])
        self.assertEqual(res["channel"], "weixin")


if __name__ == "__main__":
    unittest.main()
