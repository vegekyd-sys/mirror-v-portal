"""发信附件回归测试（2026-09-17：两条链路此前都发不了附件，只能收）。

覆盖两条链路 + 一组共用规则：
  · SMTP（个人邮箱）：附件真的挂进 MIME，且正文结构不被搅乱
  · Resend（代理邮箱）：附件进 API payload，base64 内容可解回原始字节
  · 共用：fail closed（找不到/空文件/超限一律拒发）、幂等键、落事实与附件库留痕

跑法：
  cd work/mio-api && python3 -m unittest email_gateway.tests.test_send_attachments -v
"""

from __future__ import annotations

import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway import attachments as att  # noqa: E402
from email_gateway import smtp_send as smtp  # noqa: E402
from email_gateway.store import EmailStore  # noqa: E402

ENT = "100000834234"
OWNER = "ou_owner"
PERSONAL = "waqa1988@163.com"
PROXY = "thia@mail.dealclaw.io"

# 最小合法 PNG（8 字节签名足够验证「二进制原样往返」）
PNG_BYTES = b"\x89PNG\r\n\x1a\n"
PDF_BYTES = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\ntrailer\n"


class _FakeSmtpClient:
    def __init__(self, *a, **kw):
        self.sent = []

    def login(self, user, password):
        return ("OK", [b""])

    def send_message(self, msg, to_addrs=None):
        self.sent.append((msg, to_addrs))
        return {}

    def quit(self):
        return ("BYE", [b""])


class SendAttachmentsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-send-attach-")
        os.environ["DC_DATA_DIR"] = self.tmp
        os.environ.pop("DC_ATTACHMENT_SEND_MAX_BYTES", None)
        self.store = EmailStore(self.tmp)
        self.files = Path(self.tmp) / "files"
        self.files.mkdir(parents=True, exist_ok=True)
        self.pdf = self._write("quote.pdf", PDF_BYTES)
        self.png = self._write("logo.png", PNG_BYTES)

    def tearDown(self):
        os.environ.pop("DC_ATTACHMENT_SEND_MAX_BYTES", None)

    # ── helpers ──────────────────────────────────────────
    def _write(self, name: str, data: bytes) -> str:
        path = self.files / name
        path.write_bytes(data)
        return str(path)

    def _account(self, *, provider="netease_163", email=PERSONAL):
        acct = self.store.add_account(
            enterprise_id=ENT, owner_open_id=OWNER, email_address=email,
            provider=provider, secret_ref="plain-secret", mailbox_kind="personal",
        )
        return acct["account_id"]

    def _smtp_sender(self, client):
        return smtp.SmtpSender(
            self.store,
            smtp_ssl_factory=lambda *a, **kw: client,
            smtp_factory=lambda *a, **kw: client,
            secret_resolver=lambda ref: "app-password",
        )

    # ── SMTP 链路（个人邮箱）─────────────────────────────
    def test_smtp_attaches_files_to_mime(self):
        client = _FakeSmtpClient()
        sender = self._smtp_sender(client)
        with mock.patch.object(smtp.SmtpSender, "_query_smtp_message_id",
                               lambda self, *a, **kw: "<mid@163.com>"):
            result = sender.send(
                account_id=self._account(), confirmed_by=OWNER, to=["buyer@example.com"],
                subject="quote", text="see attached", company_id=ENT,
                attachments=[self.pdf, self.png],
            )
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(len(client.sent), 1, "必须真的发出去一封")
        msg = client.sent[0][0]
        parts = list(msg.iter_attachments())
        self.assertEqual([p.get_filename() for p in parts], ["quote.pdf", "logo.png"])
        self.assertEqual(parts[0].get_payload(decode=True), PDF_BYTES, "PDF 字节必须原样送达")
        self.assertEqual(parts[1].get_payload(decode=True), PNG_BYTES, "PNG 字节必须原样送达")
        self.assertEqual(parts[0].get_content_type(), "application/pdf")
        self.assertEqual(parts[1].get_content_type(), "image/png")

    def test_smtp_html_body_survives_attachments(self):
        """附件在 add_alternative 之后挂：正文的 text/html 两份都还在。"""
        client = _FakeSmtpClient()
        sender = self._smtp_sender(client)
        with mock.patch.object(smtp.SmtpSender, "_query_smtp_message_id",
                               lambda self, *a, **kw: "<mid@163.com>"):
            sender.send(account_id=self._account(), confirmed_by=OWNER,
                        to=["buyer@example.com"], subject="s", text="plain",
                        html="<p>rich</p>", company_id=ENT, attachments=[self.pdf])
        msg = client.sent[0][0]
        body_types = {p.get_content_type() for p in msg.walk() if not p.get_filename()}
        self.assertIn("text/plain", body_types)
        self.assertIn("text/html", body_types)
        self.assertEqual(len(list(msg.iter_attachments())), 1)

    # ── Resend 链路（代理邮箱）──────────────────────────
    def test_resend_payload_carries_base64_attachments(self):
        captured = {}

        def fake_resend(**kwargs):
            captured.update(kwargs)
            return "re_abc123"

        sender = self._smtp_sender(_FakeSmtpClient())
        with mock.patch.object(smtp, "resend_send", side_effect=fake_resend):
            result = sender.send(
                account_id=self._account(provider="resend", email=PROXY),
                confirmed_by=OWNER, to=["buyer@example.com"], subject="quote",
                text="see attached", company_id=ENT, attachments=[self.pdf],
            )
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("resend_id"), "re_abc123")
        payload = att.to_resend_payload(captured["attachments"])
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["filename"], "quote.pdf")
        self.assertEqual(base64.b64decode(payload[0]["content"]), PDF_BYTES,
                         "base64 解回来必须与原文件逐字节一致")

    def test_resend_payload_omits_attachments_key_when_none(self):
        """不带附件时 payload 里不能冒出空的 attachments 键（Resend 会当参数错误）。"""
        from email_gateway import resend_send as rs

        sent = {}

        class _Resp:
            status = 200
            data = b'{"id": "re_1"}'

        class _Pool:
            def __init__(self, *a, **kw):
                pass

            def request(self, method, url, body=None, headers=None):
                sent["body"] = body
                return _Resp()

        with mock.patch.object(rs.urllib3, "PoolManager", _Pool):
            rs.send(from_address="a@b.com", to=["c@d.com"], subject="s", text="t",
                    secret_resolver=lambda ref: "key")
        self.assertNotIn("attachments", sent["body"].decode("utf-8"))

    # ── fail closed：宁可拒发也不静默少发 ────────────────
    def test_missing_file_refuses_to_send(self):
        client = _FakeSmtpClient()
        sender = self._smtp_sender(client)
        with self.assertRaises(att.AttachmentError) as ctx:
            sender.send(account_id=self._account(), confirmed_by=OWNER,
                        to=["buyer@example.com"], subject="s", text="t",
                        company_id=ENT, attachments=[str(self.files / "nope.pdf")])
        self.assertIn("not found", str(ctx.exception))
        self.assertEqual(client.sent, [], "附件不合法时一封都不能发出去")

    def test_empty_file_refuses_to_send(self):
        empty = self._write("empty.pdf", b"")
        client = _FakeSmtpClient()
        with self.assertRaises(att.AttachmentError):
            self._smtp_sender(client).send(
                account_id=self._account(), confirmed_by=OWNER, to=["b@example.com"],
                subject="s", text="t", company_id=ENT, attachments=[empty])
        self.assertEqual(client.sent, [])

    def test_total_size_limit_refuses_to_send(self):
        os.environ["DC_ATTACHMENT_SEND_MAX_BYTES"] = "16"
        big = self._write("big.bin", b"x" * 32)
        client = _FakeSmtpClient()
        with self.assertRaises(att.AttachmentError) as ctx:
            self._smtp_sender(client).send(
                account_id=self._account(), confirmed_by=OWNER, to=["b@example.com"],
                subject="s", text="t", company_id=ENT, attachments=[big])
        self.assertIn("exceed", str(ctx.exception))
        self.assertEqual(client.sent, [])

    def test_limit_counts_total_not_per_file(self):
        """上限卡的是总量：两个各 12 字节的文件、上限 16，必须拒。"""
        os.environ["DC_ATTACHMENT_SEND_MAX_BYTES"] = "16"
        a = self._write("a.bin", b"x" * 12)
        b = self._write("b.bin", b"y" * 12)
        with self.assertRaises(att.AttachmentError):
            att.load_attachments([a, b])

    def test_dry_run_still_validates_attachments(self):
        """dry-run 的价值就是提前暴露问题，附件不合法不能等到真发才报。"""
        with self.assertRaises(att.AttachmentError):
            self._smtp_sender(_FakeSmtpClient()).send(
                account_id=self._account(), confirmed_by=OWNER, to=["b@example.com"],
                subject="s", text="t", company_id=ENT, dry_run=True,
                attachments=[str(self.files / "ghost.pdf")])

    # ── 幂等键 ───────────────────────────────────────────
    def test_idempotency_key_unchanged_without_attachments(self):
        """存量口径不能动：不带附件时键必须与加附件功能之前逐字节一致。"""
        import hashlib

        legacy_raw = "co|camp|lead|buyer@example.com|1|v1|subject|body"
        expected = hashlib.sha1(legacy_raw.encode("utf-8")).hexdigest()
        self.assertEqual(
            smtp.build_idempotency_key(
                company_id="co", campaign_id="camp", lead_id="lead",
                recipient="buyer@example.com", touch_number=1, content_version="v1",
                subject="subject", text="body"),
            expected,
            "不带附件的幂等键变了 → 存量已发邮件会被判成没发过，重复发给买家")

    def test_idempotency_key_changes_with_attachments(self):
        base = dict(company_id="co", campaign_id="camp", lead_id="lead",
                    recipient="b@example.com", touch_number=1,
                    content_version="v1", subject="s", text="t")
        plain = smtp.build_idempotency_key(**base)
        with_pdf = smtp.build_idempotency_key(
            **base, attachments_digest=att.digest(att.load_attachments([self.pdf])))
        with_png = smtp.build_idempotency_key(
            **base, attachments_digest=att.digest(att.load_attachments([self.png])))
        self.assertNotEqual(plain, with_pdf, "带附件必须是不同的键")
        self.assertNotEqual(with_pdf, with_png, "换附件必须是不同的键（先发规格书再补报价单）")

    def test_digest_is_order_independent(self):
        one = att.digest(att.load_attachments([self.pdf, self.png]))
        two = att.digest(att.load_attachments([self.png, self.pdf]))
        self.assertEqual(one, two, "同一组附件换个顺序不该算成另一封信")

    # ── 留痕：事实 + 附件库 ──────────────────────────────
    def test_outbound_fact_and_library_record_attachments(self):
        client = _FakeSmtpClient()
        with mock.patch.object(smtp.SmtpSender, "_query_smtp_message_id",
                               lambda self, *a, **kw: "<mid@163.com>"):
            self._smtp_sender(client).send(
                account_id=self._account(), confirmed_by=OWNER, to=["buyer@example.com"],
                subject="quote", text="t", company_id=ENT, attachments=[self.pdf])
        recs = self.store.list_outbound_records(ENT)
        self.assertEqual(len(recs), 1)
        rows = recs[0].get("attachments") or []
        self.assertEqual(len(rows), 1, f"出站事实必须带附件索引行：{recs[0]}")
        self.assertEqual(rows[0]["filename"], "quote.pdf")
        self.assertTrue(rows[0].get("stored"), f"附件原件应落进附件库：{rows[0]}")
        self.assertEqual(Path(rows[0]["path"]).read_bytes(), PDF_BYTES)

    def test_result_reports_attachment_summary_without_bytes(self):
        client = _FakeSmtpClient()
        with mock.patch.object(smtp.SmtpSender, "_query_smtp_message_id",
                               lambda self, *a, **kw: "<mid@163.com>"):
            result = self._smtp_sender(client).send(
                account_id=self._account(), confirmed_by=OWNER, to=["b@example.com"],
                subject="s", text="t", company_id=ENT, attachments=[self.pdf, self.png])
        summary = result.get("attachments")
        self.assertEqual([s["filename"] for s in summary], ["quote.pdf", "logo.png"])
        self.assertEqual(summary[0]["size"], len(PDF_BYTES))
        for item in summary:
            self.assertNotIn("data", item, "回显里不能夹带二进制")

    # ── CLI ──────────────────────────────────────────────
    def test_cli_send_accepts_repeated_attach_flag(self):
        from email_gateway import cli

        captured = {}

        def fake_send(self, **kwargs):
            captured.update(kwargs)
            return {"ok": True, "message_id": "<m@163.com>", "resend_id": "",
                    "attachments": []}

        account_id = self._account()
        with mock.patch.object(smtp.SmtpSender, "send", fake_send):
            rc = cli.main(["--data-dir", self.tmp, "send", "--account-id", account_id,
                           "--confirmed-by", OWNER, "--to", "buyer@example.com",
                           "--subject", "s", "--text", "t",
                           "--attach", self.pdf, "--attach", self.png])
        self.assertEqual(rc, 0)
        self.assertEqual(captured.get("attachments"), [self.pdf, self.png],
                         "--attach 必须可重复且按顺序透传")

    def test_cli_send_without_attach_passes_empty_list(self):
        from email_gateway import cli

        captured = {}

        def fake_send(self, **kwargs):
            captured.update(kwargs)
            return {"ok": True, "message_id": "<m@163.com>", "resend_id": ""}

        account_id = self._account()
        with mock.patch.object(smtp.SmtpSender, "send", fake_send):
            cli.main(["--data-dir", self.tmp, "send", "--account-id", account_id,
                      "--confirmed-by", OWNER, "--to", "b@example.com",
                      "--subject", "s", "--text", "t"])
        self.assertEqual(captured.get("attachments"), [])

    # ── 类型推断 ─────────────────────────────────────────
    def test_unknown_extension_falls_back_to_octet_stream(self):
        odd = self._write("spec.weird", b"data")
        item = att.load_attachments([odd])[0]
        self.assertEqual(item["content_type"], "application/octet-stream")
        self.assertEqual(att.split_content_type(item["content_type"]),
                         ("application", "octet-stream"))


if __name__ == "__main__":
    unittest.main()


class ReplyDraftAttachmentTest(unittest.TestCase):
    """回信草稿带附件：买家索要目录/报价单 → 回信附 PDF（最常见的带附件场景）。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-reply-attach-")
        os.environ["DC_DATA_DIR"] = self.tmp
        self.store = EmailStore(self.tmp)
        self.pdf = Path(self.tmp) / "catalog.pdf"
        self.pdf.write_bytes(PDF_BYTES)
        # confirm_and_send 成功后会写 memory/leads/lead-status.md —— 那是仓库里被
        # git 跟踪的文件，测试不该往里写（存量用例已经把脏数据提交进去过）。
        import heartbeat_data

        patcher = mock.patch.object(heartbeat_data, "upsert_lead_status",
                                    lambda **kw: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _draft(self, **extra):
        from dc_email_controller import dc_reply_draft as rd

        acct = self.store.add_account(
            enterprise_id=ENT, owner_open_id=OWNER, email_address=PERSONAL,
            provider="netease_163", secret_ref="pw", mailbox_kind="personal")
        draft = {"draft_id": "d1", "company_id": ENT, "buyer_email": "buyer@example.com",
                 "subject": "Re: catalog", "text": "attached", "account_id": acct["account_id"],
                 **extra}
        rd.record_draft(draft)
        return rd, draft

    def test_draft_attachments_reach_sender(self):
        rd, _ = self._draft(attachments=[str(self.pdf)])
        captured = {}

        def fake_send(self, **kwargs):
            captured.update(kwargs)
            return {"ok": True, "resend_id": "re_1", "message_id": "<m@x>"}

        with mock.patch.object(smtp.SmtpSender, "send", fake_send):
            out = rd.confirm_and_send("d1", confirmed_by=OWNER, store=self.store)
        self.assertEqual(out.get("status"), "sent", out)
        self.assertEqual(captured.get("attachments"), [str(self.pdf)])

    def test_draft_without_attachments_sends_empty_list(self):
        rd, _ = self._draft()
        captured = {}

        def fake_send(self, **kwargs):
            captured.update(kwargs)
            return {"ok": True, "resend_id": "re_1", "message_id": "<m@x>"}

        with mock.patch.object(smtp.SmtpSender, "send", fake_send):
            rd.confirm_and_send("d1", confirmed_by=OWNER, store=self.store)
        self.assertEqual(captured.get("attachments"), [])

    def test_bad_attachment_marks_draft_failed_not_sent(self):
        """附件不合法 → 草稿标 failed，绝不报「已发送」。"""
        rd, _ = self._draft(attachments=[str(Path(self.tmp) / "ghost.pdf")])
        out = rd.confirm_and_send("d1", confirmed_by=OWNER, store=self.store)
        self.assertEqual(out.get("status"), "failed", out)
        self.assertIn("not found", out.get("error", ""))
        self.assertEqual(rd.get_draft("d1").get("status"), "failed")
