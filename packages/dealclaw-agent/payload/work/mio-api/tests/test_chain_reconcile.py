#!/usr/bin/env python3
"""test_chain_reconcile.py — 触达 → Memory interaction → 飞书沟通明细 只读对账

覆盖 D2 ③：
  - 三层缺失清单：有触达无 interaction / 有 interaction 未进飞书明细
  - 反向孤儿：有 interaction 无触达 / 飞书明细有行但无 interaction
  - 每条给可下钻 id（脱敏：HMAC 假名，不含邮箱/正文/公司名明文）
  - **只读**：不写任何存储、不调飞书写接口（本套件把 subprocess 打死为断言）
  - 飞书层拿不到数据 → 明确「无法判定」，绝不假绿

运行：cd work/mio-api && python3 -m unittest tests.test_chain_reconcile -v
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dc_chain_reconcile as cr  # noqa: E402

COMPANY = "152600996207"


def followup_row(*, company="Acme Corp", cdp="cdp_1", website="acme.com", emails=None):
    return {
        "company": company, "company_cdp_id": cdp, "website": website,
        "country": "US", "buyer_type": "经销商",
        "contact": "Maria｜采购", "contact_names": ["Maria"],
        "stage": "已回复", "touch_number": 2, "outbound_count": 2, "inbound_count": 1,
        "latest_at": "2026-09-02T10:00:00+00:00",
        "emails": emails if emails is not None else [
            {"direction": "out", "round": 0, "subject": "hi", "content": "first touch",
             "sent_at": "2026-09-01T10:00:00+00:00", "status": "delivered",
             "source_system": "email", "source_record_id": "smtp_1", "thread_id": "th_1"},
        ],
    }


def interaction(*, iid="it_a", ss="email", srid="smtp_1", cust="cdp_1",
                occurred="2026-09-01T10:00:00+00:00", direction="outbound", **extra):
    it = {
        "interaction_id": iid, "customer_id": cust, "customer_display": "Acme Corp",
        "opportunity_id": "", "exhibition_id": "", "channel": "email",
        "direction": direction, "occurred_at": occurred, "subject": "hi",
        "summary": "first touch", "raw_record_ref": srid, "artifacts": [],
        "status": "delivered", "has_reply": False, "thread_id": "th_1",
        "source_system": ss, "source_record_id": srid,
    }
    it.update(extra)
    return it


def feishu_row(**overrides):
    row = {"互动ID": "it_a", "来源系统": "email", "来源记录ID": "smtp_1",
           "客户ID": "cdp_1", "时间": "2026-09-01 10:00:00", "渠道": "email",
           "方向": "outbound", "主题": "hi"}
    row.update(overrides)
    return row


class ChainReconcileTestCase(unittest.TestCase):
    def setUp(self):
        # 只读保证：任何真实子进程（lark-cli / curl / kubectl）都是 bug
        self._sub = mock.patch.object(subprocess, "run",
                                      side_effect=AssertionError("只读对账禁止起子进程"))
        self._sub.start()
        self.addCleanup(self._sub.stop)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def report(self, **kwargs):
        kwargs.setdefault("company_id", COMPANY)
        return cr.reconcile_chain(**kwargs)


# ── 明细级对账 ──────────────────────────────────────────
class TestMissingLists(ChainReconcileTestCase):
    def test_all_layers_consistent_reports_zero(self):
        r = self.report(touches=[followup_row()],
                        interactions=[interaction()],
                        feishu_rows=[feishu_row()])
        s = r["summary"]
        self.assertEqual(s["missing_total"], 0)
        self.assertEqual(s["orphan_total"], 0)
        self.assertEqual(s["unexplained_total"], 0)
        self.assertEqual(r["exit_code"], 0)
        self.assertTrue(r["read_only"])
        self.assertFalse(r["sends_messages"])
        self.assertFalse(r["calls_feishu_api"])

    def test_touch_without_interaction(self):
        """有触达但没展平成 interaction（运营看到的沟通记录会少一条）。"""
        r = self.report(touches=[followup_row()], interactions=[], feishu_rows=[])
        missing = r["missing"]["touch_without_interaction"]
        self.assertEqual(missing["count"], 1)
        self.assertEqual(missing["items"][0]["layer"], "touch")
        self.assertIn("未展平", missing["items"][0]["note"])
        self.assertEqual(r["exit_code"], 1)

    def test_interaction_without_feishu_row(self):
        """有 interaction 但没进飞书沟通明细（子表未同步/被清表）。"""
        r = self.report(touches=[followup_row()], interactions=[interaction()],
                        feishu_rows=[])
        missing = r["missing"]["interaction_without_feishu"]
        self.assertEqual(missing["count"], 1)
        self.assertEqual(missing["items"][0]["layer"], "interaction")

    def test_orphan_interaction_without_touch(self):
        """反向孤儿：有 interaction 却没有对应触达（非邮件来源或触达源被裁剪）。"""
        r = self.report(touches=[], interactions=[
            interaction(iid="it_meet", ss="meeting", srid="mtg_1", cust="cdp_9")],
            feishu_rows=[feishu_row(互动ID="it_meet", 来源系统="meeting",
                                    来源记录ID="mtg_1", 客户ID="cdp_9")])
        orphans = r["orphans"]["interaction_without_touch"]
        self.assertEqual(orphans["count"], 1)
        self.assertIn("无对应触达", orphans["items"][0]["note"])
        self.assertEqual(r["summary"]["missing_total"], 0)
        self.assertEqual(r["exit_code"], 1, "孤儿项同样不可放过")

    def test_orphan_feishu_row_without_interaction(self):
        """反向孤儿：飞书明细有行但 Memory 没有对应 interaction。"""
        r = self.report(touches=[followup_row()], interactions=[interaction()],
                        feishu_rows=[feishu_row(), feishu_row(互动ID="it_ghost",
                                                             来源记录ID="smtp_ghost")])
        orphans = r["orphans"]["feishu_without_interaction"]
        self.assertEqual(orphans["count"], 1)
        self.assertEqual(orphans["items"][0]["layer"], "feishu")

    def test_multiple_missing_in_one_run(self):
        rows = [followup_row(emails=[
            {"direction": "out", "subject": "a", "sent_at": "2026-09-01T10:00:00+00:00",
             "status": "delivered", "source_system": "email", "source_record_id": "smtp_1"},
            {"direction": "out", "subject": "b", "sent_at": "2026-09-02T10:00:00+00:00",
             "status": "delivered", "source_system": "email", "source_record_id": "smtp_2"},
        ])]
        r = self.report(touches=rows,
                        interactions=[interaction()],          # 只有 smtp_1 展平
                        feishu_rows=[feishu_row()])
        self.assertEqual(r["summary"]["touch_without_interaction"], 1)
        self.assertEqual(r["summary"]["missing_total"], 1)

    def test_matching_falls_back_to_customer_and_time(self):
        """来源键缺失时按「同客户 + 同时间」兜底，避免键缺失造成假阳性。"""
        t = followup_row(emails=[{"direction": "out", "subject": "a",
                                  "sent_at": "2026-09-01T10:00:00+00:00",
                                  "status": "delivered", "source_system": "",
                                  "source_record_id": ""}])
        r = self.report(touches=[t],
                        interactions=[interaction(ss="", srid="")],
                        feishu_rows=[])
        self.assertEqual(r["summary"]["touch_without_interaction"], 0)


# ── 脱敏 ────────────────────────────────────────────────
class TestMasking(ChainReconcileTestCase):
    def test_drilldown_ids_are_masked_not_raw(self):
        r = self.report(touches=[followup_row(company="Secret Buyer Ltd")],
                        interactions=[], feishu_rows=[])
        item = r["missing"]["touch_without_interaction"]["items"][0]
        blob = json.dumps(item, ensure_ascii=False)
        self.assertNotIn("Secret Buyer Ltd", blob, "公司名明文不得出现在对账输出")
        self.assertNotIn("smtp_1", blob, "来源记录 id 必须脱敏")
        self.assertNotIn("cdp_1", blob, "客户 id 必须脱敏")
        self.assertIn("drilldown", item)
        self.assertTrue(item["drilldown"], "必须给出可下钻（脱敏）id")

    def test_masked_id_is_stable(self):
        a = self.report(touches=[followup_row()], interactions=[], feishu_rows=[])
        b = self.report(touches=[followup_row()], interactions=[], feishu_rows=[])
        self.assertEqual(
            a["missing"]["touch_without_interaction"]["items"][0]["drilldown"],
            b["missing"]["touch_without_interaction"]["items"][0]["drilldown"],
            "同一条缺失两次运行必须给出同一假名（可对齐）")

    def test_summary_has_no_body_or_email(self):
        r = self.report(touches=[followup_row()], interactions=[], feishu_rows=[])
        blob = json.dumps(r["summary"], ensure_ascii=False)
        self.assertNotIn("first touch", blob, "正文不得进对账输出")
        self.assertNotIn("@", blob, "邮箱不得进对账输出")


# ── 只读 + 离线 ─────────────────────────────────────────
class TestReadOnly(ChainReconcileTestCase):
    def test_memory_files_are_read_only_never_created(self):
        """读 memory 目录不得 mkdir / 不得落文件。"""
        r = self.report(memory_dir=self._tmp.name, touches=None, interactions=None,
                        feishu_rows=[])
        root = Path(self._tmp.name) / COMPANY
        self.assertFalse(root.exists(), "只读对账不得创建目录")
        self.assertEqual(r["layers"]["touch"]["status"], "missing_file")
        self.assertEqual(r["layers"]["interaction"]["status"], "missing_file")

    def test_reads_real_memory_layout_when_present(self):
        root = Path(self._tmp.name) / COMPANY
        root.mkdir(parents=True)
        (root / "email_followup.json").write_text(
            json.dumps([followup_row()], ensure_ascii=False), encoding="utf-8")
        (root / "interactions.json").write_text(
            json.dumps([interaction()], ensure_ascii=False), encoding="utf-8")
        (root / "feishu_interactions_snapshot.json").write_text(
            json.dumps([feishu_row()], ensure_ascii=False), encoding="utf-8")
        r = self.report(memory_dir=self._tmp.name)
        self.assertEqual(r["layers"]["touch"]["status"], "ok")
        self.assertEqual(r["summary"]["unexplained_total"], 0)

    def test_feishu_layer_unavailable_is_not_green(self):
        """飞书层拿不到数据 → 明确无法判定，不产生假绿。"""
        r = self.report(touches=[followup_row()], interactions=[interaction()],
                        feishu_rows=None)
        self.assertEqual(r["layers"]["feishu"]["status"], "unavailable")
        self.assertFalse(r["summary"]["feishu_layer_judged"])
        self.assertEqual(r["missing"]["interaction_without_feishu"]["count"], 0)
        self.assertEqual(r["exit_code"], 2, "无法判定必须区别于「通过」")
        self.assertIn("无法判定", cr.render_text(r))

    def test_feishu_snapshot_writer_shape_is_supported(self):
        """兼容 `_build_interaction_rows` 的落盘形态 {fields, rows}。"""
        payload = {"fields": ["互动ID", "来源系统", "来源记录ID", "客户ID", "时间"],
                   "rows": [["it_a", "email", "smtp_1", "cdp_1", "2026-09-01 10:00:00"]]}
        r = self.report(touches=[followup_row()], interactions=[interaction()],
                        feishu_rows=payload)
        self.assertEqual(r["summary"]["interaction_without_feishu"], 0)
        self.assertEqual(r["summary"]["unexplained_total"], 0)


# ── 渲染与 CLI ──────────────────────────────────────────
class TestRenderAndCli(ChainReconcileTestCase):
    def test_render_text_lists_both_missing_groups(self):
        r = self.report(touches=[followup_row()], interactions=[], feishu_rows=[])
        text = cr.render_text(r)
        self.assertIn("有触达但没有 interaction：1 条", text)
        self.assertIn("有 interaction 但没有进飞书明细", text)
        self.assertIn("未解释差异", text)
        self.assertIn("read_only=True", text.replace(" ", ""))

    def test_cli_json_output_with_fixtures(self):
        touch_file = Path(self._tmp.name) / "touch.json"
        inter_file = Path(self._tmp.name) / "inter.json"
        feishu_file = Path(self._tmp.name) / "feishu.json"
        touch_file.write_text(json.dumps([followup_row()]), encoding="utf-8")
        inter_file.write_text(json.dumps([interaction()]), encoding="utf-8")
        feishu_file.write_text(json.dumps([feishu_row()]), encoding="utf-8")
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = cr.main([COMPANY, "--json", "--touch-json", str(touch_file),
                          "--interaction-json", str(inter_file),
                          "--feishu-json", str(feishu_file)])
        self.assertEqual(rc, 0)
        out = json.loads(buf.getvalue())
        self.assertEqual(out["summary"]["unexplained_total"], 0)
        self.assertEqual(out["layers"]["feishu"]["status"], "ok")

    def test_cli_exit_code_nonzero_when_missing(self):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = cr.main([COMPANY, "--touch-json",
                          str(self._write("t.json", [followup_row()])),
                          "--interaction-json", str(self._write("i.json", [])),
                          "--feishu-json", str(self._write("f.json", []))])
        self.assertEqual(rc, 1)

    def _write(self, name, data):
        path = Path(self._tmp.name) / name
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path


if __name__ == "__main__":
    unittest.main(verbosity=2)
