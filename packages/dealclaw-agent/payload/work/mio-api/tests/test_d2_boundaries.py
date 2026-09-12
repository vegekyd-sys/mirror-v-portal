#!/usr/bin/env python3
"""test_d2_boundaries.py — D2 验收边界（田耕郡 18:16 追加）

覆盖两块之前没有测试保证的边界：

A. 线索池联系人合并（`sync_contacts_to_pool`）
   - 线索池以**公司**为幂等主体，同一公司多个联系人必须**合并保留**；
   - 公司级去重不得覆盖已有联系人；
   - 已有联系人已覆盖本次输入 → 不做无意义写入；
   - 同批多个更新不互相覆盖（后写覆盖前写的旧值）。

B. 链路对账的 7 类差异归类（`dc_chain_reconcile`）
   - 归类只允许 7 类，不自创；
   - `等待同步` 必须结合 source_watermark/as_of：水位未到 → 等待同步，不算丢失；
   - `重复记录` 抓「同一来源记录被展平多次」，但**多对一（多条原始记录 → 一个 interaction）允许**；
   - `未归属`：既无 customer_id 也无来源定位键；
   - `按规则有意排除`：只认显式规则，没给规则不猜；
   - `未解释差异 = 0` 才是通过（等待同步/有意排除不计入未解释）。

全部离线：不调飞书、不写远端、不写任何存储（mock / 注入数据）。

运行：cd work/mio-api && python3 -m unittest tests.test_d2_boundaries -v
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dc_chain_reconcile as chain  # noqa: E402
import dc_company_registry as dcr  # noqa: E402


# ── A. 联系人合并 ───────────────────────────────────────

def _fake_lark(existing_contact: str = "", record_id: str = "rec1"):
    """内存假 lark-cli：只读 record-list + record-upsert，绝不触网。"""
    calls: list[list[str]] = []

    def fn(*args, **kwargs):
        a = [str(x) for x in args]
        calls.append(a)
        if "+record-list" in a:
            wanted = [a[i + 1] for i, x in enumerate(a) if x == "--field-id"]
            if dcr.CONTACT_FIELD in wanted:
                return {"ok": True, "data": {"record_id_list": [record_id],
                                             "fields": [dcr.CONTACT_FIELD],
                                             "data": [[existing_contact]]}}
            return {"ok": True, "data": {
                "record_id_list": [record_id],
                "fields": ["公司名", "官网", "公司CDPID"],
                "data": [["Co", "co.example", "C1"]]}}
        if "+record-upsert" in a:
            return {"ok": True, "data": {"record_id": record_id}}
        raise RuntimeError(f"假 lark-cli 不认识的命令: {a}")

    return fn, calls


class ContactMergeTestCase(unittest.TestCase):
    def _sync(self, existing_contact, updates):
        fn, calls = _fake_lark(existing_contact)
        pool = {"app_token": "app", "table_id": "tbl", "bitable_url": ""}
        with mock.patch.object(dcr, "_run_lark", side_effect=fn), \
                mock.patch.object(dcr, "ensure_company_lead_pool", lambda *a, **k: pool):
            result = dcr.sync_contacts_to_pool("C1", "Co", updates)
        upserts = [c for c in calls if "+record-upsert" in c]
        payloads = [json.loads(c[c.index("--json") + 1]) for c in upserts]
        return result, payloads

    def test_merge_preserves_existing_contact(self):
        """公司级去重不得覆盖已落库的联系人。"""
        res, payloads = self._sync("Alice|a@x.com|", [
            {"companyCdpId": "C1", "contact_text": "Bob|b@x.com|"}])
        self.assertEqual(res["updated"], 1)
        self.assertEqual(payloads[0][dcr.CONTACT_FIELD],
                         "Alice|a@x.com|；Bob|b@x.com|")

    def test_identical_contact_skips_write(self):
        """已有联系人已覆盖本次输入 → 不写。"""
        res, payloads = self._sync("Alice|a@x.com|", [
            {"companyCdpId": "C1", "contact_text": "Alice|a@x.com|"}])
        self.assertEqual(res["updated"], 0)
        self.assertEqual(res["skipped"], 1)
        self.assertEqual(payloads, [])

    def test_same_batch_updates_do_not_clobber(self):
        """同批两条不同联系人 → 第二条不能把第一条顶掉。"""
        res, payloads = self._sync("", [
            {"companyCdpId": "C1", "contact_text": "Alice|a@x.com|"},
            {"companyCdpId": "C1", "contact_text": "Bob|b@x.com|"}])
        self.assertEqual(res["updated"], 2)
        self.assertEqual(payloads[0][dcr.CONTACT_FIELD], "Alice|a@x.com|")
        self.assertEqual(payloads[1][dcr.CONTACT_FIELD],
                         "Alice|a@x.com|；Bob|b@x.com|")

    def test_merge_dedupes_same_contact(self):
        res, payloads = self._sync("Alice|a@x.com|；Bob|b@x.com|", [
            {"companyCdpId": "C1", "contact_text": "Bob|b@x.com|；Carol|c@x.com|"}])
        self.assertEqual(res["updated"], 1)
        self.assertEqual(payloads[0][dcr.CONTACT_FIELD],
                         "Alice|a@x.com|；Bob|b@x.com|；Carol|c@x.com|")


# ── B. 对账 7 类归类 ────────────────────────────────────

def touch(ref, *, customer="C1", occurred="2026-09-10T02:00:00+00:00", channel="email"):
    return {"customer_id": customer, "source_system": "email",
            "source_record_id": ref, "occurred_at": occurred, "channel": channel}


def inter(ref, *, customer="C1", interaction_id="it1",
          occurred="2026-09-10T02:00:00+00:00"):
    return {"customer_id": customer, "source_system": "email",
            "source_record_id": ref, "interaction_id": interaction_id,
            "occurred_at": occurred, "channel": "email", "direction": "outbound"}


def feishu_row(ref, *, interaction_id="it1"):
    return {"interaction_id": interaction_id, "source_system": "email",
            "source_record_id": ref, "customer_id": "C1", "occurred_at": ""}


class CategoriesTestCase(unittest.TestCase):
    def test_many_raw_to_one_interaction_is_allowed(self):
        """慧记+慧译多条原始记录 → 一个 interaction：不算重复、不算缺失。"""
        report = chain.reconcile_chain(
            "C1",
            touches=[touch("R1"), touch("R1", occurred="2026-09-10T03:00:00+00:00")],
            interactions=[inter("R1")],
            feishu_rows=[feishu_row("R1")])
        s = report["summary"]
        self.assertEqual(s["categories"][chain.CAT_DUPLICATE], 0)
        self.assertEqual(s["unexplained_total"], 0)

    def test_duplicate_flattening_flagged(self):
        """同一来源记录被展平成两条 interaction → 重复记录。"""
        report = chain.reconcile_chain(
            "C1",
            touches=[touch("R1")],
            interactions=[inter("R1", interaction_id="it1"),
                          inter("R1", interaction_id="it2")],
            feishu_rows=[feishu_row("R1")])
        self.assertEqual(report["summary"]["categories"][chain.CAT_DUPLICATE], 1)
        self.assertGreater(report["summary"]["unexplained_total"], 0)

    def test_pending_sync_uses_watermark(self):
        """事件时间晚于水位 → 等待同步；未解释差异保持 0。"""
        report = chain.reconcile_chain(
            "C1",
            touches=[touch("R9", occurred="2026-09-12T10:00:00+00:00")],
            interactions=[],
            feishu_rows=[],
            source_watermark={"touch": "2026-09-12T09:00:00+00:00"},
            as_of="2026-09-12T10:30:00+00:00")
        s = report["summary"]
        self.assertEqual(s["categories"][chain.CAT_PENDING_SYNC], 1)
        self.assertEqual(s["categories"][chain.CAT_MISSING_MEMORY], 0)
        self.assertEqual(s["unexplained_total"], 0)

    def test_before_watermark_still_missing(self):
        """水位已过仍未进 memory → 真缺失（不能拿等待同步当挡箭牌）。"""
        report = chain.reconcile_chain(
            "C1",
            touches=[touch("R9", occurred="2026-09-12T08:00:00+00:00")],
            interactions=[],
            feishu_rows=[],
            source_watermark={"touch": "2026-09-12T09:00:00+00:00"},
            as_of="2026-09-12T10:30:00+00:00")
        self.assertEqual(report["summary"]["categories"][chain.CAT_MISSING_MEMORY], 1)
        self.assertGreater(report["summary"]["unexplained_total"], 0)

    def test_unassigned_flagged(self):
        """既无 customer_id 也无来源定位键 → 未归属。"""
        ghost = {"customer_id": "", "source_system": "", "source_record_id": "",
                 "interaction_id": "it_ghost", "occurred_at": "2026-09-10T02:00:00+00:00"}
        report = chain.reconcile_chain("C1", touches=[], interactions=[ghost],
                                       feishu_rows=[])
        self.assertGreaterEqual(report["summary"]["categories"][chain.CAT_UNASSIGNED], 1)

    def test_exclusion_requires_explicit_rule(self):
        """没给规则 → 不猜；给了规则 → 才归「按规则有意排除」。"""
        t = touch("R7", channel="system")
        no_rule = chain.reconcile_chain("C1", touches=[t], interactions=[],
                                        feishu_rows=[])
        self.assertEqual(no_rule["summary"]["categories"][chain.CAT_EXCLUDED], 0)
        self.assertGreater(no_rule["summary"]["unexplained_total"], 0)

        with_rule = chain.reconcile_chain(
            "C1", touches=[t], interactions=[], feishu_rows=[],
            exclude_rules={"channels": ["system"]})
        s = with_rule["summary"]
        self.assertEqual(s["categories"][chain.CAT_EXCLUDED], 1)
        self.assertEqual(s["categories"][chain.CAT_MISSING_MEMORY], 0)
        self.assertEqual(s["unexplained_total"], 0)

    def test_only_seven_categories_exist(self):
        report = chain.reconcile_chain("C1", touches=[], interactions=[],
                                       feishu_rows=[])
        self.assertEqual(set(report["summary"]["categories"]),
                         set(chain.DIFF_CATEGORIES))
        self.assertEqual(len(chain.DIFF_CATEGORIES), 6)  # 6 类 + 未解释差异桶
        self.assertIn("未解释差异", chain.CAT_UNEXPLAINED)


if __name__ == "__main__":
    unittest.main(verbosity=2)
