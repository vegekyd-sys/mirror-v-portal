#!/usr/bin/env python3
"""test_email_metrics_d2.py — 阶段 D2：口径优先级 / 降级隐藏数字 + 结构化告警 / shadow 隔离

覆盖：
  ① `resolve_mode` 优先级 **COMPANY > TENANT > GLOBAL > legacy**
     （同一环境同时设置企业键与租户键时企业生效；非法值回退 legacy + 告警）
  ② 邮件 metrics 为 partial/unavailable → EmailProvider 与早晚报渲染**隐藏邮件数字**
     （不得显示 0，显示「邮件数据暂不可用（原因）」），其余可信板块照常展示；
     同时 context/plan 带结构化 `data_quality_alert`（**只产出对象，不发送任何消息**）
  ③ shadow 落盘隔离：`DC_DATA_DIR/email-metrics-shadow/<tenant>/<company>/<YYYY-MM-DD>.jsonl`
     每行至少含 mode / report_timezone / snapshot_hash / source watermark /
     legacy / v1 / delta / reasons；落盘失败不影响主流程输出
  ④ D5 验收口径（**仅口径声明，不改行为**）：
     - **未解释差异 = 0**；不要求新旧数字完全相同（差异只要能被 reasons 解释就算通过）
     - 第一周指标 = 已知异常发现率 / 问题可复现率 / 已确认代码 Bug 回归覆盖率；
       **不用「系统先发现 > 50%」**——该说法无法证伪，不作为验收标准

运行：
  cd work/mio-api && python3 -m unittest tests.test_email_metrics_d2 -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from email_metrics import config as cfg  # noqa: E402
from email_metrics.config import MODE_ENV  # noqa: E402
from email_metrics.service import (STATUS_OK, STATUS_PARTIAL, STATUS_UNAVAILABLE,  # noqa: E402
                                   build_data_quality_alert, format_metrics_line,
                                   metrics_hidden_hint, read_email_metrics, safe_path_segment,
                                   snapshot_hash, stream_watermark)

COMPANY = "152600996207"
TENANT = "meorient"
SHADOW_DIR_ENV = "DC_EMAIL_METRICS_SHADOW_DIR"
DATA_DIR_ENV = "DC_DATA_DIR"


# ── 夹具 ────────────────────────────────────────────────
def out_record(i, *, status="delivered", sent_at="2026-09-12T01:00:00+00:00",
               with_provider_id=True):
    rec = {
        "schema_version": 1, "record_type": "outbound", "account_id": "acc1",
        "company_id": COMPANY, "campaign_id": "cmp1",
        "recipients": [f"buyer{i}@x.com"], "provider_status": status,
        "status": "sent", "sent_at": sent_at, "created_at": sent_at,
        "touch_number": 0, "thread_id": f"thread{i}",
    }
    if with_provider_id:
        rec["resend_id"] = f"re_{i}"
        rec["smtp_message_id"] = f"<smtp{i}@x>"
    return rec


class FakeStore:
    def __init__(self, outbounds, inbounds=None):
        self._out = list(outbounds)
        self._in = list(inbounds or [])

    def list_outbound_records(self, company_id=None):
        return [r for r in self._out if not company_id or r.get("company_id") == company_id]

    def list_inbound_records(self, company_id=None):
        return [r for r in self._in if not company_id or r.get("company_id") == company_id]


class BoomStore:
    def list_outbound_records(self, company_id=None):
        raise OSError("email-facts 目录不可读")

    def list_inbound_records(self, company_id=None):
        raise OSError("email-facts 目录不可读")


def make_context(tenant=TENANT, company=COMPANY, date="2026-09-12"):
    from dc_daily_brief import BriefContext
    return BriefContext(
        tenant=tenant, company=company, report_type="morning", date=date,
        tz="Asia/Shanghai", as_of=f"{date}T08:00:00+08:00",
        window_start=f"{date}T00:00:00+08:00", window_end=f"{date}T23:59:59+08:00",
    )


class ModeEnvMixin:
    """按用例设置口径开关与 shadow 目录；tearDown 一律还原（默认 legacy）。"""

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in list(os.environ)
                       if k.startswith("DC_EMAIL_METRICS_MODE") or k in
                       ("DC_REPORT_TIMEZONE", SHADOW_DIR_ENV, DATA_DIR_ENV)}
        for k in list(os.environ):
            if k.startswith("DC_EMAIL_METRICS_MODE"):
                os.environ.pop(k, None)
        os.environ.pop(SHADOW_DIR_ENV, None)

    def tearDown(self):
        for k in list(os.environ):
            if k.startswith("DC_EMAIL_METRICS_MODE"):
                os.environ.pop(k, None)
        for k in (SHADOW_DIR_ENV, DATA_DIR_ENV):
            os.environ.pop(k, None)
        os.environ.update({k: v for k, v in self._saved.items() if v is not None})


# ── ① 口径优先级 COMPANY > TENANT > GLOBAL ──────────────
class TestModePriority(ModeEnvMixin, unittest.TestCase):
    def test_company_beats_tenant_when_both_set(self):
        """同一环境同时设置企业键与租户键 → 企业键生效（最具体者胜）。"""
        os.environ[f"{MODE_ENV}_{TENANT.upper()}"] = "v1"
        os.environ[f"{MODE_ENV}_{COMPANY}"] = "shadow"
        self.assertEqual(cfg.resolve_mode(tenant=TENANT, company_id=COMPANY), "shadow")
        d = cfg.describe(tenant=TENANT, company_id=COMPANY)
        self.assertEqual(d["decided_by"], f"{MODE_ENV}_{COMPANY}")
        self.assertEqual(d["candidates"],
                         [f"{MODE_ENV}_{COMPANY}", f"{MODE_ENV}_{TENANT.upper()}", MODE_ENV],
                         "候选键顺序 = COMPANY > TENANT > GLOBAL")

    def test_tenant_beats_global(self):
        os.environ[MODE_ENV] = "legacy"
        os.environ[f"{MODE_ENV}_{TENANT.upper()}"] = "v1"
        self.assertEqual(cfg.resolve_mode(tenant=TENANT), "v1")
        self.assertEqual(cfg.resolve_mode(tenant="other"), "legacy")

    def test_company_key_used_even_without_tenant(self):
        os.environ[f"{MODE_ENV}_{COMPANY}"] = "shadow"
        self.assertEqual(cfg.resolve_mode(company_id=COMPANY), "shadow")
        self.assertEqual(cfg.resolve_mode(), "legacy", "未传 company_id 时不受企业键影响")

    def test_global_then_legacy_default(self):
        os.environ[MODE_ENV] = "shadow"
        self.assertEqual(cfg.resolve_mode(tenant=TENANT, company_id=COMPANY), "shadow")
        os.environ.pop(MODE_ENV, None)
        self.assertEqual(cfg.resolve_mode(tenant=TENANT, company_id=COMPANY), "legacy",
                         "读不到任何开关 → legacy（线上行为不变）")

    def test_invalid_value_falls_back_legacy_with_warning(self):
        """非法值 → legacy + 告警；绝不抛异常、绝不静默换口径。"""
        os.environ[MODE_ENV] = "yolo"
        with self.assertLogs("email_metrics.config", level="WARNING") as log:
            self.assertEqual(cfg.resolve_mode(), "legacy")
        self.assertTrue(any("非法口径" in m for m in log.output), "非法值必须有告警")

    def test_invalid_company_value_falls_back_legacy_not_tenant(self):
        """企业键非法 → 回退 legacy（不是退到租户键）：失败模式只能是「不变」。"""
        os.environ[f"{MODE_ENV}_{TENANT.upper()}"] = "v1"
        os.environ[f"{MODE_ENV}_{COMPANY}"] = "nope"
        with self.assertLogs("email_metrics.config", level="WARNING"):
            self.assertEqual(cfg.resolve_mode(tenant=TENANT, company_id=COMPANY), "legacy")

    def test_service_uses_company_mode_in_read_path(self):
        """唯一读入口也按新优先级取口径（企业 shadow 覆盖租户 v1）。"""
        os.environ[f"{MODE_ENV}_{TENANT.upper()}"] = "v1"
        os.environ[f"{MODE_ENV}_{COMPANY}"] = "shadow"
        m = read_email_metrics(company_id=COMPANY, tenant=TENANT,
                               store=FakeStore([out_record(0)]))
        self.assertEqual(m["mode"], "shadow")
        self.assertEqual(m["metrics"]["sent"], 1, "shadow 用户可见 = 旧口径")


# ── ② 降级：隐藏邮件数字 + 结构化告警 ───────────────────
class TestDegradeHiddenNumbers(ModeEnvMixin, unittest.TestCase):
    def _partial_store(self):
        # 无 provider id 的旧记录 → legacy_unverified → partial（数字不可信）
        return FakeStore([out_record(0), out_record(1, with_provider_id=False)], [])

    def _result_detail(self, metrics):
        from dc_email_provider import EmailProvider
        res = EmailProvider(store=FakeStore([]), metrics=metrics).collect(make_context())
        return next(it for it in res.items if it.kind == "result")

    def test_partial_hides_numbers_in_email_provider(self):
        os.environ[MODE_ENV] = "v1"
        m = read_email_metrics(company_id=COMPANY, tenant=TENANT, store=self._partial_store())
        self.assertEqual(m["status"], STATUS_PARTIAL)
        item = self._result_detail(m)
        self.assertIn("邮件数据暂不可用", item.title)
        self.assertTrue(item.title.startswith("邮件数据暂不可用"),
                        "partial 必须隐藏数字、只给原因")
        self.assertIsNone(item.detail["sent"], "不得显示 0（也不得给数字）")
        self.assertIsNone(item.detail["replied"])
        self.assertTrue(item.detail["numbers_hidden"])

    def test_unavailable_hides_numbers_in_email_provider(self):
        os.environ[MODE_ENV] = "v1"
        m = read_email_metrics(company_id=COMPANY, tenant=TENANT, store=BoomStore())
        self.assertEqual(m["status"], STATUS_UNAVAILABLE)
        item = self._result_detail(m)
        self.assertIn("邮件数据暂不可用", item.title)
        self.assertIsNone(item.detail["sent"])
        self.assertTrue(item.detail["numbers_hidden"])

    def test_alert_object_shape_is_structured_and_never_sends(self):
        os.environ[MODE_ENV] = "v1"
        m = read_email_metrics(company_id=COMPANY, tenant=TENANT, store=self._partial_store())
        alert = m["data_quality_alert"]
        self.assertIsNotNone(alert, "partial 必须带结构化告警对象")
        self.assertEqual(alert["object"], "data_quality_alert")
        self.assertEqual(alert["scope"], "email_metrics")
        self.assertEqual(alert["status"], STATUS_PARTIAL)
        self.assertEqual(alert["reason_code"], "email_metrics_partial")
        self.assertEqual(alert["severity"], "warning")
        self.assertTrue(alert["numbers_hidden"])
        self.assertEqual(alert["hidden_fields"],
                         ["sent", "delivered", "bounced", "replied"])
        self.assertIn("邮件数据暂不可用", alert["message"])
        self.assertIn("legacy_unverified:1", alert["reasons"])
        self.assertFalse(alert["auto_send"], "只产出对象：不得自动发送任何消息")
        self.assertTrue(alert["read_only"])
        self.assertIn("opportunity", alert["unaffected"])
        self.assertIn("exhibition", alert["unaffected"])

    def test_unavailable_alert_is_error_severity(self):
        os.environ[MODE_ENV] = "v1"
        m = read_email_metrics(company_id=COMPANY, tenant=TENANT, store=BoomStore())
        alert = m["data_quality_alert"]
        self.assertEqual(alert["reason_code"], "email_metrics_unavailable")
        self.assertEqual(alert["severity"], "error")
        self.assertTrue(alert["drilldown"]["source_error"])

    def test_partial_hides_numbers_in_insight_too(self):
        """insight 也是渲染面：partial 时不得输出「今日 N 家回复」这类数字结论。"""
        os.environ[MODE_ENV] = "v1"
        m = read_email_metrics(company_id=COMPANY, tenant=TENANT, store=self._partial_store())
        from dc_email_provider import EmailProvider
        res = EmailProvider(store=FakeStore([]), metrics=m).collect(make_context())
        insight = next(it for it in res.items if it.kind == "insight")
        self.assertIn("邮件数据暂不可用", insight.title)
        self.assertNotIn("家回复", insight.title, "不得用不可信数字下结论")

    def test_ok_metrics_have_no_alert(self):
        os.environ[MODE_ENV] = "v1"
        m = read_email_metrics(company_id=COMPANY, tenant=TENANT,
                               store=FakeStore([out_record(0)]))
        self.assertEqual(m["status"], STATUS_OK)
        self.assertIsNone(m["data_quality_alert"], "数字可信时不告警（不制造噪音）")
        item = self._result_detail(m)
        self.assertEqual(item.detail["sent"], 1)
        self.assertFalse(item.detail["numbers_hidden"])

    def test_render_line_hides_partial_numbers(self):
        """partial 渲染不得出现任何邮件数字（此前会显示数字 + 「数据不完整」）。"""
        line = format_metrics_line({"status": STATUS_PARTIAL,
                                    "metrics": {"sent": 12, "delivered": 11,
                                                "bounced": 1, "replied": 3},
                                    "reasons": ["partial_sync"]})
        self.assertIn("邮件数据暂不可用", line)
        self.assertIn("partial_sync", line)
        for digit in ("12", "11", "3"):
            self.assertNotIn(digit, line, "partial 不得展示邮件数字")

    def test_render_line_hides_unavailable_numbers(self):
        line = format_metrics_line({"status": STATUS_UNAVAILABLE,
                                    "metrics": {"sent": None}, "reasons": []})
        self.assertIn("邮件数据暂不可用", line)

    def test_hidden_hint_carries_reason(self):
        self.assertIn("partial_sync", metrics_hidden_hint(["partial_sync"]))
        self.assertIn("暂不可用", metrics_hidden_hint([]))

    def test_daily_report_metrics_hide_and_carry_alert(self):
        """早晚报读入口（dc_daily_report.collect_metrics）同样隐藏数字并带告警。"""
        os.environ[MODE_ENV] = "v1"
        import dc_daily_report as dr
        m = dr.collect_metrics(COMPANY, date="2026-09-12", tz="Asia/Shanghai",
                               store=self._partial_store())
        self.assertEqual(m["status"], STATUS_PARTIAL)
        self.assertTrue(m["numbers_hidden"])
        self.assertIsNotNone(m["data_quality_alert"])
        line = dr._metrics_line(m, prefix="邮件：")
        self.assertIn("邮件数据暂不可用", line)
        self.assertNotIn("发送 1", line, "渲染行不得出现邮件数字")

    def test_plan_carries_alert_and_other_sections_unaffected(self):
        """plan 带告警对象；展会战报 / 今日会谈等非邮件板块逐字不变。"""
        os.environ[MODE_ENV] = "v1"
        from dc_daily_pipeline import run_morning_brief
        ctx = make_context()
        with tempfile.TemporaryDirectory() as good_dir, \
                tempfile.TemporaryDirectory() as bad_dir:
            good = run_morning_brief(ctx, Path(good_dir),
                                     email_store=FakeStore([out_record(0)]))
            bad = run_morning_brief(ctx, Path(bad_dir),
                                    email_store=self._partial_store())

        em = bad["plan"]["email_metrics"]
        self.assertEqual(em["status"], STATUS_PARTIAL)
        self.assertTrue(em["numbers_hidden"])
        self.assertIsNotNone(em["data_quality_alert"], "plan 必须带结构化告警对象")
        self.assertEqual(bad["plan"]["data_quality_alerts"][0]["object"], "data_quality_alert")
        self.assertFalse(bad["plan"]["data_quality_alerts"][0]["auto_send"])
        self.assertEqual(good["plan"]["data_quality_alerts"], [],
                         "数字可信时不产生告警")

        def non_email(plan):
            """非邮件板块条目（剔除每次运行都会变的时间戳字段）。"""
            volatile = {"created_at", "updated_at", "generated_at", "as_of", "ts", "due_at"}

            def strip(obj):
                if isinstance(obj, dict):
                    return {k: strip(v) for k, v in obj.items() if k not in volatile}
                if isinstance(obj, list):
                    return [strip(x) for x in obj]
                return obj

            return strip([it for it in plan["context"] if it.get("source") != "email"] +
                         [it for it in plan["actions"] if it.get("source") != "email"])

        self.assertEqual(non_email(bad["plan"]), non_email(good["plan"]),
                         "邮件降级不得影响展会战报 / 今日会谈等板块")
        self.assertTrue(non_email(bad["plan"]), "对照组非空，否则该断言无意义")


# ── ③ shadow 落盘隔离 ───────────────────────────────────
class TestShadowIsolation(ModeEnvMixin, unittest.TestCase):
    def _shadow_store(self):
        return FakeStore([out_record(0), out_record(1, with_provider_id=False)], [])

    def _run(self, *, tenant=TENANT, company=COMPANY):
        os.environ[MODE_ENV] = "shadow"
        return read_email_metrics(company_id=company, tenant=tenant,
                                 store=self._shadow_store(), consumer="d2-shadow")

    def _lines(self, root):
        files = sorted(Path(root).glob("**/*.jsonl"))
        self.assertEqual(len(files), 1, f"每天每租户/企业一份 JSONL: {files}")
        return files[0], [json.loads(x) for x in
                          files[0].read_text(encoding="utf-8").splitlines() if x.strip()]

    def test_path_isolated_by_tenant_and_company(self):
        with tempfile.TemporaryDirectory() as data_dir:
            os.environ[DATA_DIR_ENV] = data_dir
            m = self._run()
            self.assertTrue(m["shadow"]["recorded"])
            f, _ = self._lines(data_dir)
            self.assertEqual(f.relative_to(data_dir).parts[:2],
                             ("email-metrics-shadow", TENANT))
            self.assertEqual(f.relative_to(data_dir).parts[2:4], (COMPANY, f.name))
            self.assertRegex(f.name, r"^\d{4}-\d{2}-\d{2}\.jsonl$")
            self.assertEqual(str(f), m["shadow"]["path"])

    def test_tenant_isolation_between_companies(self):
        """不同企业不共文件（防串数据）。"""
        with tempfile.TemporaryDirectory() as data_dir:
            os.environ[DATA_DIR_ENV] = data_dir
            self._run()
            self._run(company="100000834234")
            files = sorted(Path(data_dir).glob("**/*.jsonl"))
            self.assertEqual(len(files), 2)
            self.assertEqual({f.parent.name for f in files}, {COMPANY, "100000834234"})

    def test_missing_tenant_company_uses_stable_placeholder(self):
        with tempfile.TemporaryDirectory() as data_dir:
            os.environ[DATA_DIR_ENV] = data_dir
            os.environ[MODE_ENV] = "shadow"
            m = read_email_metrics(company_id="", tenant=None,
                                   outbound_records=[out_record(0)], inbound_records=[])
            self.assertTrue(m["shadow"]["recorded"])
            rel = Path(m["shadow"]["path"]).relative_to(data_dir)
            self.assertEqual(rel.parts[1:3], ("_global", "_global"),
                             "缺失 tenant/company 用稳定占位，不留空目录段")

    def test_illegal_chars_never_reach_filename(self):
        self.assertEqual(safe_path_segment("a/b c"), "a_b_c")
        self.assertEqual(safe_path_segment("../../etc"), "etc")
        self.assertEqual(safe_path_segment("租户"), "_global", "全非法 → 稳定占位而不是空段")
        self.assertEqual(safe_path_segment(None), "_global")
        self.assertRegex(safe_path_segment("租户A"), r"^[A-Za-z0-9._-]+$",
                         "非法字符不得进入路径段")

    def test_each_line_has_required_fields(self):
        with tempfile.TemporaryDirectory() as data_dir:
            os.environ[DATA_DIR_ENV] = data_dir
            self._run()
            _, lines = self._lines(data_dir)
            payload = lines[-1]
            self.assertEqual(payload["mode"], "shadow")
            self.assertEqual(payload["report_timezone"], "Asia/Shanghai")
            self.assertTrue(payload["snapshot_hash"].startswith("sha256:"))
            wm = payload["watermark"]
            self.assertEqual(wm["outbound"]["count"], 2)
            self.assertEqual(wm["outbound"]["max_event_time"], "2026-09-12T01:00:00+00:00")
            self.assertEqual(wm["inbound"]["count"], 0)
            self.assertEqual(wm["inbound"]["max_event_time"], "")
            self.assertEqual(payload["legacy"]["sent"], 2)
            self.assertEqual(payload["v1"]["sent"], 1)
            diff = {d["metric"]: d for d in payload["diff"]}
            self.assertEqual(diff["sent"]["delta"], -1)
            self.assertTrue(diff["sent"]["reason"], "delta 必须带 reason")
            self.assertIn("legacy_unverified:1", payload["reasons"])
            self.assertEqual(payload["v1_reasons"], payload["reasons"])
            self.assertEqual(payload["tenant"], TENANT)

    def test_snapshot_hash_stable_and_input_sensitive(self):
        h1 = snapshot_hash(company_id=COMPANY, outbound_records=[out_record(0)],
                           inbound_records=[])
        h2 = snapshot_hash(company_id=COMPANY, outbound_records=[out_record(0)],
                           inbound_records=[])
        h3 = snapshot_hash(company_id=COMPANY, outbound_records=[out_record(1)],
                           inbound_records=[])
        self.assertEqual(h1, h2, "同一快照 → 同一 hash")
        self.assertNotEqual(h1, h3, "输入变了 → hash 必须变")
        # 读表顺序不影响 hash（快照集合等价）
        a = snapshot_hash(company_id=COMPANY,
                          outbound_records=[out_record(0), out_record(1)], inbound_records=[])
        b = snapshot_hash(company_id=COMPANY,
                          outbound_records=[out_record(1), out_record(0)], inbound_records=[])
        self.assertEqual(a, b)

    def test_watermark_reports_counts_and_max_time(self):
        wm = stream_watermark([out_record(0, sent_at="2026-09-10T01:00:00+00:00"),
                              out_record(1, sent_at="2026-09-12T05:00:00+00:00"),
                              {"company_id": COMPANY}])
        self.assertEqual(wm["count"], 3)
        self.assertEqual(wm["max_event_time"], "2026-09-12T05:00:00+00:00")
        self.assertEqual(wm["without_time"], 1)
        self.assertEqual(stream_watermark([]), {"count": 0, "max_event_time": "",
                                                "without_time": 0})

    def test_write_failure_does_not_affect_output(self):
        """落盘失败（目录不可写）→ 主流程输出照旧，只在 shadow 字段里报错。"""
        with tempfile.TemporaryDirectory() as tmp:
            blocker = Path(tmp) / "email-metrics-shadow"
            blocker.write_text("not a directory", encoding="utf-8")
            os.environ[DATA_DIR_ENV] = tmp
            m = self._run()
        self.assertFalse(m["shadow"]["recorded"])
        self.assertIn("error", m["shadow"])
        self.assertEqual(m["status"], STATUS_OK, "shadow 落盘失败不得改变用户可见输出")
        self.assertEqual(m["metrics"]["sent"], 2)
        self.assertIsNotNone(m["v1"])

    def test_shadow_dir_env_override_still_scoped(self):
        with tempfile.TemporaryDirectory() as root:
            os.environ[SHADOW_DIR_ENV] = root
            m = self._run()
            rel = Path(m["shadow"]["path"]).relative_to(root)
            self.assertEqual(rel.parts[:2], (TENANT, COMPANY))

    def test_alert_is_none_in_shadow_when_visible_metrics_ok(self):
        """shadow 用户可见 = 旧口径；可见数字可信时不告警（v1 完整度只进 shadow 记录）。"""
        with tempfile.TemporaryDirectory() as data_dir:
            os.environ[DATA_DIR_ENV] = data_dir
            m = self._run()
        self.assertEqual(m["status"], STATUS_OK)
        self.assertIsNone(m["data_quality_alert"])
        self.assertEqual(m["v1_status"], STATUS_PARTIAL, "v1 完整度仍被记录")

    def test_build_alert_helper_returns_none_for_ok(self):
        self.assertIsNone(build_data_quality_alert({"status": STATUS_OK, "metrics": {}}))
        self.assertIsNotNone(build_data_quality_alert(
            {"status": STATUS_UNAVAILABLE, "metrics": {}, "reasons": ["boom"]}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
