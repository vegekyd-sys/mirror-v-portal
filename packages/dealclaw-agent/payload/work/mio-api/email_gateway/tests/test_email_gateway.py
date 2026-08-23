from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from email.message import EmailMessage
from pathlib import Path

from email_gateway.cli import format_notifications
from email_gateway.cron_notify import _build_webhook_card
from email_gateway.imap_sync import ImapSynchronizer
from email_gateway.providers import get_provider
from email_gateway.secrets import SecretResolutionError, resolve_secret
from email_gateway.smtp_send import ConfirmationRequired, SmtpSender
from email_gateway.store import EmailStore
from email_gateway.verify import AccountVerifier


class FakeSmtp:
    instances = []

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs
        self.logged_in = None
        self.message = None
        self.to_addrs = None
        FakeSmtp.instances.append(self)

    def login(self, user, password):
        self.logged_in = (user, password)

    def send_message(self, message, to_addrs=None):
        self.message = message
        self.to_addrs = to_addrs
        return {}

    def noop(self):
        return 250, b"OK"

    def quit(self):
        return None


class FakeImap:
    def __init__(self, *, all_uids, incremental_uids=None, messages=None, uidvalidity=77):
        self.all_uids = all_uids
        self.incremental_uids = incremental_uids if incremental_uids is not None else all_uids
        self.messages = messages or {}
        self.uidvalidity = uidvalidity
        self.logged_in = None
        self.id_sent = False

    def login(self, user, password):
        self.logged_in = (user, password)
        return "OK", [b"logged in"]

    def select(self, folder, readonly=True):
        return "OK", [str(len(self.all_uids)).encode()]

    def response(self, name):
        return "UIDVALIDITY", [str(self.uidvalidity).encode()]

    def _simple_command(self, command, payload):
        if command == "ID":
            self.id_sent = True
            return "OK", [b"ID accepted"]
        raise AssertionError(f"unexpected simple command: {command}")

    def status(self, folder, query):
        return "OK", [f'{folder} (UIDVALIDITY {self.uidvalidity})'.encode()]

    def uid(self, command, *args):
        if command == "search":
            criterion = " ".join(str(arg) for arg in args if arg is not None)
            values = self.all_uids if criterion in {"ALL", "SINCE"} or "SINCE" in criterion else self.incremental_uids
            return "OK", [" ".join(str(uid) for uid in values).encode()]
        if command == "fetch":
            uid = int(args[0])
            raw = self.messages[uid]
            return "OK", [(f"1 (UID {uid} RFC822 {{{len(raw)}}})".encode(), raw), b")"]
        raise AssertionError(f"unexpected IMAP command: {command} {args}")

    def logout(self):
        return "BYE", [b"logout"]


def fake_imap_factory(fake):
    def factory(*args, **kwargs):
        return fake

    return factory


class EmailGatewayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "email.sqlite3"
        self.store = EmailStore(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def add_account(self, **overrides):
        data = {
            "enterprise_id": "tenant-a",
            "owner_open_id": "ou_owner_1",
            "email_address": "owner@example.com",
            "provider": "tencent_exmail",
            "secret_ref": "env:TEST_EMAIL_SECRET",
            "is_default": True,
        }
        data.update(overrides)
        return self.store.add_account(**data)

    def test_provider_presets(self):
        self.assertEqual(get_provider("netease_163").imap_host, "imap.163.com")
        self.assertTrue(get_provider("netease_163").imap_id_required)
        self.assertEqual(get_provider("tencent_exmail").smtp_host, "smtp.exmail.qq.com")
        self.assertEqual(get_provider("gmail").imap_port, 993)

    def test_sync_skips_accounts_without_imap_host(self):
        account = self.add_account(provider="resend", email_address="agent@example.com")
        result = ImapSynchronizer(
            self.store,
            client_factory=lambda *a, **kw: (_ for _ in ()).throw(AssertionError("must not connect")),
            secret_resolver=lambda _: "secret",
        ).sync_account(account["account_id"])
        self.assertEqual(result.events, [])

    def test_notification_text_contains_headers_not_body(self):
        text = format_notifications(
            [{"events": [{
                "email_address": "user@example.com",
                "from": "buyer@example.net",
                "subject": "Re: Catalog",
                "text_preview": "must not leak",
            }]}]
        )
        self.assertIn("buyer@example.net", text)
        self.assertIn("Re: Catalog", text)
        self.assertNotIn("must not leak", text)

    def test_card_presentation_contains_headers_not_body(self):
        card = _build_webhook_card([{
                "email_address": "user@example.com",
                "from": "buyer@example.net",
                "subject": "Re: Catalog",
                "text_preview": "must not leak",
            }]

        )
        encoded = str(card)
        self.assertIn("buyer@example.net", encoded)
        self.assertIn("Re: Catalog", encoded)
        self.assertNotIn("must not leak", encoded)
        self.assertEqual(card["msg_type"], "interactive")
        self.assertEqual(card["card"]["header"]["template"], "purple")

    def test_card_presentation_truncates_body_to_200_characters(self):
        card = _build_webhook_card([{
                "email_address": "user@example.com",
                "from": "buyer@example.net",
                "subject": "Long reply",
                "preview": "正" * 250,
            }]

        )
        body_block = next(
            b for b in card["card"]["elements"]
            if isinstance(b, dict) and "邮件内容" in str(b.get("text", {}).get("content", ""))
        )
        content = body_block["text"]["content"]
        self.assertIn("正" * 200 + "…", content)

    def test_netease_sync_sends_imap_id_before_select(self):
        account = self.add_account(
            email_address="user@example.com",
            provider="netease_163",
        )
        fake = FakeImap(all_uids=[])
        syncer = ImapSynchronizer(
            self.store,
            client_factory=fake_imap_factory(fake),
            secret_resolver=lambda _: "secret",
        )
        syncer.sync_account(account["account_id"])
        self.assertTrue(fake.id_sent)

    def test_multiple_users_and_accounts_can_bind_same_group(self):
        first = self.add_account()
        second = self.add_account(
            owner_open_id="ou_owner_1",
            email_address="second@example.com",
            is_default=False,
        )
        third = self.add_account(
            owner_open_id="ou_owner_2",
            email_address="third@example.com",
            is_default=True,
        )
        for account in (first, second, third):
            self.store.bind_group(account_id=account["account_id"], chat_id="oc_group")
        bindings = self.store.list_bindings(chat_id="oc_group")
        self.assertEqual(len(bindings), 3)
        self.assertEqual({row["owner_open_id"] for row in bindings}, {"ou_owner_1", "ou_owner_2"})
        selected = self.store.select_sender_account(
            enterprise_id="tenant-a", owner_open_id="ou_owner_1"
        )
        self.assertEqual(selected["account_id"], first["account_id"])

    def test_same_mailbox_cannot_have_two_owners_in_one_enterprise(self):
        self.add_account()
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_account(owner_open_id="ou_owner_2")

    def test_personal_mailbox_cannot_be_shared(self):
        account = self.add_account(mailbox_kind="personal")
        with self.assertRaises(PermissionError):
            self.store.grant_member(
                account_id=account["account_id"], user_open_id="ou_owner_2", role="sender"
            )

    def test_enterprise_shared_mailbox_supports_explicit_sender_acl(self):
        account = self.add_account(
            email_address="sales@example.com",
            mailbox_kind="enterprise_shared",
        )
        member = self.store.grant_member(
            account_id=account["account_id"], user_open_id="ou_owner_2", role="sender"
        )
        self.assertEqual(member["role"], "sender")
        selected = self.store.select_sender_account(
            enterprise_id="tenant-a", owner_open_id="ou_owner_2"
        )
        self.assertEqual(selected["account_id"], account["account_id"])
        sender = SmtpSender(
            self.store,
            smtp_ssl_factory=FakeSmtp,
            secret_resolver=lambda _: "app-password",
        )
        result = sender.send(
            account_id=account["account_id"],
            confirmed_by="ou_owner_2",
            to=["buyer@example.net"],
            subject="Shared mailbox",
            text="Body",
        )
        self.assertTrue(result["ok"])

    def test_secret_refs_do_not_store_plaintext(self):
        os.environ["TEST_EMAIL_SECRET"] = "secret-value"
        try:
            self.assertEqual(resolve_secret("env:TEST_EMAIL_SECRET"), "secret-value")
        finally:
            os.environ.pop("TEST_EMAIL_SECRET", None)
        with self.assertRaises(SecretResolutionError):
            resolve_secret("plain-text-secret")

    def test_secret_file_requires_private_permissions(self):
        path = Path(self.tmp.name) / "secret"
        path.write_text("abc", encoding="utf-8")
        path.chmod(0o644)
        with self.assertRaises(SecretResolutionError):
            resolve_secret(f"file:{path}")
        path.chmod(0o600)
        self.assertEqual(resolve_secret(f"file:{path}"), "abc")

    def test_smtp_requires_owner_confirmation_and_records_outbound(self):
        account = self.add_account()
        sender = SmtpSender(
            self.store,
            smtp_ssl_factory=FakeSmtp,
            secret_resolver=lambda _: "app-password",
        )
        with self.assertRaises(ConfirmationRequired):
            sender.send(
                account_id=account["account_id"],
                confirmed_by="ou_someone_else",
                to=["buyer@example.net"],
                subject="Hello",
                text="Body",
            )
        result = sender.send(
            account_id=account["account_id"],
            confirmed_by="ou_owner_1",
            to=["buyer@example.net"],
            subject="Hello",
            text="Body",
        )
        self.assertTrue(result["ok"])
        self.assertEqual(self.store.count_sent_today(account["account_id"]), 1)
        self.assertEqual(FakeSmtp.instances[-1].logged_in[0], "owner@example.com")

    def test_account_verifier_checks_both_transports_without_sending(self):
        account = self.add_account()
        fake_imap = FakeImap(all_uids=[])
        verifier = AccountVerifier(
            self.store,
            imap_factory=fake_imap_factory(fake_imap),
            smtp_ssl_factory=FakeSmtp,
            secret_resolver=lambda _: "app-password",
        )
        result = verifier.verify(account["account_id"])
        self.assertTrue(result["ok"])
        self.assertTrue(result["imap"]["ok"])
        self.assertTrue(result["smtp"]["ok"])
        self.assertIsNone(FakeSmtp.instances[-1].message)

    def test_first_sync_sets_highwater_without_importing_history(self):
        account = self.add_account()
        fake = FakeImap(all_uids=[7, 8, 9])
        syncer = ImapSynchronizer(
            self.store,
            client_factory=fake_imap_factory(fake),
            secret_resolver=lambda _: "secret",
        )
        result = syncer.sync_account(account["account_id"])
        self.assertTrue(result.initialized)
        self.assertEqual(result.last_uid, 9)
        state = self.store.get_sync_state(account["account_id"])
        self.assertEqual(state["uidvalidity"], 77)
        self.assertEqual(state["last_uid"], 9)

    def test_incremental_reply_is_related_and_emits_group_event(self):
        account = self.add_account()
        self.store.bind_group(account_id=account["account_id"], chat_id="oc_group")
        self.store.update_sync_state(
            account_id=account["account_id"], folder="INBOX", uidvalidity=77, last_uid=9
        )
        self.store.insert_message(
            {
                "account_id": account["account_id"],
                "direction": "outbound",
                "message_id": "<outbound-1@example.com>",
                "sender": "owner@example.com",
                "recipients": ["buyer@example.net"],
                "subject": "Hello",
                "status": "sent",
            }
        )
        message = EmailMessage()
        message["From"] = "buyer@example.net"
        message["To"] = "owner@example.com"
        message["Subject"] = "Re: Hello"
        message["Message-ID"] = "<reply-1@example.net>"
        message["In-Reply-To"] = "<outbound-1@example.com>"
        message.set_content("Interested, please send the catalog.")
        fake = FakeImap(all_uids=[10], incremental_uids=[10], messages={10: message.as_bytes()})
        syncer = ImapSynchronizer(
            self.store,
            client_factory=fake_imap_factory(fake),
            secret_resolver=lambda _: "secret",
        )
        result = syncer.sync_account(account["account_id"])
        self.assertEqual(result.fetched, 1)
        self.assertEqual(result.related, 1)
        self.assertEqual(result.events[0]["chat_ids"], ["oc_group"])
        self.assertEqual(result.events[0]["preview"], "Interested, please send the catalog.")
        self.assertEqual(result.last_uid, 10)

    def test_all_filter_notifies_unrelated_mail_without_storing_body(self):
        account = self.add_account()
        self.store.bind_group(
            account_id=account["account_id"], chat_id="oc_group", inbound_filter="all"
        )
        self.store.update_sync_state(
            account_id=account["account_id"], folder="INBOX", uidvalidity=77, last_uid=9
        )
        message = EmailMessage()
        message["From"] = "friend@example.net"
        message["To"] = "owner@example.com"
        message["Subject"] = "Notification test"
        message["Message-ID"] = "<unrelated-1@example.net>"
        message.set_content("private body must not be stored")
        fake = FakeImap(all_uids=[10], incremental_uids=[10], messages={10: message.as_bytes()})
        result = ImapSynchronizer(
            self.store,
            client_factory=fake_imap_factory(fake),
            secret_resolver=lambda _: "secret",
        ).sync_account(account["account_id"])
        self.assertEqual(result.related, 0)
        self.assertEqual(result.events[0]["subject"], "Notification test")
        with sqlite3.connect(self.db) as conn:
            preview = conn.execute(
                "SELECT text_preview FROM email_messages WHERE message_id=?",
                ("<unrelated-1@example.net>",),
            ).fetchone()[0]
        self.assertEqual(preview, "")

    def test_bootstrap_days_advances_to_mailbox_highwater(self):
        account = self.add_account()
        message = EmailMessage()
        message["From"] = "someone@example.net"
        message["To"] = "owner@example.com"
        message["Subject"] = "Recent"
        message["Message-ID"] = "<recent@example.net>"
        message.set_content("recent")
        fake = FakeImap(all_uids=[1, 2, 20], incremental_uids=[20], messages={20: message.as_bytes()})
        original_uid = fake.uid

        def uid(command, *args):
            if command == "search" and any("SINCE" in str(arg) for arg in args):
                return "OK", [b"20"]
            return original_uid(command, *args)

        fake.uid = uid
        syncer = ImapSynchronizer(
            self.store,
            client_factory=fake_imap_factory(fake),
            secret_resolver=lambda _: "secret",
        )
        result = syncer.sync_account(account["account_id"], bootstrap_days=7)
        self.assertEqual(result.last_uid, 20)
        self.assertEqual(self.store.get_sync_state(account["account_id"])["last_uid"], 20)


if __name__ == "__main__":
    unittest.main()
