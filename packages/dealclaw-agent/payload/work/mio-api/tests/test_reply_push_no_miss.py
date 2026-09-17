#!/usr/bin/env python3
"""按「信」推送（不漏推）回归测试 —— 2026-09-16 田耕郡口径。

口径（客户原话）：intent ∈ {自动回复, 拒绝} 保持静默；**其余全部要推**——
即使一个信号都没有，也必须生成 candidate 并投递；无信号时文案要给买家原文 +
「需你自行判断是否回复」（不自动生成草稿、不自动发信）。绝对不能少。

覆盖：
  A1 有报价信号   → candidate（category=opportunity，标题「买家想报价」）→ 经 dc_notify 投递
  A2 无信号普通回复 → candidate（category=reply，标题「买家回信（未识别出采购意图）」）
                     + 必带买家原文与「需你自行判断是否回复」，且不得出现「草稿已准备好」
  A3 自动回复     → 静默（无 candidate、无通知）
  A4 拒绝         → 静默
  A5 幂等：同一封回信只推一次
  A6 shadow 模式  → 生成 candidate 但不投递；之后转 live 只补投递、不重复建 candidate
  A7 投递通道未变：必须是 dc_notify 的 kind=signal_item / slot=realtime
  A8 missing_info（非机会信号）也只当零信号处理：照样推、不生成草稿

全部离线：MockSender，不触网、不发真实消息。
运行：cd work/mio-api && python3 -m unittest tests.test_reply_push_no_miss -v
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_MIO = Path(__file__).resolve().parents[1]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

ENT = "152600996207"
QUOTE_REPLY = "Please send your best price and MOQ for 500 units, thanks."
PLAIN_REPLY = "Thanks for your email, I will let you know if needed."


class ReplyPushNoMiss(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name) / "data"
        self._env = mock.patch.dict(os.environ, {
            "DC_DATA_DIR": str(self.data),
            "MIO_CDP_SUPPLIER_ID": ENT,
            "DC_SIGNAL_PUSH_AUTOMATION_MODE": "live",
            "DC_SIGNAL_PUSH_ALLOWED_COMPANIES": ENT,
            "DC_NOTIFY_ALLOWED_COMPANIES": ENT,
            "DC_NOTIFY_SENDER_MODE": "feishu",
            "DC_NOTIFY_SEND_ENABLED": "1",
        }, clear=False)
        self._env.start()
        self.addCleanup(self._env.stop)
        self.addCleanup(self.tmp.cleanup)

        import dc_notify
        from dc_email_controller import dc_email_signals, dc_signal_push
        importlib.reload(dc_email_signals)
        importlib.reload(dc_signal_push)
        importlib.reload(dc_notify)
        self.sig, self.push, self.notify = dc_email_signals, dc_signal_push, dc_notify
        self.sender = dc_notify.MockSender()
        self._sender_patch = mock.patch.object(dc_notify, "build_sender_from_env",
                                               lambda *a, **k: self.sender)
        self._sender_patch.start()
        self.addCleanup(self._sender_patch.stop)
        dc_notify.NotifyEngine().set_notification_route(
            ENT, target_type="chat_id", target_id="oc_test", label="E2E 测试群")

    # ── 辅助 ───────────────────────────────────────────
    def _signals_for(self, mid: str, text: str, intent: str = ""):
        res = self.sig.process_reply(reply_text=text, message_id=mid, company_id=ENT,
                                     campaign_id="c1", iq_intent=intent)
        return res.get("signals", [])

    def _push(self, mid: str, text: str, intent: str = "", signals=None, mode=None):
        return self.push.evaluate_reply_for_push(
            mid, intent=intent, text=text, company_id=ENT,
            signals=signals if signals is not None else self._signals_for(mid, text, intent),
            mode=mode)

    def _candidates(self):
        return self.push.list_candidates()

    # ── A1 有报价信号 ──────────────────────────────────
    def test_a1_quote_signal_pushes_with_quote_title(self):
        r = self._push("<q1@buyer>", QUOTE_REPLY)
        self.assertEqual(r["action"], "pushed")
        cand = r["candidate"]
        self.assertEqual(cand["category"], "opportunity")
        self.assertEqual(cand["title"], "买家想报价")
        self.assertEqual(cand["source_message_id"], "<q1@buyer>")
        self.assertEqual(len(self.sender.sent), 1)
        msg = self.sender.sent[0]["message"]
        self.assertIn("买家想报价", msg)
        self.assertIn("买家原文", msg)
        self.assertNotIn("未识别出明确采购意图", msg)

    # ── A2 无信号普通回复（本次修复的核心）──────────────
    def test_a2_no_signal_reply_still_pushes_with_original_text(self):
        r = self._push("<p1@buyer>", PLAIN_REPLY)
        self.assertEqual(r["action"], "pushed")
        cand = r["candidate"]
        self.assertEqual(cand["category"], "reply")
        self.assertEqual(cand["title"], "买家回信（未识别出采购意图）")
        self.assertEqual(cand["signals"], [])
        self.assertEqual(len(self.sender.sent), 1)
        msg = self.sender.sent[0]["message"]
        self.assertIn("买家回信（未识别出采购意图）", msg)
        self.assertIn("Thanks for your email", msg, "必须带买家原文")
        self.assertIn("需你自行判断是否回复", msg)
        self.assertNotIn("回复草稿已准备好", msg, "零信号回信不生成草稿、不得透传草稿文案")

    def test_a2b_reply_candidate_is_recorded_for_reconcile(self):
        """漏推对账要用 candidate_id（company_id + message_id）定位，必须落盘可查。"""
        r = self._push("<p1b@buyer>", PLAIN_REPLY)
        cid = self.push._candidate_id(ENT, "<p1b@buyer>")
        self.assertEqual(r["candidate"]["candidate_id"], cid)
        self.assertIsNotNone(self.push.get_candidate(cid))

    # ── A3/A4 静默两类 ─────────────────────────────────
    def test_a3_auto_reply_is_silent(self):
        r = self._push("<a1@buyer>", "I am out of office until Monday.",
                       intent="自动回复", signals=[])
        self.assertEqual(r["action"], "silent")
        self.assertEqual(r["candidates"], [])
        self.assertEqual(self._candidates(), [])
        self.assertEqual(self.sender.sent, [])

    def test_a4_reject_is_silent(self):
        r = self._push("<r1@buyer>", "No thanks, not interested.", intent="拒绝", signals=[])
        self.assertEqual(r["action"], "silent")
        self.assertEqual(self.sender.sent, [])

    def test_a4b_silent_reply_is_marked_for_reconcile(self):
        """静默要留痕：否则漏推对账会把「按口径不推」误报成漏推。"""
        self._push("<a2@buyer>", "auto reply", intent="自动回复", signals=[])
        entries = self.push.history_entries()
        silent = [e for e in entries if e.get("status") == self.push.SILENT_STATUS]
        self.assertEqual([e["source_message_id"] for e in silent], ["<a2@buyer>"])

    # ── A5 幂等 ───────────────────────────────────────
    def test_a5_same_reply_pushed_once(self):
        first = self._push("<d1@buyer>", PLAIN_REPLY)
        second = self._push("<d1@buyer>", PLAIN_REPLY)
        self.assertEqual(first["action"], "pushed")
        self.assertEqual(second["action"], "duplicate")
        self.assertEqual(len(self.sender.sent), 1, "同一封回信不得推两次")
        self.assertEqual(len(self._candidates()), 1)

    # ── A6 shadow → live 只补投递 ───────────────────────
    def test_a6_shadow_then_live_delivers_without_second_candidate(self):
        shadow = self._push("<s1@buyer>", PLAIN_REPLY, mode="shadow")
        self.assertEqual(shadow["action"], "proposed")
        self.assertEqual(self.sender.sent, [])
        again = self._push("<s1@buyer>", PLAIN_REPLY, mode="live")
        self.assertEqual(again["action"], "pushed", "shadow 期没发出去的，转 live 要补上")
        self.assertEqual(len(self._candidates()), 1)
        self.assertEqual(len(self.sender.sent), 1)

    # ── A7 投递通道未变 ────────────────────────────────
    def test_a7_delivery_goes_through_dc_notify_signal_item(self):
        self._push("<n1@buyer>", PLAIN_REPLY)
        sent = [r for r in self.notify.NotifyEngine().store.read_sent()
                if r.get("kind") == "signal_item"]
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["slot"], "realtime")
        self.assertTrue(sent[0]["dedupe_key"].startswith("signal-push:"))
        self.assertTrue(sent[0]["payload"]["candidate_id"])

    # ── A8 只有 missing_info 的回信 ────────────────────
    def test_a8_missing_info_only_reply_pushes_as_plain_reply(self):
        mid = "<m1@buyer>"
        sigs = self.sig.build_missing_info_signal(["delivery_time"], source_message_id=mid,
                                                 company_id=ENT, campaign_id="c1")
        r = self._push(mid, "When can you deliver?", signals=sigs)
        self.assertEqual(r["action"], "pushed")
        self.assertEqual(r["candidate"]["category"], "reply")
        self.assertEqual(r["candidate"]["title"], "买家回信（未识别出采购意图）")
        self.assertEqual(r["candidate"]["signals"], ["missing_info"])
        self.assertIn("需你自行判断是否回复", self.sender.sent[0]["message"])

    # ── 开关/白名单口径不变 ────────────────────────────
    def test_a9_mode_off_still_silent(self):
        r = self._push("<o1@buyer>", PLAIN_REPLY, mode="off")
        self.assertEqual(r["action"], "skipped")
        self.assertEqual(self._candidates(), [])
        self.assertEqual(self.sender.sent, [])

    def test_a10_non_whitelisted_company_stays_proposed(self):
        r = self.push.evaluate_reply_for_push("<w1@buyer>", text=PLAIN_REPLY,
                                              company_id="otherco", signals=[], mode="live")
        self.assertEqual(r["action"], "proposed")
        self.assertEqual(self.sender.sent, [])


class WebhookChainWired(unittest.TestCase):
    """端到端：handle_inbound_event → 按信 candidate → dc_notify 投递（证明收信链真接上了）。"""

    AGENT_EMAIL = "youhe@industrial.dealclaw.io"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._env = mock.patch.dict(os.environ, {
            "DC_DATA_DIR": self.tmp.name,
            "MIO_CDP_SUPPLIER_ID": ENT,
            "DC_SIGNAL_PUSH_AUTOMATION_MODE": "live",
            "DC_SIGNAL_PUSH_ALLOWED_COMPANIES": ENT,
            "DC_NOTIFY_ALLOWED_COMPANIES": ENT,
            "DC_NOTIFY_SENDER_MODE": "feishu",
            "DC_NOTIFY_SEND_ENABLED": "1",
        }, clear=False)
        self._env.start()
        self.addCleanup(self._env.stop)

        import dc_notify
        from dc_email_controller import dc_email_signals, dc_signal_push, dc_webhook_handler as h
        importlib.reload(dc_email_signals)
        importlib.reload(dc_signal_push)
        importlib.reload(dc_notify)
        self.push = dc_signal_push
        self.notify = dc_notify
        self.sender = dc_notify.MockSender()
        self._sender_patch = mock.patch.object(dc_notify, "build_sender_from_env",
                                               lambda *a, **k: self.sender)
        self._sender_patch.start()
        self.addCleanup(self._sender_patch.stop)
        dc_notify.NotifyEngine().set_notification_route(
            ENT, target_type="chat_id", target_id="oc_test", label="E2E")

        h._store = None
        h._store_db_path = None
        self.h = h
        self.store = h.get_store()
        self.store.insert_message({
            "direction": "outbound", "account_id": "ema_t1",
            "message_id": "<out1@dealclaw.io>", "smtp_message_id": "<out1@dealclaw.io>",
            "company_id": ENT, "campaign_id": "camp-1", "lead_id": "L1",
            "contact_id": "C1", "thread_id": "T1", "subject": "Hello from DealClaw",
            "status": "sent",
        })
        self._orig_account_for_to = h._account_for_to
        h._account_for_to = lambda to_email: {
            "account_id": "ema_t1", "email_address": (to_email or "").lower(),
            "enterprise_id": ENT,
        }
        self.addCleanup(lambda: setattr(h, "_account_for_to", self._orig_account_for_to))

    def _reply(self, text: str, mid: str):
        def fetch(_email_id):
            return {"message_id": mid, "in_reply_to": "<out1@dealclaw.io>",
                    "from": "buyer@example.com", "to": [self.AGENT_EMAIL],
                    "subject": "Re: Hello from DealClaw", "text": text, "headers": []}
        return self.h.handle_inbound_event(
            {"email_id": f"rid-{mid}", "from": "buyer@example.com",
             "to": [self.AGENT_EMAIL], "subject": "Re: Hello from DealClaw"},
            fetch=fetch)

    def test_no_signal_reply_notifies_from_the_chain(self):
        """客户看到的痛点：这种“没信号”的回信以前完全没人知道。"""
        r = self._reply("Thanks, noted.", "<e2e-plain@buyer.example>")
        self.assertEqual(r.get("status"), "bound", r)
        self.assertEqual(len(self.sender.sent), 1, "零信号回信必须也推出去")
        msg = self.sender.sent[0]["message"]
        self.assertIn("买家回信（未识别出采购意图）", msg)
        self.assertIn("Thanks, noted.", msg)
        cand = self.push.get_candidate(self.push._candidate_id(ENT, "<e2e-plain@buyer.example>"))
        self.assertEqual(cand.get("category"), "reply")
        # 零信号回信不备草稿（客户口径：不要自动生成草稿、不要自动发信）。
        from dc_email_controller.dc_reply_draft import list_drafts
        self.assertEqual(list_drafts(company_id=ENT), [])

    def test_quote_reply_notifies_with_quote_title(self):
        r = self._reply("Please send your price and MOQ.", "<e2e-quote@buyer.example>")
        self.assertEqual(r.get("status"), "bound", r)
        self.assertEqual(len(self.sender.sent), 1)
        self.assertIn("买家想报价", self.sender.sent[0]["message"])
        # 修改后仍保留原有语义：机会候选照样自动备草稿（不发送），零信号候选才不备。
        from dc_email_controller.dc_reply_draft import list_drafts
        self.assertEqual(len(list_drafts(company_id=ENT)), 1)

    def test_auto_reply_stays_silent_from_the_chain(self):
        r = self._reply("I am out of office until Monday.", "<e2e-ooo@buyer.example>")
        self.assertEqual(r.get("status"), "bound", r)
        self.assertEqual(self.sender.sent, [], "自动回复按口径保持静默")
        self.assertEqual([c for c in self.push.list_candidates()
                          if c.get("source_message_id") == "<e2e-ooo@buyer.example>"], [])


if __name__ == "__main__":
    unittest.main()
