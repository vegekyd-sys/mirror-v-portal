#!/usr/bin/env python3
"""test_attachment_route.py — 附件现拉必须先分清邮箱类型（代理邮箱 vs 个人邮箱）。

口径：**代理邮箱（resend）走 Resend API 现拉；个人邮箱（IMAP）靠收信时落盘 + 重收**，
两条路不能混。混了就是「用户问附件、agent 一直拉不到」——Resend 里根本没有这封。

覆盖：
  1. 账号判据：provider=resend / mailbox_kind=dealclaw_proxy → resend，其余 → imap
  2. 按 message_id 反查账号定链路（代理那封 resend、个人那封 imap）
  3. 查不到 → unknown（不猜）
  4. 个人邮箱调 --pull → 明确拒绝 + 给出 sync 路径，且**一个 Resend 请求都不发**
  5. 代理邮箱调 --pull → 照常现拉落盘
  6. --pull --latest 按本地最近一封入站判链路：个人 → 拒绝并给 sync；代理 → 走 Resend

运行：cd work/mio-api && python3 -m unittest tests.test_attachment_route -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import dc_resend_attachments as att  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\nFAKE-IMAGE-BYTES"
PROXY = "agent@mail.dealclaw.io"
PERSONAL = "waqa1988@163.com"


class _FakeResp:
    def __init__(self, body: bytes):
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class AttachmentRouteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-att-route-")
        os.environ["DC_DATA_DIR"] = self.tmp
        os.environ["RESEND_API_KEY_READ"] = "test-key"
        self._real_api = att._api
        self._real_urlopen = att.urllib.request.urlopen
        att.urllib.request.urlopen = lambda req, timeout=0: _FakeResp(PNG)

        from email_gateway.store import EmailStore, utc_now
        store = EmailStore(self.tmp)
        self.proxy_acc = store.add_account(
            enterprise_id="testco", owner_open_id="ou_v", email_address=PROXY,
            provider="resend", secret_ref="env:RESEND_API_KEY",
            mailbox_kind="dealclaw_proxy")
        self.personal_acc = store.add_account(
            enterprise_id="testco", owner_open_id="ou_v", email_address=PERSONAL,
            provider="netease_163", secret_ref="plain", mailbox_kind="personal")
        now = utc_now()
        # 两封入站：代理邮箱那封 + 个人邮箱那封（带附件）
        store.insert_message({
            "account_id": self.proxy_acc["account_id"], "direction": "inbound",
            "message_id": "<proxy-1>", "resend_received_id": "rid-proxy",
            "sender": "buyer@x.com", "recipients": [PROXY], "company_id": "testco",
            "received_at": "2026-09-15T01:00:00+00:00", "created_at": now,
            "attachments": [{"filename": "logo.png", "stored": True}],
        })
        store.insert_message({
            "account_id": self.personal_acc["account_id"], "direction": "inbound",
            "message_id": "<personal-1>", "sender": "buyer2@x.com",
            "recipients": [PERSONAL], "company_id": "testco",
            "received_at": "2026-09-15T02:00:00+00:00", "created_at": now,
            "attachments": [{"filename": "quote.pdf", "stored": True}],
        })

    def tearDown(self):
        att._api = self._real_api
        att.urllib.request.urlopen = self._real_urlopen
        os.environ.pop("RESEND_API_KEY_READ", None)
        os.environ.pop("RESEND_API_KEY", None)

    def _boom_api(self):
        def boom(path, timeout=30):
            raise AssertionError(f"个人邮箱链路不得调用 Resend API：{path}")
        att._api = boom

    # ── 1/2/3：链路判据 ──────────────────────────────────
    def test_route_of_account(self):
        self.assertEqual(att.route_of_account({"provider": "resend", "mailbox_kind": "personal"}), "resend")
        self.assertEqual(att.route_of_account({"provider": "aliyun_exmail", "mailbox_kind": "dealclaw_proxy"}), "resend")
        self.assertEqual(att.route_of_account({"provider": "netease_163", "mailbox_kind": "personal"}), "imap")
        self.assertEqual(att.route_of_account({"provider": "gmail", "mailbox_kind": "enterprise_user"}), "imap")

    def test_mailbox_route_by_message_id(self):
        r = att.mailbox_route(company_id="testco", message_id="<proxy-1>")
        self.assertEqual(r["route"], "resend")
        self.assertEqual(r["email_address"], PROXY)
        r2 = att.mailbox_route(company_id="testco", message_id="<personal-1>")
        self.assertEqual(r2["route"], "imap")
        self.assertEqual(r2["email_address"], PERSONAL)

    def test_mailbox_route_by_resend_received_id(self):
        r = att.mailbox_route(company_id="testco", message_id="rid-proxy")
        self.assertEqual(r["route"], "resend")

    def test_mailbox_route_unknown_is_not_guessed(self):
        r = att.mailbox_route(company_id="testco", message_id="<never-seen>")
        self.assertEqual(r["route"], "unknown")

    # ── 4/5：--pull 的分流行为 ────────────────────────────
    def test_pull_refuses_personal_mailbox_without_touching_resend(self):
        self._boom_api()
        r = att.pull_message(company_id="testco", message_id="<personal-1>")
        self.assertFalse(r["ok"])
        self.assertEqual(r["route"], "imap")
        self.assertIn("sync", r["next"], "必须告诉 agent 改走 IMAP 重收")
        self.assertIn("--account-id", r["next"])

    def test_pull_proxy_mailbox_still_works(self):
        def fake(path, timeout=30):
            if path == "/emails/receiving/<proxy-1>":
                return {"id": "<proxy-1>", "subject": "quote",
                        "attachments": [{"id": "a1", "filename": "logo.png"}]}
            return {"filename": "logo.png", "content_type": "image/png",
                    "download_url": "https://cdn.example/logo.png"}
        att._api = fake
        r = att.pull_message(company_id="testco", message_id="<proxy-1>")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["route"], "resend")
        self.assertEqual(r["stored"], 1)
        self.assertEqual(Path(r["rows"][0]["path"]).read_bytes(), PNG)

    def test_pull_unknown_route_still_tries_resend(self):
        def fake(path, timeout=30):
            if path == "/emails/receiving/<unknown-1>":
                return {"id": "<unknown-1>", "attachments": []}
            return {}
        att._api = fake
        r = att.pull_message(company_id="testco", message_id="<unknown-1>")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["route"], "unknown")

    def test_account_id_overrides_lookup(self):
        self._boom_api()
        r = att.pull_message(company_id="testco", message_id="<anything>",
                             account_id=self.personal_acc["account_id"])
        self.assertFalse(r["ok"])
        self.assertEqual(r["route"], "imap")

    # ── 6：--latest 先按事实层判链路 ──────────────────────
    def test_pull_latest_routes_personal_to_imap(self):
        # 本地最近一封入站 = 个人邮箱那封（received_at 更晚）
        self._boom_api()
        r = att.pull_latest(company_id="testco", scan=10)
        self.assertFalse(r["ok"])
        self.assertEqual(r["route"], "imap")
        self.assertIn("sync", r["next"])

    def test_pull_latest_scans_resend_when_latest_is_proxy(self):
        from email_gateway.store import EmailStore, utc_now
        # 再插一封更晚的入站，且属于代理邮箱账号
        EmailStore(self.tmp).insert_message({
            "account_id": self.proxy_acc["account_id"], "direction": "inbound",
            "message_id": "<proxy-2>", "resend_received_id": "rid-proxy-2",
            "sender": "buyer3@x.com", "recipients": [PROXY], "company_id": "testco",
            "received_at": "2026-09-15T03:00:00+00:00", "created_at": utc_now(),
            "attachments": [],
        })

        def fake(path, timeout=30):
            if path.startswith("/emails/receiving?limit"):
                # 带收发地址：租户收口过滤靠地址命中，不带地址的 mock 会被滤掉
                return {"data": [{"id": "rid-proxy-2", "to": [PROXY],
                                  "from": "buyer3@x.com"}]}
            if path == "/emails/receiving/rid-proxy-2":
                return {"id": "rid-proxy-2",
                        "attachments": [{"id": "a9", "filename": "logo.png"}]}
            if path == "/emails/receiving/rid-proxy-2/attachments/a9":
                return {"filename": "logo.png", "content_type": "image/png",
                        "download_url": "https://cdn.example/logo.png"}
            return {}
        att._api = fake
        r = att.pull_latest(company_id="testco", scan=5)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["route"], "resend")
        self.assertEqual(r["count"], 1)


if __name__ == "__main__":
    unittest.main()
