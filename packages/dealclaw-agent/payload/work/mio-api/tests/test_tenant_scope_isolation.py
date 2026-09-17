#!/usr/bin/env python3
"""test_tenant_scope_isolation.py — 租户隔离回归（2026-09-17 早报串租户事故）。

事故：早报「回信采购意图」里列出了别的租户的回信。成因不是域名匹配，而是
**共用 Resend 账号 + 租户过滤 fail-open**：dealclaw.io 所有子域名都在同一个 Resend
账号下，``/emails/receiving`` 返回的是全平台的信；``dc_resend_history.pull`` 里
``if boxes and not all_tenants:`` 意味着「查不到本租户邮箱 = 不过滤」，于是把别家
租户的收信全部盖上本租户 company_id 写进事实层，早报照着念了出来。

本文件钉死的契约（每条都必须 fail-closed，宁可少拉/少显示，也不许串租户）：

  ① 口径来源：accounts / bindings / 命名库三路并集；数据根与 EmailStore 一致
  ② 查不到本租户邮箱 → require_tenant_mailboxes 抛 TenantScopeUnknown
  ③ pull() 口径未知 → 拒绝拉取，一封都不写
  ④ pull() 口径已知 → 只写地址里有本租户邮箱的信；列表缺 from/to 的取详情后再判
  ⑤ 读侧：归属不明（company_id 为空）的记录不被当前租户认领
  ⑥ 读侧：传 mailboxes 时，历史已污染进本租户目录的记录也读不出来
  ⑦ 早报段落：口径未知时明确说「本段暂不可用」，绝不展示未经核验的邮件
  ⑧ 隔离工具：口径未知时拒绝执行（否则会把整个租户的事实搬进隔离区）

运行：cd work/mio-api && python3 tests/test_tenant_scope_isolation.py -v
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

COMPANY = "100000000001"                      # 本租户
OTHER = "999999999999"                        # 别的租户
MINE = "mine@mail.dealclaw.io"                # 本租户邮箱
THEIRS = "suzhou-pioneer@mail.dealclaw.io"    # 别的租户邮箱（同域名，只是子域名/前缀不同）
BUYER = "junior@empilhadeirasantana.com.br"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class _TenantCase(unittest.TestCase):
    """公共脚手架：干净数据目录 + 可选地给本租户登记一个邮箱。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-tenant-scope-")
        self._env_backup = {k: os.environ.get(k) for k in
                            ("DC_DATA_DIR", "MIO_CDP_SUPPLIER_ID", "OPENCLAW_WORKSPACE_DIR")}
        os.environ["DC_DATA_DIR"] = self.tmp
        os.environ["OPENCLAW_WORKSPACE_DIR"] = self.tmp
        os.environ.pop("MIO_CDP_SUPPLIER_ID", None)   # 不让本机 .env 影响 canonical

    def tearDown(self):
        for k, v in self._env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def add_account(self, *, enterprise_id=COMPANY, email=MINE):
        from email_gateway.store import EmailStore
        return EmailStore().add_account(
            enterprise_id=enterprise_id, owner_open_id="ou_owner",
            email_address=email, provider="resend",
            secret_ref="env:RESEND_API_KEY", mailbox_kind="dealclaw_proxy")

    def add_naming_address(self, *, enterprise_id, address):
        """往命名库塞一条默认邮箱（provisioning 占位分配的那种）。"""
        db = Path(self.tmp) / "email-facts" / "naming" / "addresses.sqlite3"
        db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE IF NOT EXISTS mailbox_address ("
                     "address TEXT PRIMARY KEY, full_address TEXT NOT NULL, "
                     "enterprise_id TEXT NOT NULL)")
        conn.execute("INSERT OR REPLACE INTO mailbox_address VALUES (?, ?, ?)",
                     (address.split("@")[0], address, enterprise_id))
        conn.commit()
        conn.close()

    def insert_inbound(self, *, company_id, sender, recipients, text="hi", message_id=""):
        from email_gateway.store import EmailStore, utc_now
        EmailStore().insert_message({
            "direction": "inbound", "company_id": company_id,
            "message_id": message_id or f"<{sender}-{len(recipients)}@x>",
            "sender": sender, "recipients": recipients, "subject": "Re: ...",
            "text_preview": text, "received_at": utc_now(), "created_at": utc_now(),
        })


# ── ①② 口径本身 ────────────────────────────────────────────────
class TenantMailboxScopeTest(_TenantCase):
    def test_default_data_dir_matches_store(self):
        """DC_DATA_DIR 没设时也必须和 EmailStore 指同一个 data 根。

        以前是 HERE.parent.parent/"data"（= payload/data，根本不存在）→ 查不到
        accounts → 过滤静默失效。
        """
        os.environ.pop("DC_DATA_DIR", None)
        import importlib
        import dc_tenant_mailboxes as tmb
        importlib.reload(tmb)
        from email_gateway.store import EmailStore
        self.assertEqual(tmb._data_dir().resolve(), EmailStore().data_dir.resolve())

    def test_require_raises_when_scope_unknown(self):
        import dc_tenant_mailboxes as tmb
        with self.assertRaises(tmb.TenantScopeUnknown):
            tmb.require_tenant_mailboxes(COMPANY)

    def test_accounts_and_naming_are_both_sources(self):
        import dc_tenant_mailboxes as tmb
        self.add_account()
        self.add_naming_address(enterprise_id=COMPANY, address="Yun <Second@Mail.DealClaw.io>")
        boxes = tmb.require_tenant_mailboxes(COMPANY)
        self.assertEqual(boxes, {MINE, "second@mail.dealclaw.io"},
                         "命名库里的默认邮箱也算本租户邮箱，且要剥显示名 + 小写")

    def test_other_tenant_mailbox_never_counted(self):
        import dc_tenant_mailboxes as tmb
        self.add_account(enterprise_id=OTHER, email=THEIRS)
        with self.assertRaises(tmb.TenantScopeUnknown):
            tmb.require_tenant_mailboxes(COMPANY)

    def test_belongs_to_tenant_parses_display_names(self):
        import dc_tenant_mailboxes as tmb
        rec = {"from": "Júnior <JUNIOR@Foo.com>", "to": [f"Yun <{MINE.upper()}>"]}
        self.assertTrue(tmb.belongs_to_tenant(rec, {MINE}))
        self.assertFalse(tmb.belongs_to_tenant(rec, {THEIRS}))

    def test_empty_mailboxes_never_matches(self):
        import dc_tenant_mailboxes as tmb
        self.assertFalse(tmb.belongs_to_tenant({"to": [MINE]}, set()),
                         "口径未知时不许把任何邮件判成本租户的")


# ── ③④ 拉取链路 ───────────────────────────────────────────────
class ResendPullIsolationTest(_TenantCase):
    """把 Resend 那一端整个打桩：列表里混着本租户和别家租户的信。"""

    def setUp(self):
        super().setUp()
        import dc_resend_history as hist
        self.hist = hist
        self._orig = (hist._key, hist.list_side, hist.fetch_details)
        hist._key = lambda explicit="": "re_test"
        self.items = [
            {"id": "e-mine", "from": BUYER, "to": [MINE], "subject": "mine",
             "created_at": _now()},
            {"id": "e-theirs", "from": "gabriel@tsoha.co.za", "to": [THEIRS],
             "subject": "theirs", "created_at": _now()},
            {"id": "e-blind", "subject": "no addresses in list item",
             "created_at": _now()},          # 列表条目不带 from/to
        ]
        self.details = {
            "e-mine": {"text": "olá", "to": [MINE], "from": BUYER},
            "e-theirs": {"text": "hello", "to": [THEIRS], "from": "gabriel@tsoha.co.za"},
            "e-blind": {"text": "teste", "to": ["youhe@homelife.dealclaw.io"],
                        "from": "mosle@send.dealclaw.io"},   # 详情才暴露是别家的
        }
        hist.list_side = lambda direction, key, limit: list(self.items)
        hist.fetch_details = lambda direction, key, items, workers=1: [
            self.details.get(it.get("id"), {}) for it in items]

    def tearDown(self):
        self.hist._key, self.hist.list_side, self.hist.fetch_details = self._orig
        super().tearDown()

    def _stored(self):
        from email_gateway.store import EmailStore
        return EmailStore().list_inbound_records()

    def test_refuses_pull_when_scope_unknown(self):
        r = self.hist.pull(direction="received", limit=50, company_id=COMPANY)
        self.assertFalse(r["ok"])
        self.assertEqual(r.get("code"), "tenant_scope_unknown")
        self.assertEqual(r.get("written"), 0)
        self.assertEqual(self._stored(), [], "口径未知时一封都不许落库")

    def test_writes_only_tenant_mail(self):
        self.add_account()
        r = self.hist.pull(direction="received", limit=50, company_id=COMPANY)
        self.assertTrue(r["ok"], r)
        stored = self._stored()
        self.assertEqual(len(stored), 1, "只有本租户邮箱的那封能落库")
        self.assertEqual(stored[0]["resend_received_id"], "e-mine")
        self.assertEqual(r["sides"]["received"]["foreign_skipped"], 2,
                         "别家租户的 2 封都要计入 foreign_skipped")
        self.assertTrue(r["sides"]["received"]["tenant_scoped"])

    def test_second_gate_catches_item_without_addresses(self):
        """列表条目没 from/to 时不能直接放行：取完详情必须再判一次归属。"""
        self.add_account()
        self.hist.pull(direction="received", limit=50, company_id=COMPANY)
        ids = {r.get("resend_received_id") for r in self._stored()}
        self.assertNotIn("e-blind", ids, "详情显示是别家租户的，不许写进本租户")

    def test_all_tenants_flag_is_the_only_escape(self):
        """运维显式 --all-tenants 才允许跨租户（跨租户归位工具需要）。"""
        r = self.hist.pull(direction="received", limit=50, company_id=COMPANY,
                           all_tenants=True)
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(self._stored()), 3)
        self.assertFalse(r["sides"]["received"]["tenant_scoped"])


# ── ⑤⑥ 读侧 ──────────────────────────────────────────────────
class InboundReadIsolationTest(_TenantCase):
    def test_unattributed_record_is_not_claimed(self):
        """company_id 为空的记录以前会被 canonical 归到「当前租户」——谁读就归谁。"""
        from email_gateway.store import EmailStore
        self.insert_inbound(company_id="", sender=BUYER, recipients=[THEIRS])
        rows = EmailStore().list_inbound_records(company_id=COMPANY)
        self.assertEqual(rows, [], "归属不明的信不许被当前租户认领")

    def test_other_tenant_record_is_not_returned(self):
        from email_gateway.store import EmailStore
        self.insert_inbound(company_id=OTHER, sender=BUYER, recipients=[THEIRS])
        self.assertEqual(EmailStore().list_inbound_records(company_id=COMPANY), [])

    def test_mailboxes_filter_blocks_historical_pollution(self):
        """已经被写进本租户目录的别家邮件（历史污染），按邮箱核验必须读不出来。"""
        from email_gateway.store import EmailStore
        self.insert_inbound(company_id=COMPANY, sender=BUYER, recipients=[THEIRS],
                            message_id="<polluted@x>")
        self.insert_inbound(company_id=COMPANY, sender=BUYER, recipients=[MINE],
                            message_id="<legit@x>")
        store = EmailStore()
        self.assertEqual(len(store.list_inbound_records(company_id=COMPANY)), 2,
                         "不传 mailboxes 时维持原语义（目录级）")
        rows = store.list_inbound_records(company_id=COMPANY, mailboxes={MINE})
        self.assertEqual([r["message_id"] for r in rows], ["<legit@x>"])


# ── ⑦ 早报段落 ───────────────────────────────────────────────
class BriefSectionIsolationTest(_TenantCase):
    def test_section_refuses_without_tenant_scope(self):
        import dc_daily_report as dr
        self.insert_inbound(company_id=COMPANY, sender=BUYER, recipients=[THEIRS])
        text = dr._reply_intent_section(COMPANY, "morning")
        self.assertIn("本段暂不可用", text)
        self.assertNotIn(THEIRS, text)
        self.assertNotIn(BUYER, text, "口径未知时一封未经核验的信都不许出现在早报里")

    def test_section_filters_polluted_rows_and_says_so(self):
        import dc_daily_report as dr
        self.add_account()
        self.insert_inbound(company_id=COMPANY, sender=BUYER, recipients=[THEIRS],
                            text="别家租户的回信", message_id="<polluted@x>")
        self.insert_inbound(company_id=COMPANY, sender="buyer2@foo.com",
                            recipients=[MINE], text="本租户的回信", message_id="<legit@x>")
        text = dr._reply_intent_section(COMPANY, "morning")
        self.assertIn("buyer2@foo.com", text)
        self.assertNotIn(BUYER, text, "别家租户的回信不许出现在早报里")
        self.assertIn("已按租户隔离过滤", text, "过滤掉多少封要写出来，不能静默")


# ── ⑧ 隔离工具 ───────────────────────────────────────────────
class QuarantineGuardTest(_TenantCase):
    def test_quarantine_refuses_without_scope(self):
        """口径未知时 belongs_to_tenant 恒 False —— 真跑下去会把整个租户搬进隔离区。"""
        import dc_tenant_mailboxes as tmb
        self.insert_inbound(company_id=COMPANY, sender=BUYER, recipients=[MINE])
        with self.assertRaises(tmb.TenantScopeUnknown):
            tmb.quarantine_foreign_facts(COMPANY, self.tmp, apply=True)
        from email_gateway.store import EmailStore
        self.assertEqual(len(EmailStore().list_inbound_records(company_id=COMPANY)), 1,
                         "拒绝执行时不许动任何文件")

    def test_quarantine_moves_only_foreign_facts(self):
        import dc_tenant_mailboxes as tmb
        self.add_account()
        self.insert_inbound(company_id=COMPANY, sender=BUYER, recipients=[THEIRS],
                            message_id="<polluted@x>")
        self.insert_inbound(company_id=COMPANY, sender=BUYER, recipients=[MINE],
                            message_id="<legit@x>")
        r = tmb.quarantine_foreign_facts(COMPANY, self.tmp, apply=True)
        self.assertEqual((r["moved"], r["kept"]), (1, 1))
        from email_gateway.store import EmailStore
        left = [x["message_id"] for x in EmailStore().list_inbound_records(company_id=COMPANY)]
        self.assertEqual(left, ["<legit@x>"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
