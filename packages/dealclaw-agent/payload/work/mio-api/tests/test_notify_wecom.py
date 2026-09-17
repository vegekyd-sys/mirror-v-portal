#!/usr/bin/env python3
"""test_notify_wecom.py — 企业微信通知通道回归测试（2026-09-17）

背景：回信已经取回、也匹配上了，但通知通道只有飞书/微信两个发送器，
配置写死 DC_NOTIFY_SENDER_MODE=weixin → 从企业微信进来的用户收不到通知。
本次补上第三条通道（wecom），本文件覆盖可自动化的部分：

  1. 工厂：feishu / weixin / wecom / 未知 → disabled（默认 feishu）
  2. WecomSender：参数校验、dry-run、CLI 参数拼装（--channel wecom）、失败与 message_id 解析
  3. 目标形态：@im.wecom → wecom；@im.wechat → weixin；oc_/ou_ → app_bot；其它 → 空
  4. 投递计划：企微目标只排 wecom（不排飞书 webhook 回退）
  5. 推送开关 _push_enabled 必须认 wecom（否则改完通道仍 push_disabled）

全部离线：不触网、不调用真 CLI、不发消息、不写真实数据。

运行：cd work/mio-api && python3 -m unittest tests.test_notify_wecom -v
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "dc_email_controller"))

from dc_notify import (  # noqa: E402
    DisabledSender, FeishuSender, WecomSender, WeixinSender, build_sender_from_env,
)
from email_gateway.notify_delivery import im_channel_for, plan_channels  # noqa: E402


def _clean_env():
    keys = ["DC_NOTIFY_SENDER_MODE", "DC_NOTIFY_SEND_ENABLED",
            "DC_NOTIFY_WECOM_ACCOUNT", "DC_NOTIFY_WECOM_CHANNEL"]
    return mock.patch.dict(os.environ, {k: "" for k in keys}, clear=False)


class SenderFactoryTest(unittest.TestCase):
    def _build(self, mode=None, **env):
        saved = os.environ.pop("DC_NOTIFY_SENDER_MODE", None)
        try:
            with _clean_env():
                os.environ.pop("DC_NOTIFY_SENDER_MODE", None)
                if mode is not None:
                    os.environ["DC_NOTIFY_SENDER_MODE"] = mode
                for k, v in env.items():
                    os.environ[k] = str(v)
                return build_sender_from_env()
        finally:
            if saved is not None:
                os.environ["DC_NOTIFY_SENDER_MODE"] = saved

    def test_1_wecom_mode_returns_wecom_sender(self):
        self.assertIsInstance(self._build("wecom"), WecomSender)

    def test_2_existing_modes_unchanged(self):
        self.assertIsInstance(self._build("feishu"), FeishuSender)
        self.assertIsInstance(self._build("weixin"), WeixinSender)

    def test_3_unknown_mode_disabled_and_default_is_feishu(self):
        self.assertIsInstance(self._build("yolo"), DisabledSender)
        self.assertIsInstance(self._build(None), FeishuSender)


class WecomSenderTest(unittest.TestCase):
    def test_4_validates_target_and_message(self):
        s = WecomSender(enabled=True)
        self.assertFalse(s.send("", "hi").ok)
        self.assertFalse(s.send("u1@im.wecom", "").ok)

    def test_5_disabled_is_dry_run_not_sent(self):
        with _clean_env():
            os.environ["DC_NOTIFY_SEND_ENABLED"] = "0"
            s = WecomSender()
            res = s.send("u1@im.wecom", "hello")
        self.assertTrue(res.ok)
        self.assertTrue(res.dry_run)
        self.assertFalse(res.sent)
        self.assertEqual(res.backend, "wecom")

    def test_6_cli_argv_uses_wecom_channel(self):
        with _clean_env():
            os.environ["DC_NOTIFY_WECOM_ACCOUNT"] = "default"
            s = WecomSender(enabled=True)
            captured = {}

            def fake_run(cmd, **kw):
                captured["cmd"] = cmd
                return subprocess.CompletedProcess(cmd, 0, json.dumps({"data": {"message_id": "m1"}}), "")

            with mock.patch.object(subprocess, "run", fake_run):
                res = s.send("u1@im.wecom", "hello")
        cmd = captured["cmd"]
        self.assertEqual(cmd[:3], ["openclaw", "message", "send"])
        self.assertIn("--channel", cmd)
        self.assertEqual(cmd[cmd.index("--channel") + 1], "wecom")
        self.assertEqual(cmd[cmd.index("--account") + 1], "default")
        self.assertEqual(cmd[cmd.index("--target") + 1], "u1@im.wecom")
        self.assertEqual(cmd[cmd.index("--message") + 1], "hello")
        self.assertTrue(res.sent)
        self.assertEqual(res.message_id, "m1")

    def test_7_channel_name_overridable(self):
        with _clean_env():
            os.environ["DC_NOTIFY_WECOM_CHANNEL"] = "wecom-corp"
            s = WecomSender(enabled=True)
            captured = {}
            with mock.patch.object(subprocess, "run",
                                   lambda cmd, **kw: captured.update(cmd=cmd) or
                                   subprocess.CompletedProcess(cmd, 0, "{}", "")):
                s.send("u1@im.wecom", "hi")
        self.assertEqual(captured["cmd"][captured["cmd"].index("--channel") + 1], "wecom-corp")

    def test_8_cli_failure_reported_not_swallowed(self):
        s = WecomSender(enabled=True)
        with mock.patch.object(subprocess, "run",
                               lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, "", "boom")):
            res = s.send("u1@im.wecom", "hi")
        self.assertFalse(res.ok)
        self.assertFalse(res.sent)
        self.assertIn("boom", res.error)

    def test_9_openclaw_missing_is_honest(self):
        s = WecomSender(enabled=True)

        def raise_fnf(cmd, **kw):
            raise FileNotFoundError("openclaw")

        with mock.patch.object(subprocess, "run", raise_fnf):
            res = s.send("u1@im.wecom", "hi")
        self.assertFalse(res.ok)
        self.assertIn("openclaw not found", res.error)


class TargetFormTest(unittest.TestCase):
    def test_10_target_forms_map_to_channels(self):
        self.assertEqual(im_channel_for("someone@im.wecom"), "wecom")
        self.assertEqual(im_channel_for("someone@im.wechat"), "weixin")
        self.assertEqual(im_channel_for("ou_abc"), "app_bot")
        self.assertEqual(im_channel_for("oc_abc"), "app_bot")
        self.assertEqual(im_channel_for("weird-target"), "")

    def test_11_wecom_binding_plans_only_wecom_channel(self):
        binding = {"chat_id": "someone@im.wecom", "webhook_url": "https://example.com/hook"}
        self.assertEqual(plan_channels(binding, "app_bot_first"), ["wecom"])
        self.assertEqual(plan_channels(binding, "app_bot_only"), ["wecom"])
        self.assertEqual(plan_channels(binding, "webhook_only"), [])

    def test_12_weixin_and_feishu_plans_unchanged(self):
        self.assertEqual(plan_channels({"chat_id": "x@im.wechat"}, "app_bot_first"), ["weixin"])
        self.assertEqual(plan_channels({"chat_id": "oc_x", "webhook_url": "https://e/h"},
                                       "app_bot_first"), ["app_bot", "webhook"])


class PushEnabledTest(unittest.TestCase):
    def test_13_push_enabled_accepts_wecom_mode(self):
        from dc_signal_push import _push_enabled
        with _clean_env():
            os.environ.update({
                "DC_SIGNAL_PUSH_AUTOMATION_MODE": "live",
                "DC_NOTIFY_SENDER_MODE": "wecom",
                "DC_NOTIFY_SEND_ENABLED": "1",
            })
            ok, reason = _push_enabled("C1")
        self.assertTrue(ok, reason)

    def test_14_push_enabled_still_rejects_unknown_mode(self):
        from dc_signal_push import _push_enabled
        with _clean_env():
            os.environ.update({
                "DC_SIGNAL_PUSH_AUTOMATION_MODE": "live",
                "DC_NOTIFY_SENDER_MODE": "yolo",
                "DC_NOTIFY_SEND_ENABLED": "1",
            })
            ok, reason = _push_enabled("C1")
        self.assertFalse(ok)
        self.assertEqual(reason, "push_disabled")


class MultiChannelTest(unittest.TestCase):
    """微信 + 企业微信**并存**：同一租户两种 IM 用户都要能收到。"""

    def _build(self, mode):
        saved = os.environ.pop("DC_NOTIFY_SENDER_MODE", None)
        try:
            with _clean_env():
                os.environ.pop("DC_NOTIFY_SENDER_MODE", None)
                os.environ["DC_NOTIFY_SENDER_MODE"] = mode
                return build_sender_from_env()
        finally:
            if saved is not None:
                os.environ["DC_NOTIFY_SENDER_MODE"] = saved

    def test_15_comma_list_builds_routing_sender(self):
        from dc_notify import RoutingSender
        s = self._build("weixin,wecom")
        self.assertIsInstance(s, RoutingSender)
        self.assertEqual(s.order, ["weixin", "wecom"])

    def test_16_routes_by_target_form(self):
        s = self._build("weixin,wecom")
        self.assertEqual(s.channel_for("a@im.wechat"), "weixin")
        self.assertEqual(s.channel_for("a@im.wecom"), "wecom")
        self.assertEqual(s.channel_for("ou_x"), "feishu")
        self.assertEqual(s.channel_for("unknown"), "")

    def test_17_picks_matching_sender_and_reports_channel(self):
        saved = os.environ.pop("DC_NOTIFY_SENDER_MODE", None)
        try:
            with _clean_env():
                os.environ["DC_NOTIFY_SENDER_MODE"] = "weixin,wecom"
                os.environ["DC_NOTIFY_SEND_ENABLED"] = "1"
                s = build_sender_from_env()
                # 各通道的真实 CLI channel id：微信是 openclaw-weixin，企微是 wecom（不强行统一）
                cli_channel = {"weixin": "openclaw-weixin", "wecom": "wecom"}
                for chan, target in (("weixin", "a@im.wechat"), ("wecom", "b@im.wecom")):
                    captured = {}
                    with mock.patch.object(subprocess, "run",
                                           lambda cmd, **kw: captured.update(cmd=cmd) or
                                           subprocess.CompletedProcess(cmd, 0, "{}", "")):
                        res = s.send(target, "hi")
                    self.assertTrue(res.ok, res.error)
                    self.assertEqual(captured["cmd"][captured["cmd"].index("--channel") + 1],
                                     cli_channel[chan])
                    self.assertEqual(s.sent[-1]["channel"], chan)
        finally:
            if saved is not None:
                os.environ["DC_NOTIFY_SENDER_MODE"] = saved

    def test_18_target_channel_not_configured_fails_honestly(self):
        s = self._build("weixin")  # 只配了微信；实际这里是单发送器，用显式 RoutingSender 验证
        from dc_notify import RoutingSender, MockSender
        only_weixin = RoutingSender({"weixin": MockSender()}, ["weixin"])
        res = only_weixin.send("b@im.wecom", "hi")
        self.assertFalse(res.ok)
        self.assertIn("wecom not configured", res.error)
        self.assertIsNotNone(s)  # 单模式仍是 WeixinSender（不变）

    def test_19_ambiguous_target_falls_back_to_first_configured(self):
        from dc_notify import RoutingSender, MockSender
        wx, wc = MockSender(), MockSender()
        s = RoutingSender({"weixin": wx, "wecom": wc}, ["weixin", "wecom"])
        res = s.send("plain-target", "hi")
        self.assertTrue(res.ok)
        self.assertEqual(s.sent[-1]["channel"], "weixin")
        self.assertEqual(len(wx.sent), 1)
        self.assertEqual(len(wc.sent), 0)

    def test_20_switch_accepts_comma_list(self):
        from dc_signal_push import _push_enabled
        with _clean_env():
            os.environ.update({
                "DC_SIGNAL_PUSH_AUTOMATION_MODE": "live",
                "DC_NOTIFY_SENDER_MODE": "weixin,wecom",
                "DC_NOTIFY_SEND_ENABLED": "1",
            })
            ok, reason = _push_enabled("C1")
        self.assertTrue(ok, reason)

    def test_21_switch_rejects_typo_in_list(self):
        from dc_signal_push import _push_enabled
        with _clean_env():
            os.environ.update({
                "DC_SIGNAL_PUSH_AUTOMATION_MODE": "live",
                "DC_NOTIFY_SENDER_MODE": "weixin,wecom2",
                "DC_NOTIFY_SEND_ENABLED": "1",
            })
            ok, reason = _push_enabled("C1")
        self.assertFalse(ok)
        self.assertEqual(reason, "push_disabled")


if __name__ == "__main__":
    unittest.main(verbosity=2)
