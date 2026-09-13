#!/usr/bin/env python3
"""test_email_send_entry.py — B. 发信入口收敛（单一入口 dc_email_send send）回归测试

覆盖：
  B1. dc_email_send send 按账号解析传输：
        provider=resend（dealclaw_proxy）→ Resend API（scripts/resend/send.mjs）
        personal（netease_163 / tencent_exmail / aliyun_exmail / gmail）→ SmtpSender
      --channel GS/FD 保持向后兼容；--from 可反查账号。
  B2. email_gateway.cli send 是兼容薄壳（deprecated），与 dc_email_send 同源实现。
  B3/B4. 两条路径都落 outbound 事实；personal 无投递终态 → provider_status=unavailable。

全部离线：不触网、不起 node、不连 SMTP/IMAP、不发消息、不写真实 data/。

运行：cd work/mio-api && python3 -m unittest tests.test_email_send_entry -v
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

import dc_email_send  # noqa: E402
from email_gateway import cli as gw_cli  # noqa: E402
from email_gateway.smtp_send import SmtpSender  # noqa: E402
from email_gateway.store import EmailStore  # noqa: E402

ENTERPRISE = "100000834234"
FD_SCRIPT = "send-direct.mjs"
GS_SCRIPT = "resend/send.mjs"


def _facts(data_dir: Path, direction: str = "outbound") -> list[dict]:
    """读全部快照文件里的 JSON 事实（与生产读取口径一致：JSONL 单行）。

    注：_normalize 落库后类型字段是 record_type（direction 只在入参里）。
    """
    out: list[dict] = []
    for path in Path(data_dir).rglob("*.md"):
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(rec, dict):
                continue
            if rec.get("record_type") == direction or rec.get("direction") == direction:
                out.append(rec)
    return out


class _Base(unittest.TestCase):
    """每个用例一份临时 EmailStore + 外部副作用（send_log / receipt）全部 mock。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dc-email-send-"))
        self.store = EmailStore(str(self.tmp))
        patchers = [
            mock.patch("email_gateway.store.EmailStore", lambda *a, **k: self.store),
            mock.patch("dc_send_log.SendLog", lambda *a, **k: mock.Mock()),
            mock.patch("dc_send_receipt.push_receipt", lambda *a, **k: None),
        ]
        for p in patchers:
            p.start()
            self.addCleanup(p.stop)

    # ── helpers ──
    def _account(self, *, provider: str, email: str, mailbox_kind: str = "personal",
                 owner: str = "ou_owner") -> dict:
        return self.store.add_account(
            enterprise_id=ENTERPRISE, owner_open_id=owner, email_address=email,
            provider=provider, mailbox_kind=mailbox_kind, secret_ref="app-password",
            display_name="V",
        )

    def _run_cli(self, argv: list[str]) -> tuple[int, dict]:
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", ["dc_email_send.py"] + argv), \
                redirect_stdout(buf):
            rc = dc_email_send._cli()
        text = buf.getvalue().strip()
        return rc, (json.loads(text) if text else {})

    def _send_argv(self, **over) -> list[str]:
        argv = ["send", "--enterprise", ENTERPRISE, "--to", over.pop("to", "buyer@x.com"),
                "--subject", over.pop("subject", "报价"), "--text", over.pop("text", "hi")]
        for k, v in over.items():
            flag = "--" + k.replace("_", "-")
            if v is True:
                argv.append(flag)
            elif v not in (None, "", False):
                argv += [flag, str(v)]
        return argv


# ── B1 · 传输解析 ──────────────────────────────────────


class TransportResolveTest(_Base):
    def test_account_resend_is_resend_transport(self):
        acc = self._account(provider="resend", email="v@mail.dealclaw.io",
                            mailbox_kind="dealclaw_proxy")
        tr = dc_email_send.resolve_transport(account_id=acc["account_id"])
        self.assertEqual(tr["transport"], "resend")
        self.assertEqual(tr["channel"], "GS")  # 默认 GS，可被 --channel 覆盖
        self.assertEqual(tr["from_addr"], "v@mail.dealclaw.io")

    def test_account_personal_is_smtp_transport(self):
        acc = self._account(provider="netease_163", email="gege@163.com")
        tr = dc_email_send.resolve_transport(account_id=acc["account_id"])
        self.assertEqual(tr["transport"], "smtp")
        self.assertEqual(tr["provider"], "netease_163")
        self.assertEqual(tr["from_addr"], "gege@163.com")

    def test_from_reverse_lookup_finds_account(self):
        acc = self._account(provider="gmail", email="me@gmail.com")
        tr = dc_email_send.resolve_transport(from_addr="V <ME@gmail.com>")
        self.assertEqual(tr["transport"], "smtp")
        self.assertEqual(tr["account"]["account_id"], acc["account_id"])

    def test_channel_keeps_backward_compat(self):
        # 无账号、显式给了 --channel → 沿用 Resend 路径（向后兼容优先）
        tr = dc_email_send.resolve_transport(from_addr="v@mail.dealclaw.io", channel="FD")
        self.assertEqual(tr["transport"], "resend")
        self.assertEqual(tr["channel"], "FD")

    def test_unknown_from_without_channel_is_error(self):
        tr = dc_email_send.resolve_transport(from_addr="nobody@nowhere.com")
        self.assertEqual(tr["transport"], "")
        self.assertIn("--channel", tr["error"])

    def test_unsupported_provider_is_error(self):
        acc = self._account(provider="larksuite", email="x@y.com")
        tr = dc_email_send.resolve_transport(account_id=acc["account_id"])
        self.assertIn("unsupported provider", tr["error"])


# ── B1/B4 · 分派 + 事实 ────────────────────────────────


class SendDispatchTest(_Base):
    def test_resend_account_dispatches_to_node_script_and_lands_fact(self):
        acc = self._account(provider="resend", email="v@mail.dealclaw.io",
                            mailbox_kind="dealclaw_proxy")
        captured: dict = {}

        def fake_run(cmd, **kw):
            captured["cmd"] = cmd
            return SimpleNamespace(returncode=0, stdout='{"id":"re_123"}', stderr="")

        with mock.patch.object(dc_email_send.subprocess, "run", side_effect=fake_run):
            rc, out = self._run_cli(self._send_argv(account_id=acc["account_id"]))

        self.assertEqual(rc, 0)
        self.assertTrue(out["success"], out)
        self.assertEqual(out["transport"], "resend")
        cmd = captured["cmd"]
        self.assertEqual(cmd[0], "node")
        self.assertIn(GS_SCRIPT, cmd[1])
        self.assertIn("--company-id", cmd)
        facts = _facts(self.tmp)
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]["record_type"], "outbound")
        self.assertEqual(facts[0]["resend_id"], "re_123")
        self.assertEqual(facts[0]["company_id"], ENTERPRISE)
        self.assertEqual(facts[0]["recipients"], ["buyer@x.com"])

    def test_personal_account_dispatches_to_smtp_sender(self):
        acc = self._account(provider="tencent_exmail", email="gege@exmail.qq.com")
        calls: list[dict] = []

        class _FakeSmtpSender:
            def __init__(self, store=None):
                self.store = store

            def send(self, **kwargs):
                calls.append(kwargs)
                return {"ok": True, "message_id": "<m@exmail.qq.com>",
                        "account_id": kwargs.get("account_id")}

        with mock.patch("email_gateway.send_entry.SmtpSender", _FakeSmtpSender), \
                mock.patch.object(dc_email_send.subprocess, "run") as node_run:
            rc, out = self._run_cli(self._send_argv(account_id=acc["account_id"]))

        self.assertEqual(rc, 0)
        self.assertTrue(out["success"], out)
        self.assertEqual(out["transport"], "smtp")
        self.assertEqual(out["provider"], "tencent_exmail")
        node_run.assert_not_called()  # personal 路径不得跑 Resend node 脚本
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["account_id"], acc["account_id"])
        self.assertEqual(calls[0]["confirmed_by"], "ou_owner")  # 默认账号 owner
        self.assertEqual(calls[0]["to"], ["buyer@x.com"])

    def test_personal_path_lands_outbound_fact_with_unavailable_status(self):
        acc = self._account(provider="netease_163", email="gege@163.com")
        sent: list[dict] = []

        class _FakeSmtpClient:
            def __init__(self, host, port, **kw):
                self.host, self.port = host, port

            def login(self, user, password):
                return (235, b"ok")

            def send_message(self, msg, to_addrs=None):
                sent.append({"to_addrs": to_addrs, "message_id": msg.get("Message-ID")})
                return {}

            def quit(self):
                return None

        with mock.patch("smtplib.SMTP_SSL", _FakeSmtpClient), \
                mock.patch.object(SmtpSender, "_query_smtp_message_id", lambda self, *a, **k: ""):
            rc, out = self._run_cli(self._send_argv(account_id=acc["account_id"]))

        self.assertEqual(rc, 0)
        self.assertTrue(out["success"], out)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["to_addrs"], ["buyer@x.com"])
        facts = _facts(self.tmp)
        self.assertEqual(len(facts), 1)
        rec = facts[0]
        self.assertEqual(rec["record_type"], "outbound")
        self.assertEqual(rec["account_id"], acc["account_id"])
        self.assertEqual(rec["sender"], "gege@163.com")
        self.assertEqual(rec["resend_id"], "")
        # B3：personal 没有投递终态，必须显式 unavailable（不能空、更不能 0）
        self.assertEqual(rec["provider_status"], "unavailable")

    def test_channel_only_still_uses_fd_script(self):
        captured: dict = {}

        def fake_run(cmd, **kw):
            captured["cmd"] = cmd
            return SimpleNamespace(returncode=0, stdout='{"resendId":"re_fd"}', stderr="")

        with mock.patch.object(dc_email_send.subprocess, "run", side_effect=fake_run):
            rc, out = self._run_cli(self._send_argv(channel="FD",
                                                    **{"from": "v@mail.dealclaw.io"}))

        self.assertEqual(rc, 0)
        self.assertTrue(out["success"], out)
        self.assertEqual(out["transport"], "resend")
        self.assertIn(FD_SCRIPT, captured["cmd"][1])

    def test_personal_out_of_window_requires_now(self):
        acc = self._account(provider="gmail", email="me@gmail.com")
        with mock.patch.object(dc_email_send, "in_window", lambda *a, **k: False):
            rc, out = self._run_cli(self._send_argv(account_id=acc["account_id"],
                                                    country="BR", city="Sao Paulo"))
        self.assertEqual(rc, 1)
        self.assertFalse(out["success"])
        self.assertIn("pending queue", out["error"])


# ── B2 · cli send 兼容薄壳 ─────────────────────────────


class CliSendShellTest(_Base):
    def test_cli_send_uses_shared_implementation(self):
        acc = self._account(provider="aliyun_exmail", email="gege@qiye.aliyun.com")
        calls: list[dict] = []

        class _FakeSmtpSender:
            def __init__(self, store=None):
                self.store = store

            def send(self, **kwargs):
                calls.append(kwargs)
                return {"ok": True, "message_id": "<m@x>"}

        with mock.patch("email_gateway.send_entry.SmtpSender", _FakeSmtpSender), \
                mock.patch("email_gateway.cli.EmailStore", lambda *a, **k: self.store), \
                redirect_stdout(io.StringIO()):
            rc = gw_cli.main(["send", "--account-id", acc["account_id"],
                              "--confirmed-by", "ou_owner", "--to", "buyer@x.com",
                              "--subject", "报价", "--text", "hi"])

        self.assertEqual(rc, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["account_id"], acc["account_id"])
        self.assertEqual(calls[0]["confirmed_by"], "ou_owner")

    def test_cli_send_legacy_raw_address_account_id(self):
        """旧行为兼容：account_id 直接是邮箱地址时，原样透传给 SmtpSender（内部 Resend 兼容分支）。"""
        calls: list[dict] = []

        class _FakeSmtpSender:
            def __init__(self, store=None):
                self.store = store

            def send(self, **kwargs):
                calls.append(kwargs)
                return {"ok": True, "message_id": "<m@x>"}

        with mock.patch("email_gateway.send_entry.SmtpSender", _FakeSmtpSender), \
                mock.patch("email_gateway.cli.EmailStore", lambda *a, **k: self.store), \
                redirect_stdout(io.StringIO()):
            rc = gw_cli.main(["send", "--account-id", "v@mail.dealclaw.io",
                              "--confirmed-by", "ou_owner", "--to", "buyer@x.com",
                              "--subject", "报价", "--text", "hi"])

        self.assertEqual(rc, 0)
        self.assertEqual(calls[0]["account_id"], "v@mail.dealclaw.io")
        self.assertEqual(calls[0]["confirmed_by"], "ou_owner")

    def test_dry_run_rejected_on_resend_path(self):
        acc = self._account(provider="resend", email="v@mail.dealclaw.io",
                            mailbox_kind="dealclaw_proxy")
        with mock.patch.object(dc_email_send.subprocess, "run") as node_run:
            rc, out = self._run_cli(self._send_argv(account_id=acc["account_id"],
                                                    dry_run=True))
        self.assertEqual(rc, 1)
        self.assertIn("dry-run", out["error"])
        node_run.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
