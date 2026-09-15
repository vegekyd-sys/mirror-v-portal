#!/usr/bin/env python3
"""T8 — 发信刹车开关 + 阈值可见的自检测试（标准库 unittest，无 pytest / 无新依赖）。

覆盖：平台级总开关、单租户隔离开关（同租户多身份一起停、其他租户不受影响）、
状态持久化往返与删除语义、发信被拒的返回结构（无假成功）、开关读取失败不阻断、
阈值最小样本量门槛、投诉率/硬退信率告警（只告警不熔断、只读）、阈值可配置、CLI。

跑法（权威副本根目录）：
  cd <mio-api> && python3 -m unittest discover -s email_gateway/tests -t .
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

import dc_email_send  # noqa: E402
from email_gateway.send_control import (CODE_BLOCKED_PLATFORM, CODE_BLOCKED_TENANT,  # noqa: E402
                                        DEFAULT_THRESHOLDS, SendControlError,
                                        alerts_for_tenant, blocked_result, default_state,
                                        evaluate_alerts, format_alerts_line, load_state,
                                        normalize_tenant_id, save_state, set_platform_paused,
                                        set_tenant_paused, state_path, switch_overview,
                                        switch_status)

ENT = "152600996207"          # 纯数字 → canonical 原样返回，不受环境变量影响
OTHER_ENT = "999888777"
MANAGED = "v@mail.dealclaw.io"
SELF_OWNED = "me@gmail.com"


def _view(accepted, bounced=0, complained=0, enterprise_id=ENT, unavailable=False):
    """构造与 metrics_view 同形的 provider_health 片段（只取阈值判定需要的字段）。"""
    if unavailable:
        return {"enterprise_id": enterprise_id,
                "range": {"start": "", "end": ""},
                "provider_health": {"accepted": None, "bounced": None, "complained": None}}
    return {"enterprise_id": enterprise_id,
            "range": {"start": "", "end": ""},
            "provider_health": {"accepted": accepted, "bounced": bounced,
                                "complained": complained,
                                "bounce_rate": round(bounced / accepted, 4) if accepted else None,
                                "complaint_rate": round(complained / accepted, 4) if accepted else None}}


class SwitchStateTests(unittest.TestCase):
    """开关状态：默认、持久化往返、删除语义、归一。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_01_default_state_allows_everything(self):
        self.assertFalse(state_path(self.data_dir).exists())
        state = load_state(self.data_dir)
        self.assertFalse(state["platform"]["paused"])
        self.assertEqual(state["tenants"], {})
        self.assertEqual(state["thresholds"], DEFAULT_THRESHOLDS)
        status = switch_status(ENT, data_dir=self.data_dir)
        self.assertTrue(status["allowed"])
        self.assertEqual(status["code"], "")
        self.assertIsNone(blocked_result(ENT, data_dir=self.data_dir))

    def test_02_platform_pause_persists_and_resumes(self):
        set_platform_paused(True, reason="域被投诉", by="tianyi", data_dir=self.data_dir)
        self.assertTrue(state_path(self.data_dir).exists())
        reloaded = load_state(self.data_dir)
        self.assertTrue(reloaded["platform"]["paused"])
        self.assertEqual(reloaded["platform"]["reason"], "域被投诉")
        self.assertEqual(reloaded["platform"]["by"], "tianyi")
        self.assertTrue(reloaded["platform"]["at"])

        set_platform_paused(False, reason="已查清", by="tianyi", data_dir=self.data_dir)
        self.assertFalse(load_state(self.data_dir)["platform"]["paused"])
        self.assertTrue(switch_status(ENT, data_dir=self.data_dir)["allowed"])

    def test_03_tenant_pause_is_isolated_to_that_tenant(self):
        set_tenant_paused(ENT, True, reason="投诉率超线", by="cs", data_dir=self.data_dir)
        blocked = switch_status(ENT, data_dir=self.data_dir)
        self.assertTrue(blocked["tenant_paused"])
        self.assertFalse(blocked["platform_paused"])
        self.assertEqual(blocked["code"], CODE_BLOCKED_TENANT)
        # 其他租户不受影响
        other = switch_status(OTHER_ENT, data_dir=self.data_dir)
        self.assertTrue(other["allowed"])
        self.assertIsNone(blocked_result(OTHER_ENT, data_dir=self.data_dir))

    def test_04_tenant_resume_removes_entry(self):
        set_tenant_paused(ENT, True, data_dir=self.data_dir)
        set_tenant_paused(ENT, False, data_dir=self.data_dir)
        self.assertEqual(load_state(self.data_dir)["tenants"], {})
        self.assertTrue(switch_status(ENT, data_dir=self.data_dir)["allowed"])

    def test_05_platform_beats_tenant_and_tenant_id_is_normalized(self):
        set_tenant_paused(ENT, True, data_dir=self.data_dir)
        set_platform_paused(True, reason="全停", data_dir=self.data_dir)
        status = switch_status(ENT, data_dir=self.data_dir)
        self.assertEqual(status["code"], CODE_BLOCKED_PLATFORM)
        self.assertEqual(status["tenant_id"], normalize_tenant_id(ENT))

    def test_06_empty_enterprise_cannot_pause_tenant(self):
        with self.assertRaises(SendControlError):
            set_tenant_paused("", True, data_dir=self.data_dir)

    def test_07_corrupt_state_raises_for_direct_readers(self):
        path = state_path(self.data_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(SendControlError):
            load_state(self.data_dir)

    def test_08_saved_state_is_written_0600(self):
        save_state(default_state(), self.data_dir)
        self.assertEqual(oct(os.stat(state_path(self.data_dir)).st_mode & 0o777), "0o600")

    def test_09_overview_lists_paused_tenants_only(self):
        set_tenant_paused(ENT, True, reason="r", data_dir=self.data_dir)
        set_tenant_paused(OTHER_ENT, True, data_dir=self.data_dir)
        set_tenant_paused(OTHER_ENT, False, data_dir=self.data_dir)
        view = switch_overview(ENT, data_dir=self.data_dir)
        self.assertEqual(list(view["tenants_paused"].keys()), [ENT])
        self.assertEqual(view["tenants_paused_count"], 1)
        self.assertTrue(view["enterprise"]["tenant_paused"])


class BlockedResultTests(unittest.TestCase):
    """被拒返回结构：必须无假成功字段、带原因和可执行下一步。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_10_platform_block_shape(self):
        set_platform_paused(True, reason="域级风险", data_dir=self.data_dir)
        blocked = blocked_result(ENT, data_dir=self.data_dir)
        self.assertFalse(blocked["success"])
        self.assertFalse(blocked["sent"])
        self.assertEqual(blocked["count"], 0)
        self.assertEqual(blocked["code"], CODE_BLOCKED_PLATFORM)
        self.assertEqual(blocked["blockers"], [CODE_BLOCKED_PLATFORM])
        self.assertIn("域级风险", blocked["error"])
        self.assertIn("平台级发信总开关已关闭", blocked["error"])
        self.assertIn("--action resume", blocked["next_action"])
        self.assertNotIn("success", [k for k, v in blocked.items() if v is True])

    def test_11_tenant_block_shape_points_at_that_tenant(self):
        set_tenant_paused(ENT, True, reason="投诉率 3.3%", data_dir=self.data_dir)
        blocked = blocked_result(ENT, data_dir=self.data_dir)
        self.assertEqual(blocked["code"], CODE_BLOCKED_TENANT)
        self.assertEqual(blocked["reason"], "投诉率 3.3%")
        self.assertIn(f"--enterprise {ENT}", blocked["next_action"])

    def test_12_read_failure_does_not_block_but_shouts(self):
        path = state_path(self.data_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{broken", encoding="utf-8")
        err = io.StringIO()
        with redirect_stderr(err):
            blocked = blocked_result(ENT, data_dir=self.data_dir)
        self.assertIsNone(blocked)
        self.assertIn("不阻断", err.getvalue())


class SendPathTests(unittest.TestCase):
    """接线：dc_email_send 发信前检查（平台/租户，自有与托管邮箱都停）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = self._tmp.name
        self._env = patch.dict(os.environ, {"DC_DATA_DIR": self.data_dir})
        self._env.start()

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def test_13_platform_pause_blocks_managed_and_self_owned(self):
        set_platform_paused(True, reason="全停", data_dir=self.data_dir)
        for address in (MANAGED, SELF_OWNED):
            gate, blocked = dc_email_send._preflight_gate(ENT, address)
            self.assertIsNone(gate, address)
            self.assertIsNotNone(blocked, address)
            self.assertEqual(blocked["code"], CODE_BLOCKED_PLATFORM)
            self.assertFalse(blocked["success"])
            self.assertFalse(blocked["sent"])
            self.assertEqual(blocked["count"], 0)

    def test_14_tenant_pause_blocks_that_tenant_only(self):
        set_tenant_paused(ENT, True, reason="隔离", data_dir=self.data_dir)
        _, blocked = dc_email_send._preflight_gate(ENT, SELF_OWNED)
        self.assertEqual(blocked["code"], CODE_BLOCKED_TENANT)
        _, other = dc_email_send._preflight_gate(OTHER_ENT, SELF_OWNED)
        self.assertIsNone(other)

    def test_15_switch_is_judged_before_readiness_gate(self):
        """开关先于就绪闸门：即使就绪检查异常，返回的是开关原因，不是闸门异常。"""
        set_platform_paused(True, reason="先看开关", data_dir=self.data_dir)
        with patch("email_gateway.provision.check_send_ready", side_effect=RuntimeError("boom")):
            _, blocked = dc_email_send._preflight_gate(ENT, MANAGED)
        self.assertEqual(blocked["code"], CODE_BLOCKED_PLATFORM)

    def test_16_read_failure_allows_send_with_warning(self):
        """开关故障不得误伤全部发信：托管邮箱也不拒绝。"""
        path = state_path(self.data_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{broken", encoding="utf-8")
        err = io.StringIO()
        with redirect_stderr(err):
            _, blocked = dc_email_send._preflight_gate(ENT, MANAGED)
        self.assertIsNone(blocked)
        self.assertIn("不阻断", err.getvalue())

    def test_17_send_batch_refuses_and_never_calls_sender(self):
        set_platform_paused(True, reason="总开关关闭", data_dir=self.data_dir)
        with patch("dc_email_send.subprocess.run") as run:
            result = dc_email_send.send_batch(
                channel="GS", from_addr=MANAGED, to_list=["a@x.com"],
                subject="hi", enterprise=ENT)
        run.assert_not_called()
        self.assertFalse(result["success"])
        self.assertFalse(result["sent"])
        self.assertEqual(result["code"], CODE_BLOCKED_PLATFORM)
        self.assertEqual(result["count"], 0)

    def test_18_tenant_switch_does_not_touch_other_tenants_send(self):
        set_tenant_paused(ENT, True, data_dir=self.data_dir)
        with patch("dc_email_send.subprocess.run") as run:
            run.return_value = type("R", (), {"returncode": 0, "stdout": "{}", "stderr": ""})()
            result = dc_email_send.send_batch(
                channel="FD", from_addr=SELF_OWNED, to_list=["a@x.com"],
                subject="hi", enterprise=OTHER_ENT)
        self.assertTrue(result["success"])
        run.assert_called_once()


class ThresholdAlertTests(unittest.TestCase):
    """阈值可见：最小样本量门槛、投诉率/退信率、只告警不熔断、可配置。"""

    def test_20_no_alert_for_single_complaint_below_min_sample(self):
        """小样本脆弱：30 封里 1 个投诉 = 3.3%，但 accepted<20 时不算比率告警。"""
        out = evaluate_alerts(_view(accepted=19, complained=1, bounced=3))
        self.assertEqual(out["status"], "insufficient_sample")
        self.assertFalse(out["min_sample_met"])
        self.assertEqual(out["alerts"], [])
        self.assertIn("样本不足", out["reason"])
        self.assertEqual(out["accepted"], 19)

    def test_21_complaint_rate_alerts_at_min_sample(self):
        out = evaluate_alerts(_view(accepted=20, complained=1))
        self.assertEqual(out["status"], "alert")
        self.assertTrue(out["min_sample_met"])
        self.assertEqual(len(out["alerts"]), 1)
        alert = out["alerts"][0]
        self.assertEqual(alert["metric"], "complaint_rate")
        self.assertEqual(alert["value"], 0.05)
        self.assertEqual(alert["threshold"], 0.005)
        self.assertEqual(alert["level"], "alert")
        self.assertEqual(alert["sample"], 20)
        self.assertIn("5.00%", alert["message"])
        self.assertIn("--action pause", alert["next_action"])

    def test_22_bounce_rate_alerts_at_min_sample(self):
        out = evaluate_alerts(_view(accepted=30, bounced=3))
        self.assertEqual(out["status"], "alert")
        self.assertEqual([a["metric"] for a in out["alerts"]], ["bounce_rate"])
        self.assertEqual(out["alerts"][0]["value"], 0.1)

    def test_23_boundary_is_strictly_greater(self):
        # 20 封里 1 个退信 = 5%，不 > 5% → 不告警
        self.assertEqual(evaluate_alerts(_view(accepted=20, bounced=1))["status"], "ok")
        # 20 封里 1 个投诉 = 5%，> 0.5% → 告警
        self.assertEqual(evaluate_alerts(_view(accepted=20, complained=1))["status"], "alert")

    def test_24_healthy_sample_reports_ok(self):
        out = evaluate_alerts(_view(accepted=200, bounced=2, complained=0))
        self.assertEqual(out["status"], "ok")
        self.assertTrue(out["min_sample_met"])
        self.assertEqual(out["observed"], {"complaint_rate": 0.0, "bounce_rate": 0.01})

    def test_25_unavailable_source_does_not_alert_or_guess_zero(self):
        out = evaluate_alerts(_view(accepted=None, unavailable=True))
        self.assertEqual(out["status"], "unavailable")
        self.assertEqual(out["alerts"], [])
        self.assertIsNone(out["accepted"])

    def test_26_zero_accepted_is_insufficient_not_zerodivision(self):
        out = evaluate_alerts(_view(accepted=0), thresholds={"min_accepted": 0})
        self.assertEqual(out["status"], "insufficient_sample")

    def test_27_thresholds_overridable(self):
        out = evaluate_alerts(_view(accepted=20, complained=1),
                              thresholds={"complaint_rate": 0.9})
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["thresholds"]["complaint_rate"], 0.9)
        # 默认值不被就地污染
        self.assertEqual(DEFAULT_THRESHOLDS["complaint_rate"], 0.005)

    def test_28_double_threshold_hit_reports_both(self):
        out = evaluate_alerts(_view(accepted=25, bounced=2, complained=1))
        self.assertEqual(sorted(a["metric"] for a in out["alerts"]),
                         ["bounce_rate", "complaint_rate"])

    def test_29_layer_is_alert_only(self):
        out = evaluate_alerts(_view(accepted=20, complained=1))
        self.assertEqual(out["threshold_layer"], "alert_only_no_auto_cut")
        self.assertTrue(out["read_only"])

    def test_30_alerts_never_write_switch_state(self):
        """可见层只读：算完告警不得动开关状态（不自动熔断）。"""
        with tempfile.TemporaryDirectory() as tmp:
            set_tenant_paused(OTHER_ENT, True, reason="既有", data_dir=tmp)
            before = state_path(tmp).read_bytes()
            evaluate_alerts(_view(accepted=20, complained=1))
            self.assertEqual(state_path(tmp).read_bytes(), before)
            self.assertEqual(switch_status(ENT, data_dir=tmp)["allowed"], True)

    def test_31_state_file_thresholds_reach_alerts_for_tenant(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = default_state()
            state["thresholds"] = {"min_accepted": 0, "complaint_rate": 0.005,
                                   "bounce_rate": 0.05}
            save_state(state, tmp)
            self.assertEqual(load_state(tmp)["thresholds"]["min_accepted"], 0)
            out = alerts_for_tenant(ENT, data_dir=tmp)
            self.assertEqual(out["min_accepted"], 0)
            self.assertEqual(out["status"], "insufficient_sample")  # 空库 accepted=0

    def test_32_format_line(self):
        self.assertIn("无阈值告警", format_alerts_line(evaluate_alerts(_view(accepted=200))))
        self.assertIn("样本不足", format_alerts_line(evaluate_alerts(_view(accepted=2))))
        line = format_alerts_line(evaluate_alerts(_view(accepted=20, complained=1)))
        self.assertIn("命中 1 条阈值", line)
        self.assertIn("未自动停发", line)


class CliTests(unittest.TestCase):
    """CLI：查看状态 / 停·恢复平台 / 停·恢复租户 / 阈值告警。"""

    def _main(self, tmp, argv):
        from email_gateway.cli import main
        return main(["--data-dir", tmp] + argv)

    def _json(self, tmp, argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = self._main(tmp, argv)
        return code, json.loads(buf.getvalue())

    def test_40_cli_view_resume_pause_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out = self._json(tmp, ["send-switch-status"])
            self.assertEqual(code, 0)
            self.assertFalse(out["platform_paused"])
            self.assertEqual(out["tenants_paused_count"], 0)

            _, paused = self._json(tmp, ["send-switch-platform", "--action", "pause",
                                         "--reason", "域级风险", "--by", "tianyi"])
            self.assertTrue(paused["paused"])
            self.assertEqual(paused["platform"]["by"], "tianyi")

            _, seen = self._json(tmp, ["send-switch-status", "--enterprise", ENT])
            self.assertTrue(seen["platform_paused"])
            self.assertFalse(seen["enterprise"]["allowed"])

            _, resumed = self._json(tmp, ["send-switch-platform", "--action", "resume"])
            self.assertFalse(resumed["paused"])
            _, after = self._json(tmp, ["send-switch-status", "--enterprise", ENT])
            self.assertTrue(after["enterprise"]["allowed"])

    def test_41_cli_tenant_isolation(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, out = self._json(tmp, ["send-switch-tenant", "--enterprise", ENT,
                                      "--action", "pause", "--reason", "投诉率超线"])
            self.assertTrue(out["paused"])
            self.assertEqual(out["tenant_id"], normalize_tenant_id(ENT))
            _, view = self._json(tmp, ["send-switch-status", "--enterprise", OTHER_ENT])
            self.assertTrue(view["enterprise"]["allowed"])
            _, resumed = self._json(tmp, ["send-switch-tenant", "--enterprise", ENT,
                                          "--action", "resume"])
            self.assertFalse(resumed["paused"])

    def test_42_cli_alerts_line_and_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            buf = io.StringIO()
            with redirect_stdout(buf):
                self._main(tmp, ["send-alerts", "--enterprise", ENT])
            payload = json.loads(buf.getvalue())
            self.assertEqual(payload["status"], "insufficient_sample")
            self.assertEqual(payload["min_accepted"], 20)

            buf = io.StringIO()
            with redirect_stdout(buf):
                self._main(tmp, ["send-alerts", "--enterprise", ENT, "--line"])
            self.assertIn("样本不足", buf.getvalue())

    def test_43_cli_alerts_can_notify(self):
        with tempfile.TemporaryDirectory() as tmp:
            sent = {}

            def fake_push(target, text):
                sent.update({"target": target, "text": text})
                return {"ok": True}

            with patch("dc_send_receipt.push_receipt", fake_push), redirect_stdout(io.StringIO()):
                self._main(tmp, ["send-alerts", "--enterprise", ENT,
                                 "--line", "--notify-target", "oc_test"])
            self.assertEqual(sent["target"], "oc_test")
            self.assertIn("样本不足", sent["text"])

    def test_44_cli_switch_hides_nothing_when_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, out = self._json(tmp, ["send-switch-status"])
            self.assertEqual(out["thresholds"], DEFAULT_THRESHOLDS)
            self.assertTrue(out["state_file"].endswith("send-control/state.json"))


if __name__ == "__main__":
    unittest.main()
