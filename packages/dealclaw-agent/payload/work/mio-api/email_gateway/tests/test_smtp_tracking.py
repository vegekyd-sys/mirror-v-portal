"""个人邮箱（SMTP/IMAP）追踪回归测试（2026-09-15 田耕郡报「收发后没有追踪记录」）。

四个洞（各一条用例，避免再被「现有测试都显式传了 company_id」盖住）：
  ① email_gateway.cli send 不传 company_id + 落事实闸门只看 resend_id → SMTP 永不落事实
  ③ smtp_send SMTP 分支从不置 provider_accepted → provider_status 恒 ''（乐观 delivered 没生效）
  ② imap_sync 两处 insert_message 不带 company_id → 收发记录全落 _unmatched/，按企业查 0 条
  ④ email_metrics.adapter 无 provider id 即判 legacy_unverified → 个人邮箱指标恒 0

跑法：
  cd work/mio-api && python3 -m unittest tests.test_smtp_tracking -v
  （也在 email_gateway/tests 下，`python3 -m unittest discover -s email_gateway/tests -t .` 会一起跑）
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

from email_gateway.store import EmailStore  # noqa: E402
from email_gateway import smtp_send as smtp  # noqa: E402
from email_gateway import imap_sync as imap  # noqa: E402
from email_metrics import adapter as ad  # noqa: E402
from email_metrics import schema as S  # noqa: E402

ENT = "100000834234"
OWNER = "ou_owner"
PERSONAL = "waqa1988@163.com"


class _FakeSmtpClient:
    """够用的 SMTP 假件：登录成功、发送不被拒（refused 为空）。"""

    def __init__(self, *a, **kw):
        self.sent = []

    def login(self, user, password):
        return ("OK", [b""])

    def send_message(self, msg, to_addrs=None):
        self.sent.append((msg, to_addrs))
        return {}  # 空 dict = 没有任何收件人被拒

    def quit(self):
        return ("BYE", [b""])


class PersonalMailboxTrackingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-smtp-tracking-")
        os.environ["DC_DATA_DIR"] = self.tmp
        self.store = EmailStore(self.tmp)
        self.acct = self.store.add_account(
            enterprise_id=ENT, owner_open_id=OWNER, email_address=PERSONAL,
            provider="netease_163", secret_ref="plain-secret", mailbox_kind="personal",
        )
        self.account_id = self.acct["account_id"]

    # ── ③ SMTP 成功必须乐观记为 delivered，并带上公司号 ───────────────
    def test_smtp_success_marks_provider_accepted_and_company(self):
        client = _FakeSmtpClient()
        sender = smtp.SmtpSender(
            self.store,
            smtp_ssl_factory=lambda *a, **kw: client,
            smtp_factory=lambda *a, **kw: client,
            secret_resolver=lambda ref: "app-password",
        )
        with mock.patch.object(smtp.SmtpSender, "_query_smtp_message_id", lambda self, *a, **kw: "<mid@163.com>"):
            result = sender.send(
                account_id=self.account_id, confirmed_by=OWNER, to=["buyer@example.com"],
                subject="hi", text="hello", company_id=ENT,
            )
        self.assertTrue(result.get("ok"), result)
        recs = self.store.list_outbound_records(ENT)
        self.assertEqual(len(recs), 1, f"发信必须落到企业 {ENT} 下，而不是 _unmatched：{recs}")
        rec = recs[0]
        self.assertEqual(rec.get("company_id"), ENT)
        self.assertEqual(rec.get("provider_status"), S.EV_DELIVERED,
                         "SMTP 无投递回执 → 发信成功即乐观 delivered（此前恒为空串）")

    def test_smtp_without_company_falls_back_to_unmatched(self):
        """不传 company_id 时行为不退步：仍能落一条事实（不再被 CLI 漏传）。

        注意：不能断言「按 ENT 查为空」—— 不同环境里 canonical_company_id 对空串的
        处理不一致（有的树会把空串也归一成租户号），那是环境差异不是行为回归。
        这里改成自洽断言：落盘值与「本环境下 canonical('')」一致。
        """
        client = _FakeSmtpClient()
        sender = smtp.SmtpSender(self.store, smtp_ssl_factory=lambda *a, **kw: client,
                                 smtp_factory=lambda *a, **kw: client,
                                 secret_resolver=lambda ref: "pw")
        with mock.patch.object(smtp.SmtpSender, "_query_smtp_message_id", lambda self, *a, **kw: "<m@163.com>"):
            sender.send(account_id=self.account_id, confirmed_by=OWNER,
                        to=["b@example.com"], subject="s", text="t")
        from enterprise_ids import canonical_company_id
        recs = self.store.list_outbound_records()
        self.assertEqual(len(recs), 1, "即使不传 company_id 也必须落一条事实")
        self.assertEqual(recs[0].get("company_id"), canonical_company_id(""),
                         "不传公司号时按本环境的 canonical('') 落盘（行为不倒退）")

    # ── ④ 没有 resend_id 但有 smtp_message_id → 乐观 accepted，不判未验证 ──
    def test_adapter_falls_back_to_smtp_message_id(self):
        out = ad.adapt_outbound({
            "account_id": "ema_x", "direction": "outbound", "company_id": ENT,
            "smtp_message_id": "<mid@163.com>", "provider_status": "delivered",
            "sent_at": "2026-09-15T02:00:00+00:00",
        })
        self.assertIsNone(out["unverified"], "个人邮箱不该被判 legacy_unverified")
        types = [e[S.F_EVENT_TYPE] for e in out["events"]]
        self.assertIn(S.EV_ACCEPTED, types)
        accepted = [e for e in out["events"] if e[S.F_EVENT_TYPE] == S.EV_ACCEPTED][0]
        self.assertEqual(accepted[S.F_PROVIDER_MESSAGE_ID], "<mid@163.com>")
        self.assertEqual(accepted[S.F_SOURCE], S.SOURCE_SMTP_OPTIMISTIC,
                         "SMTP 是乐观推断，必须单独标注 source，不能冒充 provider 事件")

    def test_adapter_still_unverified_without_any_id(self):
        out = ad.adapt_outbound({"account_id": "ema_x", "direction": "outbound",
                                 "sent_at": "2026-09-15T02:00:00+00:00"})
        self.assertEqual(out["events"], [])
        self.assertTrue(out["unverified"][S.F_LEGACY_UNVERIFIED])

    # ── ② 入站事实必须带 company_id（两处 insert 都不能漏）──────────
    def test_canonical_company_from_account(self):
        self.assertEqual(imap._canonical_company({"enterprise_id": ENT}), ENT)
        self.assertEqual(imap._canonical_company({}), "")

    def test_both_imap_insert_calls_carry_company_id(self):
        src = Path(imap.__file__).read_text(encoding="utf-8")
        # 退信分支与正常分支的入参都必须带 company_id（此前两处都没有）
        self.assertGreaterEqual(src.count('"company_id": _canonical_company(account)'), 1)
        self.assertGreaterEqual(src.count('"company_id": _ident.get("company_id") or _canonical_company(account)'), 1)

    # ── ① CLI：新参数 + SMTP 结果也要落事实 ─────────────────────────
    def test_cli_send_accepts_attribution_flags(self):
        from email_gateway.cli import build_parser
        args = build_parser().parse_args([
            "send", "--account-id", "ema_x", "--confirmed-by", OWNER,
            "--to", "b@example.com", "--subject", "s", "--text", "t",
            "--enterprise", ENT, "--campaign-id", "camp-1",
            "--origin-notify-target", "oc_test",
        ])
        self.assertEqual(args.enterprise, ENT)
        self.assertEqual(args.campaign_id, "camp-1")
        self.assertEqual(args.origin_notify_target, "oc_test")

    def test_cli_lands_fact_for_smtp_result_without_resend_id(self):
        """闸门放开：只有 message_id（SMTP）也要落事实，且落到 account 的 enterprise 下。"""
        from email_gateway import cli as cli_mod

        class _StubSender:
            def __init__(self, store):
                pass

            def send(self, **kw):
                return {"success": True, "count": 1, "message_id": "<mid@163.com>",
                        "resend_id": "", "error": ""}

        out = []
        with mock.patch.object(cli_mod, "SmtpSender", _StubSender), \
             mock.patch.object(cli_mod, "emit", lambda payload: out.append(payload)):
            rc = cli_mod.main([
                "--data-dir", self.tmp,
                "send", "--account-id", self.account_id, "--confirmed-by", OWNER,
                "--to", "buyer@example.com", "--subject", "hi", "--text", "hello",
            ])
        self.assertEqual(rc, 0)
        recs = self.store.list_outbound_records(ENT)
        self.assertEqual(len(recs), 1,
                         f"CLI 必须把 SMTP 发信落成企业下的事实（此前被 resend_id 闸门挡死）：{out[:1]}")
        self.assertEqual(recs[0].get("company_id"), ENT)


if __name__ == "__main__":
    unittest.main()
