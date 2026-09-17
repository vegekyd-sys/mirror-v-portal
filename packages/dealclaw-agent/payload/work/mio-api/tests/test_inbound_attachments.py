#!/usr/bin/env python3
"""test_inbound_attachments.py — 入站附件落盘（IMAP MIME + Resend + 事实层字段）。

回归点（此前三层各断一次，买家发来的 logo/报价单全部静默丢弃）：
  1. imap_sync._extract_attachments 必须取到附件，且不把正文 part 当附件；
     inline + filename（很多客户端的图片）也算附件。
  2. dc_resend_attachments.store_bytes 落盘 + 幂等 + 超限跳过。
  3. EmailStore._normalize 是白名单，attachments 必须留在快照里（以前被丢）。

运行：cd work/mio-api && python3 -m unittest tests.test_inbound_attachments -v
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import dc_resend_attachments as att  # noqa: E402
from email_gateway.imap_sync import _extract_attachments  # noqa: E402
from email_gateway.store import EmailStore, utc_now  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"logo-bytes" * 4


def _msg_with_logo() -> EmailMessage:
    m = EmailMessage()
    m["From"] = "buyer@casa.example"
    m["To"] = "sales@dealclaw.example"
    m["Subject"] = "Re: quotation"
    m.set_content("Please see our logo attached.")
    m.add_alternative("<p>Please see our logo attached.</p>", subtype="html")
    m.add_attachment(PNG, maintype="image", subtype="png", filename="logo.png")
    return m


class ExtractTest(unittest.TestCase):
    def test_picks_attachment_not_body(self):
        got = _extract_attachments(_msg_with_logo())
        self.assertEqual([(n, t) for n, t, _ in got], [("logo.png", "image/png")])
        self.assertEqual(got[0][2], PNG)

    def test_inline_with_filename_counts(self):
        m = EmailMessage()
        m.set_content("body")
        m.add_attachment(PNG, maintype="image", subtype="png", filename="inline-logo.png",
                         disposition="inline")
        names = [n for n, _, _ in _extract_attachments(m)]
        self.assertEqual(names, ["inline-logo.png"])

    def test_plain_message_has_none(self):
        m = EmailMessage()
        m.set_content("just text, no attachment")
        self.assertEqual(_extract_attachments(m), [])


class StoreBytesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dc-att-"))

    def _store(self, **kw):
        return att.store_bytes(company_id="sid1", message_id="<mid-1>", filename="logo.png",
                               content_type="image/png", data=PNG, ym="2026-09",
                               data_dir=self.tmp, **kw)

    def test_writes_file_and_index(self):
        row = self._store()
        self.assertTrue(row["stored"])
        self.assertEqual(Path(row["path"]).read_bytes(), PNG)
        self.assertEqual(row["size"], len(PNG))
        self.assertTrue(row["sha256"])

        att.append_index([row], company_id="sid1", ym="2026-09", data_dir=self.tmp)
        idx = self.tmp / "email-facts" / "attachments" / "sid1" / "2026-09" / "_index.jsonl"
        lines = [json.loads(x) for x in idx.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["filename"], "logo.png")

    def test_idempotent_rewrite_and_index_dedupe(self):
        first = self._store()
        second = self._store()
        self.assertEqual(first["sha256"], second["sha256"])
        att.append_index([first], company_id="sid1", ym="2026-09", data_dir=self.tmp)
        att.append_index([second], company_id="sid1", ym="2026-09", data_dir=self.tmp)
        idx = self.tmp / "email-facts" / "attachments" / "sid1" / "2026-09" / "_index.jsonl"
        self.assertEqual(len(idx.read_text(encoding="utf-8").strip().splitlines()), 1)

    def test_too_large_is_skipped_not_silent(self):
        orig = att.MAX_BYTES
        att.MAX_BYTES = 8
        try:
            row = self._store()
        finally:
            att.MAX_BYTES = orig
        self.assertFalse(row["stored"])
        self.assertEqual(row["skipped"], "too_large")
        self.assertFalse(Path(row["path"]).exists())

    def test_blank_company_falls_back_to_unmatched(self):
        row = att.store_bytes(company_id="", message_id="<m>", filename="a.pdf",
                              data=b"x", ym="2026-09", data_dir=self.tmp)
        self.assertIn("_unmatched", row["path"])


class NormalizeKeepsAttachmentsTest(unittest.TestCase):
    def test_attachments_survive_insert(self):
        tmp = tempfile.mkdtemp(prefix="dc-att-store-")
        store = EmailStore(tmp)
        rows = [{"filename": "logo.png", "content_type": "image/png", "size": len(PNG),
                 "path": "/data/x/logo.png", "sha256": "deadbeef"}]
        self.assertTrue(store.insert_message({
            "account_id": "ema_att", "direction": "inbound", "message_id": "<att-1>",
            "sender": "buyer@casa.example", "recipients": ["sales@dealclaw.example"],
            "subject": "Re: quotation", "text_preview": "logo attached",
            "attachments": rows, "related": True,
            "received_at": utc_now(), "created_at": utc_now(),
        }))
        found = store.find_inbound_by_message_id("<att-1>") if hasattr(
            store, "find_inbound_by_message_id") else None
        if found is None:  # 无专用查询就直接读快照文件
            snap = next((Path(tmp) / "email-facts").rglob("*.md"))
            found = json.loads(snap.read_text(encoding="utf-8").split("\n\n", 1)[1])
        self.assertEqual(found["attachments"], rows)


class ResendInboundAttachmentTest(unittest.TestCase):
    """Resend 入站整条链路：详情 attachments[] → 拉元数据 → 下载 → 落盘 → 进事实层。

    不联网：_api 与 urlopen 都打桩。守的是「handle_inbound_event 必须把附件带进
    insert_message」——这正是之前整条链路缺的一环。
    """

    def setUp(self):
        import os
        self.tmp = tempfile.mkdtemp(prefix="dc-att-resend-")
        os.environ["DC_DATA_DIR"] = self.tmp
        from dc_email_controller import dc_webhook_handler as h

        h._store = None
        h._store_db_path = None
        self.h = h
        self.store = h.get_store()
        self.store.insert_message({
            "direction": "outbound", "account_id": "ema_t1",
            "message_id": "<out1@dealclaw.io>", "smtp_message_id": "<out1@dealclaw.io>",
            "company_id": "testco", "campaign_id": "camp-1", "lead_id": "L1",
            "contact_id": "C1", "thread_id": "T1", "subject": "Hello", "status": "sent",
        })
        self._orig_account = h._account_for_to
        h._account_for_to = lambda to_email: {
            "account_id": "ema_t1", "email_address": (to_email or "").lower(),
            "enterprise_id": "testco"}

        # Resend 侧打桩：附件元数据 + CDN 下载
        self._orig_api, self._orig_urlopen = att._api, att.urllib.request.urlopen
        att._api = lambda path, timeout=30: {
            "filename": "logo.png", "content_type": "image/png",
            "size": len(PNG), "download_url": "https://cdn.example/logo.png"}

        class _Resp:
            def read(self_inner):
                return PNG

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *a):
                return False

        att.urllib.request.urlopen = lambda req, timeout=60: _Resp()

    def tearDown(self):
        import os
        self.h._account_for_to = self._orig_account
        att._api, att.urllib.request.urlopen = self._orig_api, self._orig_urlopen
        os.environ.pop("DC_DATA_DIR", None)

    def _fetch(self, _email_id):
        return {
            "message_id": "<in1@buyer.example>", "in_reply_to": "<out1@dealclaw.io>",
            "from": "buyer@example.com", "to": ["thia@mail.dealclaw.io"],
            "subject": "Re: Hello", "text": "logo attached", "headers": [],
            "attachments": [{"id": "att_1", "filename": "logo.png"}],
        }

    def test_attachment_lands_on_disk_and_in_fact_layer(self):
        r = self.h.handle_inbound_event(
            {"email_id": "rid-1", "from": "buyer@example.com",
             "to": ["thia@mail.dealclaw.io"], "subject": "Re: Hello"},
            fetch=self._fetch)
        self.assertEqual(r.get("status"), "bound", r)
        self.assertEqual(r.get("attachments"), 1, r)

        recs = self.store.list_inbound_records("testco")
        self.assertEqual(len(recs), 1)
        rows = recs[0].get("attachments") or []
        self.assertEqual(len(rows), 1, recs[0])
        self.assertEqual(rows[0]["filename"], "logo.png")
        self.assertTrue(rows[0]["stored"])
        self.assertEqual(Path(rows[0]["path"]).read_bytes(), PNG)
        self.assertIn("testco", rows[0]["path"])

    def test_attachment_failure_does_not_break_reply(self):
        """CDN 挂了也必须照常落回复——附件是 best-effort，不能拖垮主链路。"""
        def boom(req, timeout=60):
            raise OSError("cdn down")

        att.urllib.request.urlopen = boom
        r = self.h.handle_inbound_event(
            {"email_id": "rid-2", "from": "buyer@example.com",
             "to": ["thia@mail.dealclaw.io"], "subject": "Re: Hello"},
            fetch=self._fetch)
        self.assertEqual(r.get("status"), "bound", r)
        recs = self.store.list_inbound_records("testco")
        self.assertEqual(len(recs), 1)
        rows = recs[0].get("attachments") or []
        self.assertEqual(len(rows), 1)
        self.assertFalse(rows[0].get("stored"))
        self.assertIn("download", rows[0].get("error", ""))


class CardAttachmentLineTest(unittest.TestCase):
    """通知卡片必须把附件列出来——用户看不到「有附件」就无从谈起「看一下」。"""

    def setUp(self):
        from email_gateway import cron_notify
        self.cn = cron_notify

    def test_lists_names_and_sizes(self):
        line = self.cn._attachment_line([
            {"filename": "logo.png", "size": 40960, "stored": True},
            {"filename": "报价单.pdf", "size": 1048576, "stored": True},
        ])
        self.assertIn("logo.png", line)
        self.assertIn("40.0KB", line)
        self.assertIn("报价单.pdf", line)
        self.assertIn("1.0MB", line)

    def test_failed_attachment_is_flagged_not_hidden(self):
        line = self.cn._attachment_line(
            [{"filename": "big.zip", "size": 99, "stored": False, "skipped": "too_large"}])
        self.assertIn("big.zip", line)
        self.assertIn("too_large", line)

    def test_no_attachments_no_line(self):
        self.assertEqual(self.cn._attachment_line([]), "")
        self.assertEqual(self.cn._attachment_line(None), "")

    def test_card_includes_attachment_element(self):
        card = self.cn._build_webhook_card([{
            "from": "buyer@casa.example", "email_address": "sales@dealclaw.example",
            "subject": "Re: quotation", "preview": "see attached",
            "attachments": [{"filename": "logo.png", "size": 40, "stored": True}],
        }])
        blob = json.dumps(card, ensure_ascii=False)
        self.assertIn("logo.png", blob)
        self.assertEqual(card["msg_type"], "interactive")


class FindTest(unittest.TestCase):
    """「看附件」要能查得到：按 message_id / 文件名定位已落盘的附件。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dc-att-find-"))
        for mid, fname in (("<m1>", "logo.png"), ("<m1>", "spec.pdf"), ("<m2>", "quote.pdf")):
            row = att.store_bytes(company_id="sid1", message_id=mid, filename=fname,
                                  data=PNG, ym="2026-09", data_dir=self.tmp)
            att.append_index([row], company_id="sid1", ym="2026-09", data_dir=self.tmp)

    def test_find_all(self):
        r = att.find(company_id="sid1", data_dir=self.tmp)
        self.assertEqual(r["count"], 3)
        self.assertTrue(all(x["exists"] for x in r["rows"]))

    def test_find_by_message_id(self):
        r = att.find(company_id="sid1", message_id="<m1>", data_dir=self.tmp)
        self.assertEqual({x["filename"] for x in r["rows"]}, {"logo.png", "spec.pdf"})

    def test_find_by_name_substring(self):
        r = att.find(company_id="sid1", name="quote", data_dir=self.tmp)
        self.assertEqual(r["count"], 1)
        self.assertEqual(r["rows"][0]["filename"], "quote.pdf")

    def test_unknown_company_is_empty_not_error(self):
        r = att.find(company_id="nobody", data_dir=self.tmp)
        self.assertTrue(r["ok"])
        self.assertEqual(r["count"], 0)

    def test_missing_file_reported_as_not_exists(self):
        r = att.find(company_id="sid1", name="logo", data_dir=self.tmp)
        Path(r["rows"][0]["path"]).unlink()
        r2 = att.find(company_id="sid1", name="logo", data_dir=self.tmp)
        self.assertFalse(r2["rows"][0]["exists"])


class DossierAttachmentTest(unittest.TestCase):
    """案卷要把附件带出来——agent 读案卷时看不见附件，就等于只看了半封信。"""

    def setUp(self):
        import dc_thread_dossier as td
        self.td = td
        self.rec_in = {
            "_direction": "inbound", "subject": "Re: Quotation",
            "sender": "buyer@casa.mx", "recipients": ["sales@dealclaw.io"],
            "text": "logo and spec attached", "created_at": "2026-09-15T02:00:00Z",
            "attachments": [
                {"filename": "logo.png", "content_type": "image/png", "size": 40960,
                 "stored": True, "path": "/data/x/logo.png"},
                {"filename": "catalog.zip", "size": 99, "stored": False, "skipped": "too_large"},
            ],
        }
        self.rec_out = {
            "_direction": "outbound", "subject": "Quotation",
            "sender": "sales@dealclaw.io", "recipients": ["buyer@casa.mx"],
            "text": "our quote", "created_at": "2026-09-14T10:00:00Z",
        }

    def test_dossier_lists_attachments(self):
        md = self.td.render_dossier("k1", [self.rec_out, self.rec_in])
        self.assertIn("**附件**", md)
        self.assertIn("logo.png", md)
        self.assertIn("40.0KB", md)
        self.assertIn("附件：2 个", md)

    def test_failed_attachment_flagged(self):
        md = self.td.render_dossier("k1", [self.rec_in])
        self.assertIn("catalog.zip", md)
        self.assertIn("too_large", md)

    def test_path_hidden_by_default(self):
        """案卷会作为飞书文档交付客户，本地盘路径属后台实现，默认不露。"""
        md = self.td.render_dossier("k1", [self.rec_in])
        self.assertNotIn("/data/x/logo.png", md)

    def test_path_shown_with_flag(self):
        md = self.td.render_dossier("k1", [self.rec_in], with_paths=True)
        self.assertIn("/data/x/logo.png", md)

    def test_no_attachments_no_section(self):
        md = self.td.render_dossier("k1", [self.rec_out])
        self.assertNotIn("**附件**", md)
        self.assertNotIn("附件：", md)


if __name__ == "__main__":
    unittest.main(verbosity=2)
