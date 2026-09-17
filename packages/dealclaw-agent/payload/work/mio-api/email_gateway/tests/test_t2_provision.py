"""任务 T2：默认邮箱懒创建 + 两处触发接线 + 发信前置闸门 — unittest 测试。

运行：
    cd work/mio-api && python3 -m unittest discover -s email_gateway/tests -t .

覆盖：ensure_mailbox 幂等与并发（唯一索引，非先查后写）、slug/公司名取词复用 T1、
account 落库与复用、reserved→active 激活与「退休地址绝不复活」、通知目标绑定、
发信闸门三种模式与三种触发场景、接线不改变既有行为（触发 A/B 接入点）。

写法与既有测试一致：文件头把 ``parents[2]``（mio-api 根）插入 ``sys.path``；
所有用例使用临时目录（``DC_DATA_DIR``），不接触生产库。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway import naming, provision
from email_gateway.naming import MAIL_DOMAIN, STATE_ACTIVE, STATE_RECEIVE_ONLY, MailboxNamingStore
from email_gateway.provision import (
    InvalidInputError,
    InvalidSlugInputError,
    SendNotReadyError,
    assert_send_ready,
    check_send_ready,
    ensure_mailbox,
    gate_blocked_result,
    mailbox_readiness,
    try_ensure_mailbox,
)
from email_gateway.store import EmailStore

_TENANT_ENV_KEYS = (
    "MIO_CDP_SUPPLIER_ID", "DC_ENTERPRISE_ID",
    "MIO_V_OPEN_ID", "DC_MAILBOX_OWNER_OPEN_ID",
    "DC_MAILBOX_GATE", "DC_DATA_DIR",
)


class ProvisionTestCase(unittest.TestCase):
    """公共环境：临时数据目录 + 清空租户相关环境变量。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        self._saved_env = {k: os.environ.get(k) for k in _TENANT_ENV_KEYS}
        for key in _TENANT_ENV_KEYS:
            os.environ.pop(key, None)
        os.environ["DC_DATA_DIR"] = str(self.data_dir)
        self.naming = MailboxNamingStore(self.data_dir)
        self.store = EmailStore(self.data_dir)

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    # ── 助手 ──────────────────────────────────────────────
    def _ensure(self, **kwargs):
        kwargs.setdefault("company_name", "Suntech Tools")
        kwargs.setdefault("data_dir", self.data_dir)
        return ensure_mailbox(**kwargs)


# ── 1. 懒创建 + 幂等 ─────────────────────────────────────────
class LazyCreateTests(ProvisionTestCase):
    def test_01_ensure_reserves_address_without_activating(self):
        result = self._ensure(enterprise_id="100000834234")
        self.assertTrue(result["ok"])
        self.assertTrue(result["created"])
        self.assertFalse(result["idempotent"])
        self.assertTrue(naming.is_valid_slug(result["address"]))
        self.assertEqual(result["email"], f"{result['address']}@{MAIL_DOMAIN}")
        # 未显式 activate → 只占位，不发信（PRD 5.2 第一步）
        self.assertEqual(result["status"], "reserved")
        self.assertFalse(result["send_ready"])
        self.assertFalse(result["activated"])
        self.assertEqual(len(self.naming.list_addresses(enterprise_id="100000834234")), 1)

    def test_02_ensure_is_idempotent_and_does_not_duplicate(self):
        first = self._ensure(enterprise_id="100000834234")
        second = self._ensure(enterprise_id="100000834234", brand_name_en="Totally Different")
        self.assertEqual(first["email"], second["email"])
        self.assertTrue(second["idempotent"])
        self.assertFalse(second["created"])
        rows = self.naming.list_addresses(enterprise_id="100000834234")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["address"], first["address"])

    def test_03_company_name_pinyin_fallback_is_deterministic(self):
        first = self._ensure(enterprise_id="300000000003",
                             company_name="深圳市辉洋科技有限公司",
                             brand_name_en="", short_name_en="")
        second = self._ensure(enterprise_id="300000000003",
                              company_name="深圳市辉洋科技有限公司",
                              brand_name_en="", short_name_en="")
        self.assertEqual(first["email"], second["email"])
        self.assertTrue(naming.is_valid_slug(first["address"]))

    def test_04_explicit_slug_has_top_priority(self):
        result = self._ensure(enterprise_id="100000834234", slug="acme-tools",
                              brand_name_en="Should Not Win")
        self.assertEqual(result["address"], "acme-tools")
        self.assertEqual(result["email"], f"acme-tools@{MAIL_DOMAIN}")

    def test_05_invalid_slug_is_rejected_with_code(self):
        with self.assertRaises(InvalidSlugInputError) as ctx:
            self._ensure(enterprise_id="100000834234", slug="ab")
        self.assertEqual(ctx.exception.code, "invalid_slug")
        soft = try_ensure_mailbox("100000834234", slug="ab", data_dir=self.data_dir)
        self.assertFalse(soft["ok"])
        self.assertEqual(soft["code"], "invalid_slug")

    def test_06_reserved_word_slug_falls_back_to_stable_short_code(self):
        result = self._ensure(enterprise_id="100000834234", slug="sales")
        self.assertNotEqual(result["address"], "sales")
        self.assertTrue(result["address"].startswith("sales-"))
        self.assertTrue(result["suffixed"])

    def test_07_two_tenants_same_brand_get_different_stable_addresses(self):
        a = self._ensure(enterprise_id="100000834234", brand_name_en="Suntech Tools")
        b = self._ensure(enterprise_id="200000000002", brand_name_en="Suntech Tools")
        self.assertNotEqual(a["email"], b["email"])
        self.assertTrue(b["suffixed"])
        again = self._ensure(enterprise_id="200000000002", brand_name_en="Suntech Tools")
        self.assertEqual(again["email"], b["email"])

    def test_08_missing_tenant_is_invalid_input(self):
        soft = try_ensure_mailbox("", company_name="X", data_dir=self.data_dir)
        self.assertFalse(soft["ok"])
        self.assertEqual(soft["code"], "invalid_input")
        self.assertEqual(self.naming.list_addresses(), [])


# ── 2. account / 通知目标落库 ────────────────────────────────
class AccountAndNotifyTests(ProvisionTestCase):
    def test_09_without_owner_address_only_no_account(self):
        result = self._ensure(enterprise_id="100000834234")
        self.assertEqual(result["account_id"], "")
        self.assertFalse(result["account_created"])
        self.assertIn("account_missing", result["blockers"])
        self.assertEqual(self.store.list_accounts(enterprise_id="100000834234"), [])

    def test_10_owner_creates_account_and_later_calls_reuse_it(self):
        first = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner")
        self.assertTrue(first["account_created"])
        self.assertTrue(first["account_id"].startswith("ema_"))
        account = self.store.get_account(first["account_id"])
        self.assertEqual(account["email_address"], first["email"])
        self.assertEqual(account["mailbox_kind"], provision.DEFAULT_MAILBOX_KIND)
        self.assertEqual(account["provider"], provision.DEFAULT_MAILBOX_PROVIDER)
        second = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner")
        self.assertEqual(second["account_id"], first["account_id"])
        self.assertFalse(second["account_created"])
        self.assertEqual(len(self.store.list_accounts(enterprise_id="100000834234")), 1)

    def test_11_lazy_account_does_not_steal_existing_default(self):
        self.store.add_account(enterprise_id="100000834234", owner_open_id="ou_human",
                               email_address="person@company.com", provider="tencent_exmail",
                               secret_ref="env:X", is_default=True)
        result = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner")
        lazy = self.store.get_account(result["account_id"])
        self.assertFalse(bool(lazy["is_default"]))
        defaults = [a for a in self.store.list_accounts(enterprise_id="100000834234")
                    if a.get("is_default")]
        self.assertEqual([a["email_address"] for a in defaults], ["person@company.com"])

    def test_12_notify_target_creates_binding_and_makes_gate_ready(self):
        result = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner",
                              notify_target="ou_owner", activate=True)
        self.assertEqual(result["notify_target"], "ou_owner")
        self.assertEqual(result["status"], STATE_ACTIVE)
        self.assertTrue(result["activated"])
        self.assertTrue(result["routing_ready"])
        self.assertTrue(result["notify_ready"])
        self.assertTrue(result["send_ready"])
        bindings = [b for b in self.store.list_bindings()
                    if b["account_id"] == result["account_id"]]
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0]["chat_id"], "ou_owner")
        self.assertTrue(bindings[0]["notify_enabled"])
        self.assertEqual(bindings[0]["inbound_filter"], "dealclaw_replies")

    def test_13_no_notify_target_means_not_ready_and_no_binding(self):
        result = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner",
                              activate=True)
        self.assertFalse(result["notify_ready"])
        self.assertFalse(result["send_ready"])
        self.assertIn("notify_missing", result["blockers"])
        self.assertEqual(self.store.list_bindings(), [])

    def test_14_bad_notify_target_rejected_before_any_write(self):
        with self.assertRaises(InvalidInputError) as ctx:
            self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner",
                         notify_target="not-an-id")
        self.assertEqual(ctx.exception.code, "invalid_input")
        # 早期校验：不得留下半截状态（占位/account 都没写）
        self.assertIsNone(self.naming.get_current_address("100000834234"))
        self.assertEqual(self.store.list_accounts(enterprise_id="100000834234"), [])

    def test_15_activate_is_idempotent_and_retired_address_is_never_revived(self):
        first = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner",
                             activate=True)
        again = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner",
                             activate=True)
        self.assertFalse(again["activated"])          # 已 active，不重复迁移
        self.assertEqual(again["status"], STATE_ACTIVE)
        self.assertEqual(again["email"], first["email"])

        self.naming.retire(first["address"], reason="replaced")
        after = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner",
                             activate=True)
        # 既不悄悄复活旧地址，也不自动铸造新地址（重新生成须用户明确发起）
        self.assertFalse(after["activated"])
        self.assertNotEqual(after["status"], STATE_ACTIVE)
        self.assertEqual(after["status"], STATE_RECEIVE_ONLY)
        self.assertEqual(after["email"], first["email"])
        self.assertTrue(after["needs_replace"])
        self.assertFalse(after["send_ready"])
        self.assertIn("mailbox_retired", after["blockers"])
        self.assertEqual(len(self.naming.list_addresses(enterprise_id="100000834234")), 1)
        self.assertTrue(self.naming.is_tombstoned(first["address"]))


# ── 3. 并发 ─────────────────────────────────────────────────
class ConcurrencyTests(ProvisionTestCase):
    def test_16_concurrent_ensure_yields_single_address_and_account(self):
        results: list[dict] = []
        lock = threading.Lock()

        def worker(index: int) -> None:
            out = try_ensure_mailbox("100000834234", brand_name_en="Acme Tools",
                                     owner_open_id=f"ou_owner_{index}",
                                     data_dir=self.data_dir)
            with lock:
                results.append(out)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertTrue(all(r["ok"] for r in results), results)
        self.assertEqual({r["email"] for r in results}, {results[0]["email"]})
        self.assertEqual(len({r["account_id"] for r in results if r["account_id"]}), 1)
        self.assertEqual(len(self.naming.list_addresses(enterprise_id="100000834234")), 1)
        self.assertEqual(len(self.store.list_accounts(enterprise_id="100000834234")), 1)


# ── 4. 发信前置闸门 ─────────────────────────────────────────
class SendGateTests(ProvisionTestCase):
    def test_17_gate_not_applicable_for_self_owned_mailbox(self):
        gate = check_send_ready(enterprise_id="100000834234",
                                from_address="person@company.com",
                                data_dir=self.data_dir)
        self.assertFalse(gate["applicable"])
        self.assertTrue(gate["allowed"])
        self.assertEqual(gate["reason"], "not_a_dealclaw_default_mailbox")

    def test_18a_gate_only_applies_to_naming_owned_mailboxes(self):
        # 未经命名服务预留的 mail.dealclaw.io 地址 → 不适用（既有发信行为不变）
        gate = check_send_ready(enterprise_id="100000834234",
                                from_address=f"ghost@{MAIL_DOMAIN}",
                                data_dir=self.data_dir)
        self.assertFalse(gate["applicable"])
        self.assertTrue(gate["allowed"])
        self.assertEqual(self.naming.list_addresses(), [])

    def test_18b_gate_blocks_reserved_mailbox_without_account(self):
        email = self._ensure(enterprise_id="100000834234")["email"]
        gate = check_send_ready(enterprise_id="100000834234", from_address=email,
                                data_dir=self.data_dir)
        self.assertTrue(gate["applicable"])
        self.assertFalse(gate["allowed"])
        self.assertIn("account_missing", gate["blockers"])

    def test_19_gate_blocks_reserved_address(self):
        result = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner",
                              notify_target="ou_owner")     # 未 activate
        gate = check_send_ready(enterprise_id="100000834234",
                                from_address=result["email"], data_dir=self.data_dir)
        self.assertTrue(gate["applicable"])
        self.assertFalse(gate["allowed"])
        self.assertIn("naming_not_active", gate["blockers"])

    def test_20_gate_blocks_when_notify_target_missing(self):
        result = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner",
                              activate=True)
        gate = check_send_ready(enterprise_id="100000834234",
                                from_address=f"V <{result['email']}>",
                                data_dir=self.data_dir)
        self.assertFalse(gate["allowed"])
        self.assertIn("notify_missing", gate["blockers"])

    def test_21_gate_allows_when_fully_ready(self):
        result = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner",
                              notify_target="ou_owner", activate=True)
        gate = check_send_ready(enterprise_id="100000834234",
                                from_address=f"V <{result['email']}>",
                                data_dir=self.data_dir)
        self.assertTrue(gate["applicable"])
        self.assertTrue(gate["allowed"])
        self.assertEqual(gate["blockers"], [])
        self.assertTrue(assert_send_ready(enterprise_id="100000834234",
                                          from_address=result["email"],
                                          data_dir=self.data_dir)["allowed"])

    def test_22_assert_send_ready_raises_with_blockers(self):
        email = self._ensure(enterprise_id="100000834234")["email"]   # reserved，全未就绪
        with self.assertRaises(SendNotReadyError) as ctx:
            assert_send_ready(enterprise_id="100000834234",
                              from_address=email, data_dir=self.data_dir)
        self.assertEqual(ctx.exception.code, "send_gate_not_ready")
        self.assertIn("naming_not_active", ctx.exception.detail["blockers"])

    def test_24_gate_blocked_result_never_claims_success(self):
        email = self._ensure(enterprise_id="100000834234")["email"]
        gate = check_send_ready(enterprise_id="100000834234", from_address=email,
                                data_dir=self.data_dir)
        blocked = gate_blocked_result(gate)
        self.assertFalse(blocked["success"])
        self.assertFalse(blocked["sent"])
        self.assertEqual(blocked["count"], 0)
        self.assertEqual(blocked["code"], "send_gate_not_ready")
        self.assertTrue(blocked["error"])

    def test_25_readiness_is_read_only(self):
        self._ensure(enterprise_id="100000834234")
        before = len(self.naming.list_addresses())
        mailbox_readiness(enterprise_id="100000834234", data_dir=self.data_dir)
        mailbox_readiness(enterprise_id="", data_dir=self.data_dir)
        self.assertEqual(len(self.naming.list_addresses()), before)


# ── 5. 触发 B 接线（dc_email_send.send_batch 前置闸门）────────
class SendBatchGateWiringTests(ProvisionTestCase):
    def _send_batch(self, **kwargs):
        from dc_email_send import send_batch
        kwargs.setdefault("channel", "GS")
        kwargs.setdefault("subject", "Hello")
        kwargs.setdefault("html", "<p>hi</p>")
        kwargs.setdefault("text", "hi")
        kwargs.setdefault("enterprise", "100000834234")
        return send_batch(**kwargs)

    def test_26_send_batch_refuses_and_never_calls_sender(self):
        email = self._ensure(enterprise_id="100000834234")["email"]
        with mock.patch("subprocess.run") as runner:
            result = self._send_batch(from_addr=email, to_list=["buyer@example.com"])
        runner.assert_not_called()
        self.assertFalse(result["success"])
        self.assertFalse(result["sent"])
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["code"], "send_gate_not_ready")
        self.assertIn("naming_not_active", result["blockers"])

    def test_27_send_batch_blocked_pushes_honest_receipt(self):
        email = self._ensure(enterprise_id="100000834234")["email"]
        with mock.patch("subprocess.run") as runner, \
                mock.patch("dc_send_receipt.push_receipt") as receipt:
            result = self._send_batch(from_addr=email, to_list=["buyer@example.com"],
                                      receipt_target="oc_group")
        runner.assert_not_called()
        receipt.assert_called_once()
        text = receipt.call_args[0][1]
        self.assertIn("未发送", text)
        self.assertNotIn("已发出", text)
        self.assertFalse(result["success"])

    def test_28_send_batch_unchanged_for_self_owned_mailbox(self):
        fake = mock.Mock(returncode=0, stdout='{"id": "resend_1"}', stderr="")
        with mock.patch("subprocess.run", return_value=fake):
            result = self._send_batch(from_addr="person@company.com",
                                      to_list=["buyer@example.com"])
        self.assertTrue(result["success"])
        self.assertEqual(result["resend_id"], "resend_1")
        self.assertFalse(result["gate"]["applicable"])

    def test_29_send_batch_passes_gate_for_ready_default_mailbox(self):
        ready = self._ensure(enterprise_id="100000834234", owner_open_id="ou_owner",
                             notify_target="ou_owner", activate=True)
        fake = mock.Mock(returncode=0, stdout='{"id": "resend_2"}', stderr="")
        with mock.patch("subprocess.run", return_value=fake):
            result = self._send_batch(from_addr=ready["email"],
                                      to_list=["buyer@example.com"])
        self.assertTrue(result["success"])
        self.assertTrue(result["gate"]["applicable"])
        self.assertTrue(result["gate"]["allowed"])


# ── 6. 触发 A 接线（dc_ls_store.save_lead 落池后）────────────
class LeadPoolWiringTests(ProvisionTestCase):
    def setUp(self):
        super().setUp()
        import dc_ls_store
        self.ls_module = dc_ls_store
        self._patchers = [
            mock.patch.object(dc_ls_store, "_LEADS_FILE", str(self.data_dir / "leads.json")),
            mock.patch.object(dc_ls_store, "_PREFS_FILE", str(self.data_dir / "prefs.json")),
        ]
        for patcher in self._patchers:
            patcher.start()

    def tearDown(self):
        for patcher in self._patchers:
            patcher.stop()
        super().tearDown()

    def _lead(self, **kwargs):
        lead = {"company_name": "Suntech Tools", "domain": "suntech.com",
                "enterprise": "suntech.com", "user_open_id": "ou_lead_user"}
        lead.update(kwargs)
        return lead

    def test_30_save_lead_return_value_unchanged_without_tenant(self):
        store = self.ls_module.LeadStore()
        self.assertEqual(store.save_lead(self._lead()), "created")
        self.assertEqual(store.save_lead(self._lead()), "updated")
        # 未配置租户 → 完全 no-op，不产生任何邮箱记录
        self.assertEqual(self.naming.list_addresses(), [])

    def test_31_save_lead_never_raises_when_lazy_create_fails(self):
        os.environ["MIO_CDP_SUPPLIER_ID"] = "100000834234"
        store = self.ls_module.LeadStore()
        with mock.patch("builtins.print"):    # 接线失败只打日志，不改变返回值
            with mock.patch.object(provision, "try_ensure_mailbox",
                                   side_effect=RuntimeError("boom")):
                self.assertEqual(store.save_lead(self._lead()), "created")
            with mock.patch.object(provision, "try_ensure_mailbox",
                                   side_effect=RuntimeError("boom")):
                self.assertEqual(store.save_lead(self._lead(company_name="Other Co",
                                                            domain="other.com")), "created")

    def test_32_save_lead_lazily_creates_mailbox_when_tenant_configured(self):
        os.environ["MIO_CDP_SUPPLIER_ID"] = "100000834234"
        store = self.ls_module.LeadStore()
        self.assertEqual(store.save_lead(self._lead()), "created")
        rows = self.naming.list_addresses(enterprise_id="100000834234")
        self.assertEqual(len(rows), 1)
        accounts = self.store.list_accounts(enterprise_id="100000834234")
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["email_address"], rows[0]["email"])
        self.assertEqual(accounts[0]["owner_open_id"], "ou_lead_user")
        bindings = self.store.list_bindings()
        self.assertEqual([b["chat_id"] for b in bindings], ["ou_lead_user"])
        # 再落一次同租户线索不重复建
        self.assertEqual(store.save_lead(self._lead(company_name="Suntech Tools")), "updated")
        self.assertEqual(len(self.naming.list_addresses(enterprise_id="100000834234")), 1)

    def test_33_save_lead_ignores_non_notify_open_id(self):
        os.environ["MIO_CDP_SUPPLIER_ID"] = "100000834234"
        store = self.ls_module.LeadStore()
        self.assertEqual(store.save_lead(self._lead(user_open_id="weird-id")), "created")
        self.assertEqual(len(self.naming.list_addresses(enterprise_id="100000834234")), 1)
        self.assertEqual(self.store.list_bindings(), [])


# ── 7. CLI 入口（skill / 智能体可直调）──────────────────────
class CliTests(ProvisionTestCase):
    def _run(self, argv):
        from email_gateway.cli import main
        return main(["--data-dir", str(self.data_dir)] + argv)

    def test_34_cli_mailbox_ensure_and_status(self):
        with mock.patch("builtins.print") as printer:
            code = self._run(["mailbox-ensure", "--enterprise", "100000834234",
                              "--company-name", "Suntech Tools",
                              "--owner-open-id", "ou_owner",
                              "--notify-target", "ou_owner", "--activate"])
            self.assertEqual(code, 0)
            ensure_payload = json.loads(printer.call_args[0][0])
            self.assertTrue(ensure_payload["send_ready"])
            self.assertEqual(self._run(["mailbox-status", "--enterprise",
                                        "100000834234"]), 0)
            status_payload = json.loads(printer.call_args[0][0])
        self.assertTrue(status_payload["send_ready"])
        self.assertEqual(status_payload["email"], ensure_payload["email"])
        # --data-dir 必须贯穿到 provisioning：数据只落在临时目录
        self.assertTrue((self.data_dir / "email-facts" / "naming"
                         / "addresses.sqlite3").exists())

    def test_35_cli_send_gate_exit_codes(self):
        with mock.patch("builtins.print") as printer:
            self.assertEqual(self._run(["send-gate", "--enterprise", "100000834234",
                                        "--from-address", "person@company.com"]), 0)
            self.assertEqual(self._run(["mailbox-ensure", "--enterprise",
                                        "100000834234"]), 0)
            ensured = json.loads(printer.call_args[0][0])
            code = self._run(["send-gate", "--enterprise", "100000834234",
                              "--from-address", ensured["email"]])
        self.assertEqual(code, provision.EXIT_NOT_READY)

    def test_36_cli_mailbox_ensure_error_exit_code(self):
        with mock.patch("builtins.print") as printer:
            code = self._run(["mailbox-ensure", "--enterprise", "100000834234",
                              "--slug", "ab"])
        self.assertEqual(code, provision.EXIT_ERROR)
        payload = json.loads(printer.call_args[0][0])
        self.assertEqual(payload["code"], "invalid_slug")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
