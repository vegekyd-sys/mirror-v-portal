#!/usr/bin/env python3
"""test_notify_weixin.py — 微信通知链路回归测试（2026-09-12 补丁的等价落库）

对应田耕郡 09-12 微信链路 5 个卡点里**可自动化**的部分（WhatsApp key 属配置，不在范围）：

  卡点 2 · 通知通道只有飞书
    1. 发送器工厂：feishu / weixin / 未知 → disabled（默认 feishu）
    2. WeixinSender：参数校验、dry-run、CLI 参数拼装、失败与 message_id 解析
    3. 路由校验：oc_ / ou_ / @im.wechat 放行，其它拒绝（resolve_target + resolve_notification_route）
  卡点 3 · 发信不落 outbound 事实 → 回复匹配不上
    4. send_batch 成功后调用 insert_message 落 outbound 事实（mock EmailStore）
  卡点 4 · 通知不带买家原文
    5. format_candidate_message 带 evidence，且剥掉「---- 回复的原邮件 ----」之后的引用
  另：推送开关必须认 weixin（否则改完通道仍然 push_disabled）

全部离线：不触网、不调用真 CLI、不发消息、不写真实数据。

运行：cd work/mio-api && python3 -m unittest tests.test_notify_weixin -v
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "dc_email_controller"))

from dc_notify import (  # noqa: E402
    DisabledSender, FeishuSender, NotifyEngine, WeixinSender, build_sender_from_env,
)
from dc_signal_push import _push_enabled, format_candidate_message  # noqa: E402


def _env(**kv):
    """临时设置环境变量（不改动已存在的其它键）。"""
    return mock.patch.dict(os.environ, {k: str(v) for k, v in kv.items()}, clear=False)


def _clean(mode=True):
    """删掉相关环境变量，保证用例之间不串味。"""
    keys = ["DC_NOTIFY_SENDER_MODE", "DC_NOTIFY_SEND_ENABLED", "DC_NOTIFY_WEIXIN_ACCOUNT",
            "DC_SIGNAL_PUSH_AUTOMATION_MODE", "DC_SIGNAL_PUSH_MODE"]
    patches = [mock.patch.dict(os.environ, {}, clear=False)]
    return patches, keys


# ── 1. 工厂 ────────────────────────────────────────────

class SenderFactoryTest(unittest.TestCase):
    def _build(self, **env):
        saved = {k: os.environ.pop(k, None) for k in ("DC_NOTIFY_SENDER_MODE",)}
        try:
            clean_env = {k: v for k, v in env.items() if v is not None}
            with mock.patch.dict(os.environ, clean_env, clear=False):
                if env.get("DC_NOTIFY_SENDER_MODE") is None:
                    os.environ.pop("DC_NOTIFY_SENDER_MODE", None)
                return build_sender_from_env()
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

    def test_feishu_mode(self):
        self.assertIsInstance(self._build(DC_NOTIFY_SENDER_MODE="feishu"), FeishuSender)

    def test_weixin_mode(self):
        self.assertIsInstance(self._build(DC_NOTIFY_SENDER_MODE="weixin"), WeixinSender)

    def test_unknown_mode_falls_back_to_disabled(self):
        self.assertIsInstance(self._build(DC_NOTIFY_SENDER_MODE="yolo"), DisabledSender)

    def test_default_is_feishu(self):
        self.assertIsInstance(self._build(DC_NOTIFY_SENDER_MODE=None), FeishuSender)


# ── 2. WeixinSender ────────────────────────────────────

class WeixinSenderTest(unittest.TestCase):
    def test_target_required(self):
        r = WeixinSender(enabled=True).send("", "hi")
        self.assertFalse(r.ok)
        self.assertEqual(r.backend, "weixin")
        self.assertIn("target", r.error)

    def test_message_required(self):
        r = WeixinSender(enabled=True).send("x@im.wechat", "")
        self.assertFalse(r.ok)
        self.assertIn("message", r.error)

    def test_disabled_is_dry_run(self):
        s = WeixinSender(enabled=False)
        r = s.send("x@im.wechat", "hi")
        self.assertTrue(r.ok)
        self.assertTrue(r.dry_run)
        self.assertFalse(r.sent)
        self.assertEqual(s.sent[0]["dry_run"], True)

    def test_cli_args_and_message_id(self):
        captured = {}

        def fake_run(cmd, **kw):
            captured["cmd"] = cmd
            return SimpleNamespace(returncode=0, stdout='{"data":{"message_id":"m-1"}}',
                                   stderr="")

        with mock.patch.dict(os.environ, {"DC_NOTIFY_WEIXIN_ACCOUNT": "0ae3af3617e2-im-bot"}):
            s = WeixinSender(enabled=True)
            with mock.patch("subprocess.run", side_effect=fake_run):
                r = s.send("o9cq80wxuc1hT1x2t8NA_rbfx20o@im.wechat", "买家想报价")
        cmd = captured["cmd"]
        self.assertEqual(cmd[:4], ["openclaw", "message", "send", "--channel"])
        self.assertIn("openclaw-weixin", cmd)
        self.assertIn("--account", cmd)
        self.assertIn("0ae3af3617e2-im-bot", cmd)
        self.assertIn("--target", cmd)
        self.assertIn("o9cq80wxuc1hT1x2t8NA_rbfx20o@im.wechat", cmd)
        self.assertIn("买家想报价", cmd)
        self.assertTrue(r.ok and r.sent)
        self.assertEqual(r.message_id, "m-1")

    def test_cli_failure_reports_stderr(self):
        with mock.patch("subprocess.run",
                        return_value=SimpleNamespace(returncode=1, stdout="", stderr="boom")):
            r = WeixinSender(enabled=True).send("x@im.wechat", "hi")
        self.assertFalse(r.ok)
        self.assertIn("boom", r.error)

    def test_cli_missing_binary(self):
        with mock.patch("subprocess.run", side_effect=FileNotFoundError()):
            r = WeixinSender(enabled=True).send("x@im.wechat", "hi")
        self.assertFalse(r.ok)
        self.assertIn("openclaw not found", r.error)

    def test_cli_timeout(self):
        with mock.patch("subprocess.run",
                        side_effect=subprocess.TimeoutExpired(cmd="openclaw", timeout=30)):
            r = WeixinSender(enabled=True).send("x@im.wechat", "hi")
        self.assertFalse(r.ok)
        self.assertIn("timeout", r.error)


# ── 3. 路由校验 ────────────────────────────────────────

class RouteTest(unittest.TestCase):
    def _engine(self):
        tmp = tempfile.mkdtemp(prefix="dc-notify-weixin-")
        return NotifyEngine(data_dir=Path(tmp))

    def test_resolve_target_accepts_wechat(self):
        e = self._engine()
        e.set_route("c1", "o9cq80wxuc1hT1x2t8NA_rbfx20o@im.wechat")
        self.assertEqual(e.resolve_target("c1")["status"], "ok")

    def test_resolve_target_still_accepts_feishu(self):
        e = self._engine()
        e.set_route("c1", "oc_abc123")
        self.assertEqual(e.resolve_target("c1")["status"], "ok")

    def test_resolve_target_rejects_garbage(self):
        e = self._engine()
        e.set_route("c1", "not-a-target")
        self.assertEqual(e.resolve_target("c1")["status"], "route_invalid")

    def test_notification_route_accepts_wechat_chat_id(self):
        e = self._engine()
        e.set_notification_route("c1", target_type="chat_id",
                                 target_id="o9cq80wxuc1hT1x2t8NA_rbfx20o@im.wechat")
        self.assertEqual(e.resolve_notification_route("c1")["status"], "ok")

    def test_notification_route_rejects_garbage(self):
        e = self._engine()
        e.set_notification_route("c1", target_type="chat_id", target_id="not-a-target")
        self.assertEqual(e.resolve_notification_route("c1")["status"], "route_invalid")


# ── 4. 推送开关 ────────────────────────────────────────

class PushGateTest(unittest.TestCase):
    def test_weixin_mode_not_disabled(self):
        with mock.patch.dict(os.environ, {"DC_SIGNAL_PUSH_AUTOMATION_MODE": "live",
                                          "DC_NOTIFY_SENDER_MODE": "weixin"}, clear=False):
            self.assertEqual(_push_enabled("c1"), (True, ""))

    def test_feishu_mode_still_ok(self):
        with mock.patch.dict(os.environ, {"DC_SIGNAL_PUSH_AUTOMATION_MODE": "live",
                                          "DC_NOTIFY_SENDER_MODE": "feishu"}, clear=False):
            self.assertEqual(_push_enabled("c1"), (True, ""))

    def test_unknown_channel_blocks(self):
        with mock.patch.dict(os.environ, {"DC_SIGNAL_PUSH_AUTOMATION_MODE": "live",
                                          "DC_NOTIFY_SENDER_MODE": "telegram"}, clear=False):
            self.assertEqual(_push_enabled("c1"), (False, "push_disabled"))

    def test_sender_disabled_blocks(self):
        with mock.patch.dict(os.environ, {"DC_SIGNAL_PUSH_AUTOMATION_MODE": "live",
                                          "DC_NOTIFY_SENDER_MODE": "weixin",
                                          "DC_NOTIFY_SEND_ENABLED": "0"}, clear=False):
            self.assertEqual(_push_enabled("c1"), (False, "push_disabled"))


# ── 5. 通知带原文 ──────────────────────────────────────

class CandidateMessageTest(unittest.TestCase):
    def test_evidence_included(self):
        msg = format_candidate_message({"title": "买家想报价",
                                        "evidence": "What's Linde G25 price? Qty:5 pcs"})
        self.assertIn("买家原文", msg)
        self.assertIn("What's Linde G25 price? Qty:5 pcs", msg)

    def test_quoted_original_is_stripped(self):
        msg = format_candidate_message({
            "title": "买家想报价",
            "evidence": "请报价\n---- 回复的原邮件 ----\n> 我们之前的邀请信正文"})
        self.assertIn("请报价", msg)
        self.assertNotIn("我们之前的邀请信正文", msg)

    def test_evidence_truncated_to_300(self):
        msg = format_candidate_message({"title": "买家想报价", "evidence": "x" * 500})
        self.assertLessEqual(len(msg.split("买家原文：", 1)[1].split("\n")[0]), 300)

    def test_missing_fields_still_mentioned(self):
        msg = format_candidate_message({"title": "买家想报价", "evidence": "hi",
                                        "missing_fields": ["price", "moq"]})
        self.assertIn("报价", msg)
        self.assertIn("起订量", msg)

    def test_bounce_short_circuit(self):
        self.assertEqual(format_candidate_message({"category": "bounce", "title": "退信提醒"}),
                         "退信提醒")


# ── 6. 发信落 outbound 事实 ────────────────────────────

class OutboundFactTest(unittest.TestCase):
    def test_success_lands_outbound_fact(self):
        written: list[dict] = []

        class FakeStore:
            def __init__(self, *a, **k):
                pass

            def list_accounts(self, enterprise_id=None, **k):
                return [{"account_id": "ema_gege", "email_address": "gege@mail.dealclaw.io"}]

            def insert_message(self, message, conn=None):
                written.append(message)
                return True

        sys.path.insert(0, str(HERE))
        import dc_email_send  # noqa: PLC0415

        with mock.patch.object(dc_email_send.subprocess, "run",
                               return_value=SimpleNamespace(returncode=0,
                                                            stdout='{"id":"re_abc"}', stderr="")), \
                mock.patch("email_gateway.store.EmailStore", FakeStore), \
                mock.patch("dc_send_log.SendLog", lambda *a, **k: mock.Mock()):
            out = dc_email_send.send_batch("FD", "gege@mail.dealclaw.io", ["buyer@x.com"],
                                           "越南二手叉车", text="hi", enterprise="100000834234")

        self.assertTrue(out["success"])
        self.assertEqual(len(written), 1)
        rec = written[0]
        self.assertEqual(rec["direction"], "outbound")
        self.assertEqual(rec["resend_id"], "re_abc")
        self.assertEqual(rec["company_id"], "100000834234")
        self.assertEqual(rec["account_id"], "ema_gege")
        self.assertEqual(rec["recipients"], ["buyer@x.com"])

    def test_failure_does_not_land_fact(self):
        written: list[dict] = []

        class FakeStore:
            def __init__(self, *a, **k):
                pass

            def list_accounts(self, enterprise_id=None, **k):
                return []

            def insert_message(self, message, conn=None):
                written.append(message)
                return True

        import dc_email_send  # noqa: PLC0415

        with mock.patch.object(dc_email_send.subprocess, "run",
                               return_value=SimpleNamespace(returncode=1, stdout="bad", stderr="err")), \
                mock.patch("email_gateway.store.EmailStore", FakeStore), \
                mock.patch("dc_send_log.SendLog", lambda *a, **k: mock.Mock()):
            out = dc_email_send.send_batch("FD", "gege@mail.dealclaw.io", ["buyer@x.com"],
                                           "S", text="hi", enterprise="100000834234")
        self.assertFalse(out["success"])
        self.assertEqual(written, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
