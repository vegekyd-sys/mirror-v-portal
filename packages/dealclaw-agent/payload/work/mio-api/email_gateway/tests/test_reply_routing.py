"""回信路由闭环测试：发信会话 → 买家回信 → 通知回**发信的那个会话**（2026-09-15 口径）。

覆盖四条验收 + 两个今天实测到的缺口：

  1. 新 agent 输入公司名即可**幂等**创建邮箱（CLI 入口）
  2. 买家回信 → 通知投递回**发那封邮件的会话**（`origin_notify_target`），
     不是 account 级人工绑定
  3. 其他绑定邮箱同理 + **显式指定优先级最高**（缺失/非法时回退绑定，行为不变）
  4. 读信 → 归属 → 不阻断：多候选收敛时标 low + need_user，仍继续走链路

缺口 a：outbound 事实原先没有「发信会话」字段（store `_normalize` 是白名单，漏列即静默丢弃）
缺口 d：`smtp_message_id` 抽样为空（只有 local_message_id）→ 回信按 In-Reply-To 配不上

跑法（与既有测试一致，标准库 unittest）：
  cd <mio-api> && python3 -m unittest discover -s email_gateway/tests -t . -p "test_*.py"
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway import outbound_facts as of  # noqa: E402
from email_gateway import reply_attribution as ra  # noqa: E402
from email_gateway.inbound_poller import poll_once, resolve_notify_binding  # noqa: E402
from email_gateway.store import EmailStore  # noqa: E402

ENT = "152600996207"
MANAGED = "proxy@mail.dealclaw.io"
ORIGIN = "oc_sending_group"
BOUND = "ou_bound_target"
OTHER = "ou_other_target"


def _iso(days_ago: float = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


class _TempStoreTestCase(unittest.TestCase):
    """公共环境：临时 DC_DATA_DIR + 真实 EmailStore（不碰生产库）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        self._env = mock.patch.dict(os.environ, {"DC_DATA_DIR": str(self.data_dir)})
        self._env.start()
        self.store = EmailStore(self.data_dir)

    def tearDown(self):
        self._env.stop()
        self.tmp.cleanup()

    def add_account(self, email=MANAGED, enterprise_id=ENT):
        return self.store.add_account(
            enterprise_id=enterprise_id, owner_open_id="ou_owner",
            email_address=email, provider="resend", secret_ref="env:TEST_EMAIL_SECRET")


# ── 1. 验收①：公司名 → 幂等建箱 ─────────────────────────────
class MailboxEnsureByCompanyNameTests(_TempStoreTestCase):
    """「新 agent 输入公司名即可幂等创建邮箱」——走 CLI 入口（agent 真实调用面）。"""

    def _cli(self, *args) -> dict:
        from email_gateway import cli

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(["--data-dir", str(self.data_dir), *args])
        self.assertEqual(code, 0, buf.getvalue())
        return json.loads(buf.getvalue())

    def test_company_name_only_creates_then_is_idempotent(self):
        first = self._cli("mailbox-ensure", "--enterprise", ENT,
                          "--company-name", "Suntech Tools",
                          "--owner-open-id", "ou_owner")
        self.assertTrue(first["ok"])
        self.assertTrue(first["created"])
        self.assertTrue(first["email"].endswith("@mail.dealclaw.io"))
        self.assertEqual(first["account_id"], first["account_id"])

        # 第二次：只给公司名 → 同一地址、不新建、account 复用（幂等）
        second = self._cli("mailbox-ensure", "--enterprise", ENT,
                           "--company-name", "Suntech Tools",
                           "--owner-open-id", "ou_owner")
        self.assertEqual(second["email"], first["email"])
        self.assertTrue(second["idempotent"])
        self.assertFalse(second["created"])
        self.assertEqual(second["account_id"], first["account_id"])
        accounts = [a for a in self.store.list_accounts(enterprise_id=ENT)]
        self.assertEqual(len(accounts), 1, "幂等建箱不得产生第二个 account")

    def test_explicit_notify_target_binds_only_when_given(self):
        """不传 notify_target 不落绑定（邮箱归属与通知位置分离）。"""
        no_target = self._cli("mailbox-ensure", "--enterprise", ENT,
                              "--company-name", "Suntech Tools",
                              "--owner-open-id", "ou_owner")
        self.assertEqual(no_target["notify_target"], "")
        self.assertEqual(self.store.list_bindings(), [])

        bound = self._cli("mailbox-ensure", "--enterprise", ENT,
                          "--company-name", "Suntech Tools",
                          "--owner-open-id", "ou_owner",
                          "--notify-target", BOUND)
        self.assertEqual(bound["notify_target"], BOUND)
        self.assertTrue(any(b["chat_id"] == BOUND for b in self.store.list_bindings()))


# ── 2. 缺口 a：outbound 事实落「发信会话」─────────────────────
class OutboundOriginTargetTests(_TempStoreTestCase):
    def test_fact_carries_origin_notify_target(self):
        self.add_account()
        r = of.land_outbound_fact(from_addr=MANAGED, to_list=["buyer@x.com"], subject="hi",
                                  resend_id="re_1", message_id="<mid-1@mail.dealclaw.io>",
                                  enterprise=ENT, origin_notify_target=ORIGIN)
        self.assertTrue(r["ok"], r)
        rec = self.store.find_outbound_by_resend_id("re_1")
        self.assertIsNotNone(rec)
        self.assertEqual(rec["origin_notify_target"], ORIGIN)
        # 归一化白名单必须保留该字段（漏列会被静默丢弃）
        self.assertIn("origin_notify_target", rec)

    def test_legacy_record_without_field_reads_empty_and_does_not_break(self):
        """旧记录缺字段：读到空串，不报错，投递回退绑定（向后兼容）。"""
        self.add_account()
        self.store.insert_message({
            "account_id": self.store.list_accounts(enterprise_id=ENT)[0]["account_id"],
            "direction": "outbound", "sender": MANAGED, "recipients": ["buyer@x.com"],
            "subject": "legacy", "resend_id": "re_legacy", "company_id": ENT,
            "message_id": "<legacy@x>", "status": "sent",
        })
        rec = self.store.find_outbound_by_resend_id("re_legacy")
        self.assertEqual(rec.get("origin_notify_target", ""), "")

    def test_attach_is_idempotent_and_never_adds_second_fact(self):
        """GS 直发的事实由 node 侧落库，入口只能定点补字段，不能新增事实。"""
        self.add_account()
        account_id = self.store.list_accounts(enterprise_id=ENT)[0]["account_id"]
        self.store.insert_message({
            "account_id": account_id, "direction": "outbound", "sender": MANAGED,
            "recipients": ["buyer@x.com"], "subject": "gs", "resend_id": "re_gs_1",
            "company_id": ENT, "message_id": "re_gs_1", "status": "sent",
        })
        first = of.set_origin_notify_target(resend_id="re_gs_1", notify_target=ORIGIN,
                                           store=self.store)
        self.assertTrue(first["ok"])
        self.assertTrue(first["updated"])
        second = of.set_origin_notify_target(resend_id="re_gs_1", notify_target=ORIGIN,
                                            store=self.store)
        self.assertTrue(second["ok"])
        self.assertFalse(second["updated"], "同值重复补写应为幂等 no-op")

        facts = self.store.find_outbounds_by_contact(account_id, "buyer@x.com")
        self.assertEqual(len(facts), 1, "补写发信会话不得产生第二条 outbound 事实")
        self.assertEqual(facts[0]["origin_notify_target"], ORIGIN)

    def test_attach_on_missing_fact_is_best_effort(self):
        r = of.set_origin_notify_target(resend_id="re_absent", notify_target=ORIGIN,
                                        store=self.store)
        self.assertTrue(r["ok"])
        self.assertFalse(r["updated"])

    def test_attach_never_raises_on_store_error(self):
        class Boom:
            def set_outbound_notify_target(self, *_a, **_k):
                raise RuntimeError("store down")

        r = of.set_origin_notify_target(resend_id="re_1", notify_target=ORIGIN, store=Boom())
        self.assertFalse(r["ok"])
        self.assertIn("store down", r["error"])


# ── 3. 缺口 d：provider 真实 Message-ID 落事实 ────────────────
class ProviderMessageIdTests(_TempStoreTestCase):
    """发信成功时把 provider 返回的真实 Message-ID 落到 outbound 事实。

    为什么要：买家回信的 `In-Reply-To` 引用的是 provider 真实 Message-ID，
    只落本地占位 id（`local_xxx`）永远配不上 → 回信「拉到了却认不出」。
    """

    def _send_fd(self, stdout: str, receipt_target: str = ""):
        import dc_email_send

        fake = mock.Mock(returncode=0, stdout=stdout, stderr="")
        with mock.patch("subprocess.run", return_value=fake), \
                mock.patch("dc_send_receipt.push_receipt"):
            return dc_email_send.send_batch(
                channel="FD", from_addr="me@company.com", to_list=["buyer@x.com"],
                subject="Hello", text="hi", enterprise=ENT,
                receipt_target=receipt_target)

    def test_fd_smtp_provider_message_id_lands_in_fact(self):
        self.add_account(email="me@company.com")
        mid = "<178945054690.2688873.883469746086914931@company.com>"
        r = self._send_fd(json.dumps({"messageId": mid, "accepted": ["buyer@x.com"]}),
                          receipt_target=ORIGIN)
        self.assertTrue(r["success"], r)
        self.assertEqual(r["message_id"], mid)
        rec = self.store.find_outbound_by_resend_id("")  # FD/SMTP 无 resend_id
        self.assertIsNone(rec)
        facts = self.store.list_outbound_records(ENT)
        self.assertEqual(len(facts), 1, facts)
        self.assertEqual(facts[0]["smtp_message_id"], mid)
        self.assertEqual(facts[0]["origin_notify_target"], ORIGIN)
        # 回信按 In-Reply-To 能精确配上（这是本缺口的验收点）
        account_id = facts[0]["account_id"]
        self.assertIsNotNone(
            self.store.find_outbound_by_reference(account_id, [mid]))

    def test_gs_attach_sets_origin_on_existing_fact(self):
        """GS：事实由 node 侧已落库，入口只补发信会话，不写第二条。"""
        import dc_email_send

        account_id = self.add_account(email="bambu@mail.dealclaw.io")["account_id"]
        self.store.insert_message({
            "account_id": account_id, "direction": "outbound", "sender": "bambu@mail.dealclaw.io",
            "recipients": ["buyer@x.com"], "subject": "gs", "resend_id": "re_gs_9",
            "company_id": ENT, "message_id": "re_gs_9", "status": "sent",
        })
        fake = mock.Mock(returncode=0, stdout=json.dumps({"id": "re_gs_9"}), stderr="")
        with mock.patch("subprocess.run", return_value=fake), \
                mock.patch("dc_send_receipt.push_receipt"):
            r = dc_email_send.send_batch(channel="GS", from_addr="bambu@mail.dealclaw.io",
                                        to_list=["buyer@x.com"], subject="Hello",
                                        html="<p>hi</p>", enterprise=ENT,
                                        receipt_target=ORIGIN)
        self.assertTrue(r["success"], r)
        facts = self.store.find_outbounds_by_contact(account_id, "buyer@x.com")
        self.assertEqual(len(facts), 1, "GS 通道不得落出第二条事实")
        self.assertEqual(facts[0]["origin_notify_target"], ORIGIN)


# ── 4. 验收②③：投递目标优先级 ───────────────────────────────
class _FakeBindingStore:
    def __init__(self, accounts=None, bindings=None):
        self._accounts = accounts if accounts is not None else [
            {"account_id": "ema_1", "email": MANAGED, "email_address": MANAGED}]
        self._bindings = bindings if bindings is not None else [
            {"account_id": "ema_1", "notify_enabled": 1, "chat_id": BOUND}]

    def list_accounts(self, enterprise_id=None):
        return self._accounts

    def list_bindings(self):
        return self._bindings


class NotifyTargetPriorityTests(unittest.TestCase):
    def test_origin_target_wins_over_account_binding(self):
        b = resolve_notify_binding(origin_notify_target=ORIGIN, address=MANAGED,
                                   store=_FakeBindingStore())
        self.assertEqual(b["chat_id"], ORIGIN)
        self.assertEqual(b["source"], "origin")

    def test_falls_back_to_account_binding_when_no_origin(self):
        b = resolve_notify_binding(origin_notify_target="", address=MANAGED,
                                   store=_FakeBindingStore())
        self.assertEqual(b["chat_id"], BOUND)
        self.assertEqual(b["source"], "binding")

    def test_invalid_origin_falls_back_to_binding(self):
        b = resolve_notify_binding(origin_notify_target="not-a-chat-id", address=MANAGED,
                                   store=_FakeBindingStore())
        self.assertEqual(b["chat_id"], BOUND)
        self.assertEqual(b["source"], "binding")

    def test_account_id_fallback_when_address_unknown(self):
        b = resolve_notify_binding(origin_notify_target="", account_id="ema_1",
                                   address="unknown@x.com", store=_FakeBindingStore())
        self.assertEqual(b["chat_id"], BOUND)

    def test_no_target_returns_empty(self):
        self.assertEqual(resolve_notify_binding(origin_notify_target="", address=MANAGED,
                                                store=_FakeBindingStore(bindings=[])), {})

    def test_private_chat_target_is_accepted(self):
        b = resolve_notify_binding(origin_notify_target=OTHER, address=MANAGED,
                                   store=_FakeBindingStore())
        self.assertEqual(b["chat_id"], OTHER)
        self.assertEqual(b["source"], "origin")


class _PollerDeps:
    def __init__(self, items, ingest_results=None, cursor=None):
        self.items = items
        self.ingest_results = ingest_results or {}
        self.cursor = cursor or {"high_water_received_id": "r2"}
        self.notified = []
        self.saved = []

    def deps(self):
        return {
            "list_received": lambda limit=50: (200, {"data": self.items}),
            "load_cursor": lambda: dict(self.cursor),
            "save_cursor": lambda hw, created, processed: self.saved.append((hw, created, processed)),
            "to_ingest_event": lambda it: {"event_type": "email.received",
                                           "payload": {"email_id": it["id"], "from": it["from"],
                                                       "to": it["to"], "subject": it["subject"]}},
            "ingest": self._ingest,
            "deliver": self._deliver,
        }

    def _ingest(self, event):
        return self.ingest_results.get(event["payload"]["email_id"], {"ok": True, "matched": True})

    def _deliver(self, binding, *, text):
        self.notified.append({"binding": binding, "text": text})
        return {"ok": True, "channel": "app_bot"}


def _item(rid, sender="buyer@x.com", to_addr=MANAGED):
    return {"id": rid, "created_at": "2026-09-15T03:00:00Z", "from": sender,
            "to": [to_addr], "subject": "Re: hi"}


class PollerDeliveryTargetTests(unittest.TestCase):
    """验收②③：回信通知投递回发信会话（不是绑定）；无发信会话时才回退绑定。"""

    def test_notifies_sending_session_when_recorded(self):
        f = _PollerDeps([_item("r3")],
                        ingest_results={"r3": {"ok": True, "matched": True,
                                               "origin_notify_target": ORIGIN}})
        out = poll_once(notify=True, deps=f.deps(), store=_FakeBindingStore())
        self.assertEqual(out["notified"], 1)
        self.assertEqual(f.notified[0]["binding"]["chat_id"], ORIGIN)
        self.assertEqual(out["notify_targets"][0]["source"], "origin")

    def test_falls_back_to_binding_for_legacy_records(self):
        f = _PollerDeps([_item("r3")], ingest_results={"r3": {"ok": True, "matched": True}})
        out = poll_once(notify=True, deps=f.deps(), store=_FakeBindingStore())
        self.assertEqual(f.notified[0]["binding"]["chat_id"], BOUND)
        self.assertEqual(out["notify_targets"][0]["source"], "binding")

    def test_attribution_thread_target_used_when_ingest_unmatched(self):
        """In-Reply-To 精修命中但 ingest 未 matched：仍投回发信会话。"""
        f = _PollerDeps([_item("r3")],
                        ingest_results={"r3": {"ok": True, "matched": False}})
        store = _FakeBindingStore()
        with mock.patch("email_gateway.reply_attribution.attribute",
                        return_value={"attributed": True, "account_id": "ema_1",
                                      "method": "in_reply_to",
                                      "thread": {"origin_notify_target": OTHER}}):
            out = poll_once(notify=True, deps=f.deps(), store=store)
        self.assertEqual(out["matched"], 1)
        self.assertEqual(f.notified[0]["binding"]["chat_id"], OTHER)

    def test_no_target_at_all_still_reports_visible_error(self):
        f = _PollerDeps([_item("r3")])
        out = poll_once(notify=True, deps=f.deps(),
                        store=_FakeBindingStore(accounts=[], bindings=[]))
        self.assertEqual(out["notified"], 0)
        self.assertTrue(any("notify skipped" in e for e in out["errors"]))

    def test_notify_off_keeps_chain_collecting(self):
        """验收④：不通知也不阻断 —— 回信事实包照常产出。"""
        f = _PollerDeps([_item("r3")],
                        ingest_results={"r3": {"ok": True, "matched": True,
                                               "origin_notify_target": ORIGIN,
                                               "text_preview": "Please send catalog"}})
        out = poll_once(notify=False, deps=f.deps(), store=_FakeBindingStore())
        self.assertEqual(f.notified, [])
        self.assertEqual(len(out["replies"]), 1)
        self.assertEqual(out["replies"][0]["excerpt"], "Please send catalog")


# ── 5. 缺口 c：同一联系人多封的收敛口径 ──────────────────────
class FallbackConvergenceTests(_TempStoreTestCase):
    def setUp(self):
        super().setUp()
        from dc_email_controller import dc_email_signals

        self.signals = dc_email_signals
        self._replied = mock.patch.object(dc_email_signals, "replied_thread_ids",
                                          return_value=set())
        self._replied.start()

    def tearDown(self):
        self._replied.stop()
        super().tearDown()

    def _fallback(self, from_email="buyer@x.com", **kwargs):
        from dc_email_controller.dc_webhook_handler import _fallback_match_by_contact

        account = self.add_account()
        return _fallback_match_by_contact(self.store, account["account_id"], from_email,
                                          MANAGED, **kwargs), account

    def _outbound(self, account_id, resend_id, message_id, days_ago):
        self.store.insert_message({
            "account_id": account_id, "direction": "outbound", "sender": MANAGED,
            "recipients": ["buyer@x.com"], "subject": f"t{resend_id}",
            "resend_id": resend_id, "message_id": message_id, "company_id": ENT,
            "status": "sent", "sent_at": _iso(days_ago), "created_at": _iso(days_ago),
        })

    def test_single_match_stays_medium_confidence(self):
        account = self.add_account()
        self._outbound(account["account_id"], "re_1", "<m1@x>", 1)
        from dc_email_controller.dc_webhook_handler import _fallback_match_by_contact

        fb = _fallback_match_by_contact(self.store, account["account_id"], "buyer@x.com", MANAGED)
        self.assertEqual(fb["status"], "matched")
        self.assertEqual(fb["binding_confidence"], "medium")
        self.assertFalse(fb.get("need_user", False))

    def test_multiple_same_contact_converges_to_latest_with_low_confidence(self):
        """实测缺口：16 条同名 outbound 原先一律 ambiguous → 0 matched。

        新口径：挑最近一封未回复的，绑上但标 low + need_user（不静默、不假装确定）。
        """
        account = self.add_account()
        self._outbound(account["account_id"], "re_old", "<m_old@x>", 30)
        self._outbound(account["account_id"], "re_mid", "<m_mid@x>", 5)
        self._outbound(account["account_id"], "re_new", "<m_new@x>", 1)
        from dc_email_controller.dc_webhook_handler import _fallback_match_by_contact

        fb = _fallback_match_by_contact(self.store, account["account_id"], "buyer@x.com", MANAGED)
        self.assertEqual(fb["status"], "matched")
        self.assertEqual(fb["outbound"]["resend_id"], "re_new")
        self.assertEqual(fb["binding_method"], "contact_recent")
        self.assertEqual(fb["binding_confidence"], "low")
        self.assertTrue(fb["need_user"])
        self.assertEqual(len(fb["candidate_outbound_ids"]), 3)

    def test_already_replied_outbound_is_not_chosen_over_unreplied(self):
        account = self.add_account()
        self._outbound(account["account_id"], "re_newer_replied", "<m_new@x>", 1)
        self._outbound(account["account_id"], "re_older_open", "<m_old@x>", 3)
        self._replied.stop()
        self._replied = mock.patch.object(self.signals, "replied_thread_ids",
                                          return_value={"<m_new@x>"})
        self._replied.start()
        from dc_email_controller.dc_webhook_handler import _fallback_match_by_contact

        fb = _fallback_match_by_contact(self.store, account["account_id"], "buyer@x.com", MANAGED)
        self.assertEqual(fb["status"], "matched")
        # 唯一未回复且在窗口内 → 保留旧口径 medium（不惊动人工）
        self.assertEqual(fb["outbound"]["resend_id"], "re_older_open")
        self.assertEqual(fb["binding_confidence"], "medium")
        self.assertFalse(fb.get("need_user", False))

    def test_all_already_replied_in_window_stays_low_confidence(self):
        """每一封都已回复（同线程多轮跟进）→ 仍投递但标 low + need_user。"""
        account = self.add_account()
        self._outbound(account["account_id"], "re_1", "<m1@x>", 1)
        self._outbound(account["account_id"], "re_2", "<m2@x>", 2)
        self._replied.stop()
        self._replied = mock.patch.object(self.signals, "replied_thread_ids",
                                          return_value={"<m1@x>", "<m2@x>"})
        self._replied.start()
        from dc_email_controller.dc_webhook_handler import _fallback_match_by_contact

        fb = _fallback_match_by_contact(self.store, account["account_id"], "buyer@x.com", MANAGED)
        self.assertEqual(fb["status"], "matched")
        self.assertEqual(fb["outbound"]["resend_id"], "re_1")
        self.assertEqual(fb["binding_confidence"], "low")
        self.assertTrue(fb["need_user"])

    def test_out_of_window_is_ambiguous_and_not_guessed(self):
        account = self.add_account()
        self._outbound(account["account_id"], "re_a", "<m_a@x>", 400)
        self._outbound(account["account_id"], "re_b", "<m_b@x>", 300)
        from dc_email_controller.dc_webhook_handler import _fallback_match_by_contact

        fb = _fallback_match_by_contact(self.store, account["account_id"], "buyer@x.com", MANAGED)
        self.assertEqual(fb["status"], "ambiguous")
        self.assertTrue(fb["need_user"])
        self.assertNotIn("outbound", fb)

    def test_window_is_configurable(self):
        account = self.add_account()
        self._outbound(account["account_id"], "re_a", "<m_a@x>", 40)
        self._outbound(account["account_id"], "re_b", "<m_b@x>", 30)
        from dc_email_controller.dc_webhook_handler import _fallback_match_by_contact

        fb = _fallback_match_by_contact(self.store, account["account_id"], "buyer@x.com",
                                        MANAGED, window_days=10)
        self.assertEqual(fb["status"], "ambiguous")

    def test_unknown_contact_does_not_match(self):
        account = self.add_account()
        self._outbound(account["account_id"], "re_1", "<m1@x>", 1)
        from dc_email_controller.dc_webhook_handler import _fallback_match_by_contact

        fb = _fallback_match_by_contact(self.store, account["account_id"], "other@x.com", MANAGED)
        self.assertEqual(fb["status"], "no_match")


# ── 6. 验收②④：端到端（无 In-Reply-To 的真实情况）────────────
class InboundChainTests(_TempStoreTestCase):
    """实测场景复现：Receiving API 不给 In-Reply-To/References + 同联系人多封。

    期望：仍然 matched（low + need_user），把发信会话带出来给投递层，
    而且 inbound 事实、信号链继续（不阻断）。
    """

    def setUp(self):
        super().setUp()
        import importlib

        os.environ.pop("RESEND_API_KEY", None)
        self.signals = importlib.reload(importlib.import_module(
            "dc_email_controller.dc_email_signals"))
        from dc_email_controller import dc_webhook_handler

        self.handler = dc_webhook_handler
        self.handler._store = None
        self.handler._store_db_path = None

    def _fetch(self, email_id):
        return {"headers": [], "text": "Please send your catalog and price list.",
                "from": "buyer@x.com", "to": [MANAGED], "subject": "Re: Hello",
                "message_id": "<reply-1@buyer.x>", "in_reply_to": "", "references": []}

    def test_reply_without_headers_routes_to_sending_session_and_keeps_chain(self):
        account = self.add_account()
        for rid, mid, days in (("re_new", "<m_new@x>", 1), ("re_old", "<m_old@x>", 20)):
            self.store.insert_message({
                "account_id": account["account_id"], "direction": "outbound", "sender": MANAGED,
                "recipients": ["buyer@x.com"], "subject": f"t{rid}", "resend_id": rid,
                "message_id": mid, "company_id": ENT, "status": "sent",
                "sent_at": _iso(days), "created_at": _iso(days),
                "origin_notify_target": ORIGIN if rid == "re_new" else "",
            })
        r = self.handler.handle_inbound_event(
            {"email_id": "em_1", "from": "buyer@x.com", "to": [MANAGED]}, fetch=self._fetch)

        self.assertTrue(r["matched"], r)
        self.assertEqual(r["status"], "bound")
        self.assertEqual(r["origin_notify_target"], ORIGIN)
        self.assertEqual(r["binding_confidence"], "low")
        self.assertTrue(r["need_user"])
        self.assertEqual(len(r["candidate_outbound_ids"]), 2)
        # inbound 事实照旧落库（读信链不阻断）
        inbound = [m for m in self.store.list_inbound_records(ENT)]
        self.assertEqual(len(inbound), 1, inbound)

    def test_signal_chain_still_runs_for_low_confidence_binding(self):
        """验收④：低置信归属也要继续出信号（不能因为“不确定”就静默断链）。"""
        account = self.add_account()
        self.store.insert_message({
            "account_id": account["account_id"], "direction": "outbound", "sender": MANAGED,
            "recipients": ["buyer@x.com"], "subject": "t1", "resend_id": "re_1",
            "message_id": "<m1@x>", "company_id": ENT, "status": "sent",
            "sent_at": _iso(1), "created_at": _iso(1), "origin_notify_target": ORIGIN,
        })
        self.store.insert_message({
            "account_id": account["account_id"], "direction": "outbound", "sender": MANAGED,
            "recipients": ["buyer@x.com"], "subject": "t2", "resend_id": "re_2",
            "message_id": "<m2@x>", "company_id": ENT, "status": "sent",
            "sent_at": _iso(2), "created_at": _iso(2),
        })
        r = self.handler.handle_inbound_event(
            {"email_id": "em_2", "from": "buyer@x.com", "to": [MANAGED]}, fetch=self._fetch)
        self.assertTrue(r["matched"], r)
        import importlib

        signals = importlib.reload(self.signals)
        rows = signals.list_signals(ENT)
        self.assertTrue(rows, "低置信绑定也必须产出信号（否则等于静默断链）")

    def test_unknown_recipient_mailbox_is_not_attributed(self):
        self.add_account()
        r = self.handler.handle_inbound_event(
            {"email_id": "em_3", "from": "buyer@x.com", "to": ["ghost@mail.dealclaw.io"]},
            fetch=self._fetch)
        self.assertFalse(r["matched"])
        self.assertEqual(r["failure_reason"], "no_matching_outbound")


# ── 7. 归属层透传发信会话 ────────────────────────────────────
class AttributionThreadCarriesOriginTests(_TempStoreTestCase):
    def test_refine_thread_returns_origin_notify_target(self):
        account = self.add_account(email="bambu@mail.dealclaw.io")
        mid = "<mid-attr@mail.dealclaw.io>"
        of.land_outbound_fact(from_addr="bambu@mail.dealclaw.io", to_list=["buyer@x.com"],
                              subject="闭环", resend_id="re_1", message_id=mid,
                              enterprise=ENT, origin_notify_target=ORIGIN)
        a = ra.attribute(recipients=["bambu@mail.dealclaw.io"], sender="buyer@x.com",
                         in_reply_to=mid, store=self.store,
                         facts_dir=str(self.data_dir / "email-facts"))
        self.assertTrue(a["attributed"])
        self.assertEqual(a["thread"]["origin_notify_target"], ORIGIN)

    def test_recent_thread_fallback_carries_origin_notify_target(self):
        account = self.add_account(email="bambu@mail.dealclaw.io")
        of.land_outbound_fact(from_addr="bambu@mail.dealclaw.io", to_list=["buyer@x.com"],
                              subject="开发信", resend_id="re_2",
                              enterprise=ENT, origin_notify_target=ORIGIN)
        a = ra.attribute(recipients=["bambu@mail.dealclaw.io"], sender="buyer@x.com",
                         store=self.store, facts_dir=str(self.data_dir / "email-facts"))
        self.assertTrue(a["attributed"])
        self.assertEqual(a["thread"]["origin_notify_target"], ORIGIN)


# ── 8. 验收闭环：发信 → 回信 → 通知回发信会话 ───────────
class EndToEndChainTests(_TempStoreTestCase):
    """一条真链路走完：dc_email_send 发信（provider 真实 Message-ID 落事实）
    → 买家回信（In-Reply-To 引用它）→ 归属 matched → 通知投递回**发信的那个会话**。

    刻意在场：account 上**存在另一条人工绑定**，用来证明发信会话优先级最高。
    """

    def setUp(self):
        super().setUp()
        import importlib

        os.environ.pop("RESEND_API_KEY", None)
        self.signals = importlib.reload(importlib.import_module(
            "dc_email_controller.dc_email_signals"))
        from dc_email_controller import dc_webhook_handler

        self.handler = dc_webhook_handler
        self.handler._store = None
        self.handler._store_db_path = None
        self.account = self.add_account(email="me@company.com")

    def _fake_fetch(self, in_reply_to):
        def fetch(email_id):
            return {"headers": [], "text": "Please quote 500 units.",
                    "from": "buyer@x.com", "to": ["me@company.com"],
                    "subject": "Re: Hello", "message_id": "<reply-1@buyer.x>",
                    "in_reply_to": in_reply_to, "references": []}
        return fetch

    def test_reply_notifies_the_session_that_sent(self):
        import dc_email_send

        # 0) 人类人工绑定到另一个会话（旧机制）—— 不得抢赢发信会话
        self.store.bind_group(account_id=self.account["account_id"], chat_id=BOUND,
                              notify_enabled=True)

        # 1) 发信：provider 返回真实 Message-ID
        mid = "<178945054690.2688873.883469746086914931@company.com>"
        fake = mock.Mock(returncode=0,
                         stdout=json.dumps({"messageId": mid, "accepted": ["buyer@x.com"]}),
                         stderr="")
        with mock.patch("subprocess.run", return_value=fake), \
                mock.patch("dc_send_receipt.push_receipt"):
            sent = dc_email_send.send_batch(
                channel="FD", from_addr="me@company.com", to_list=["buyer@x.com"],
                subject="Hello", text="hi", enterprise=ENT, receipt_target=ORIGIN)
        self.assertTrue(sent["success"], sent)
        self.assertEqual(sent["message_id"], mid)

        # 2) 取信：回信按 In-Reply-To 精确命中刚发的那封
        notified = []

        def deliver(binding, *, text):
            notified.append({"binding": binding, "text": text})
            return {"ok": True, "channel": "app_bot"}

        def ingest(event):
            # 真链路里由 dc_email_ingest.ingest_resend_event 调 handler 并包一层 ``ok``
            # （入站：ok = status != retryable）。本文只替掉联网取信那一步。
            r = self.handler.handle_inbound_event(event["payload"],
                                                  fetch=self._fake_fetch(mid))
            return {"ok": r.get("status") != "retryable", **r}

        item = {"id": "rcv_1", "created_at": _iso(0), "from": "buyer@x.com",
                "to": ["me@company.com"], "subject": "Re: Hello"}
        cursor = {"high_water_received_id": "rcv_0"}
        out = poll_once(notify=True, store=self.store, deps={
            "list_received": lambda limit=50: (200, {"data": [item]}),
            "load_cursor": lambda: dict(cursor),
            "save_cursor": lambda hw, created, processed: None,
            "to_ingest_event": lambda it: {"event_type": "email.received", "payload": it},
            "ingest": ingest,
            "deliver": deliver,
        })

        self.assertEqual(out["matched"], 1, out["errors"])
        self.assertEqual(out["notified"], 1, out["errors"])
        self.assertEqual(notified[0]["binding"]["chat_id"], ORIGIN)
        self.assertEqual(out["notify_targets"][0]["source"], "origin")
        self.assertIn("buyer@x.com", notified[0]["text"])


if __name__ == "__main__":
    unittest.main()
