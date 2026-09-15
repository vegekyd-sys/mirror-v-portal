"""account-check 的 provider-aware 自检测试（2026-09-15 田耕郡报）。

背景：`resend` 代理邮箱没有 IMAP/SMTP（收发都走 HTTP API），旧实现按 IMAP/SMTP 去验
→ 必然返回红（IMAP ConnectionRefused / SMTP SMTPServerDisconnected），用户看到的是**假红**。

新口径：
  · provider 无 IMAP（或 recommended_auth == "api_key"）→ 走 HTTP API key 探活
    - 200 = 正常；403 = key 有效但权限受限（仍是有效凭证）；401 = 凭证无效
    - 结果里 imap/smtp 标 ``skipped``，不再是「失败」误导用户
  · 其余 provider 保持原 IMAP/SMTP 逻辑，行为不变

跑法：
  python3 -m unittest discover -s email_gateway/tests -t . -p "test_account_check_api_provider.py"
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
from email_gateway.verify import AccountVerifier  # noqa: E402

ENT = "test-tuozhu"
OWNER = "ou_owner"
PROXY = "bambu-lab@mail.dealclaw.io"


class _FakeImap:
    """够用的 IMAP 假件：login/select/logout 都成功，其余方法一律返回 OK。"""

    def __init__(self, *a, **kw):
        self._selected = None

    def login(self, user, password):
        return ("OK", [b""])

    def select(self, mailbox, readonly=False):
        self._selected = mailbox
        return ("OK", [b"1"])

    def logout(self):
        return ("BYE", [b""])

    def __getattr__(self, name):  # id() 等兼容调用
        def _ok(*a, **kw):
            return ("OK", [b""])

        return _ok


class _FakeSmtp:
    def __init__(self, *a, **kw):
        pass

    def login(self, user, password):
        return (235, b"")

    def noop(self):
        return (250, b"")

    def starttls(self, **kw):
        return (220, b"")

    def quit(self):
        return (221, b"")


class _Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self._env = mock.patch.dict(os.environ, {"DC_DATA_DIR": str(self.data_dir)})
        self._env.start()
        self.store = EmailStore(self.data_dir)

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def add_account(self, *, email=PROXY, provider="resend", mailbox_kind="dealclaw_proxy",
                    auth_type="api_key", secret_ref="env:RESEND_API_KEY"):
        return self.store.add_account(
            enterprise_id=ENT, owner_open_id=OWNER, email_address=email,
            provider=provider, mailbox_kind=mailbox_kind, auth_type=auth_type,
            secret_ref=secret_ref,
        )


class ResendUsesApiProbe(_Base):
    def _verify(self, status, detail=""):
        calls = []

        def prober(secret):
            calls.append(secret)
            return status, detail

        acc = self.add_account()
        v = AccountVerifier(self.store, secret_resolver=lambda ref: "re_test_key",
                            api_prober=prober)
        return v.verify(acc["account_id"]), calls

    def test_200_is_ok_and_skips_imap_smtp(self):
        result, calls = self._verify(200)
        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "api")
        self.assertTrue(result["api"]["ok"])
        self.assertEqual(result["api"]["status"], 200)
        self.assertEqual(result["imap"], {"ok": False, "skipped": True,
                                          "reason": "provider has no IMAP"})
        self.assertTrue(result["smtp"]["skipped"])
        self.assertEqual(calls, ["re_test_key"], "探活必须拿到解析后的密钥")

    def test_403_is_valid_but_restricted_key(self):
        result, _ = self._verify(403, "restricted key")
        self.assertTrue(result["ok"], "403 = 凭证有效但权限受限，不应判失败")
        self.assertEqual(result["api"]["status"], 403)

    def test_401_is_invalid_key(self):
        result, _ = self._verify(401, "invalid api key")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "invalid API key")

    def test_network_failure_is_not_a_crash(self):
        result, _ = self._verify(0, "NewConnectionError")
        self.assertFalse(result["ok"])
        self.assertIn("status=0", result["error"])

    def test_send_only_key_still_reports_a_real_failure_reason(self):
        result, _ = self._verify(500, "server error")
        self.assertFalse(result["ok"])
        self.assertIn("500", result["error"])


class SmtpProvidersKeepOldPath(_Base):
    def test_non_api_provider_uses_imap_smtp_and_never_calls_api(self):
        acc = self.add_account(email="me@company.com", provider="tencent_exmail",
                               mailbox_kind="enterprise_user", auth_type="app_password",
                               secret_ref="env:MAIL_PW")
        calls = []

        def prober(secret):
            calls.append(secret)
            return 200, ""

        v = AccountVerifier(
            self.store,
            imap_factory=_FakeImap,
            smtp_ssl_factory=_FakeSmtp,
            secret_resolver=lambda ref: "pw",
            api_prober=prober,
        )
        result = v.verify(acc["account_id"])
        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "imap_smtp")
        self.assertTrue(result["imap"]["ok"])
        self.assertTrue(result["smtp"]["ok"])
        self.assertNotIn("api", result)
        self.assertEqual(calls, [], "IMAP/SMTP 类账号不得走 API 探活")

    def test_imap_failure_still_fails(self):
        acc = self.add_account(email="me@company.com", provider="tencent_exmail",
                               mailbox_kind="enterprise_user", auth_type="app_password",
                               secret_ref="env:MAIL_PW")

        class _Broken(_FakeImap):
            def login(self, user, password):
                raise ConnectionRefusedError("nope")

        v = AccountVerifier(self.store, imap_factory=_Broken, smtp_ssl_factory=_FakeSmtp,
                            secret_resolver=lambda ref: "pw")
        result = v.verify(acc["account_id"])
        self.assertFalse(result["ok"])
        self.assertFalse(result["imap"]["ok"])


if __name__ == "__main__":
    unittest.main()
