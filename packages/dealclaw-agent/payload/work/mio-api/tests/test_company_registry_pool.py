#!/usr/bin/env python3
"""test_company_registry_pool.py — 线索池幂等 / 归属 / 唯一键 / 缺失字段 / record_id 恢复

全部用**内存假 lark-cli**（patch `dc_company_registry._run_lark`）：
本套件不调飞书、不写任何远端、不起子进程（`subprocess.run` 被打死为断言）。

覆盖 D2 ② 要求：
  - 幂等：同一批线索重复跑不重复建；值无变化不 update；只有变化字段才 update
  - 归属：每个 company 一个池；company_id 不串池
  - 唯一键优先级：公司CDPID > 官网域名；公司名不作为覆盖依据
  - 无 CDPID 的边界：只按域名匹配 / 都不匹配时新建
  - 缺失关键字段（CDPID/官网/公司名全无）→ 报错，不静默丢，且不留半写
  - create 后解析不到 record_id → 只读回查恢复；恢复不了按既有行为报错、**不重新创建**

运行：cd work/mio-api && python3 -m unittest tests.test_company_registry_pool -v
"""
from __future__ import annotations

import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dc_company_registry as dcr  # noqa: E402

SEARCH_FIELDS = ["公司名", "官网", "公司CDPID", "国家", "来源"]


# ── 内存假 lark-cli ───────────────────────────────────────
class FakeLark:
    """模拟 lark-cli 响应（columnar v1.0.85）。绝不触网、绝不写远端。"""

    def __init__(self, *, unparseable_create=False, create_actually_persists=True,
                 create_ok=True):
        self.bases: dict[str, dict] = {}
        self.calls: list[list[str]] = []
        self.unparseable_create = unparseable_create   # 响应拿不到 record_id
        self.create_actually_persists = create_actually_persists  # 回查能否查到
        self.create_ok = create_ok
        self._seq = 0
        self._rid = 0

    # ── 断言辅助 ──
    def calls_of(self, verb: str) -> list[list[str]]:
        return [c for c in self.calls if verb in c]

    def records(self, app_token: str, table_id: str) -> list[dict]:
        return self.bases[app_token]["tables"][table_id]

    def count_records(self) -> int:
        return sum(len(t) for b in self.bases.values() for t in b["tables"].values())

    # ── 假 CLI ──
    def __call__(self, *args, **kwargs):
        a = [str(x) for x in args]
        self.calls.append(a)
        if a[0] == "base" and a[1] == "+base-create":
            return self._base_create(a)
        if a[0] == "base" and a[1] == "+field-list":
            return self._field_list(a)
        if a[0] == "base" and a[1] == "+record-list":
            return self._record_list(a)
        if a[0] == "base" and a[1] == "+record-batch-create":
            return self._batch_create(a)
        if a[0] == "base" and a[1] == "+record-upsert":
            return self._upsert(a)
        raise RuntimeError(f"假 lark-cli 不认识的命令: {a}")

    def _flag(self, a: list[str], name: str) -> str:
        return a[a.index(name) + 1] if name in a else ""

    def _flags(self, a: list[str], name: str) -> list[str]:
        return [a[i + 1] for i, x in enumerate(a) if x == name]

    def _base_create(self, a):
        if not self.create_ok:
            raise RuntimeError("lark-cli 失败 [exit=1]: base-create 失败")
        self._seq += 1
        token = f"basetok{self._seq}"
        tid = f"tbl{self._seq}"
        name = self._flag(a, "--name")
        self.bases[token] = {"name": name, "tables": {tid: []}}
        return {"ok": True, "data": {"base": {"base_token": token, "name": name,
                                              "url": f"https://x/base/{token}"},
                                     "table": {"id": tid}}}

    def _field_list(self, a):
        token = self._flag(a, "--base-token")
        fields = json.loads(dcr.LEAD_POOL_FIELDS_JSON)
        return {"ok": True, "data": {"fields": [{"name": f["name"], "id": f"fld_{i}"}
                                                for i, f in enumerate(fields)]}}

    def _record_list(self, a):
        token, tid = self._flag(a, "--base-token"), self._flag(a, "--table-id")
        wanted = self._flags(a, "--field-id") or SEARCH_FIELDS
        rows = self.bases[token]["tables"][tid]
        return {"ok": True, "data": {
            "record_id_list": [r["record_id"] for r in rows],
            "fields": wanted,
            "data": [[r["fields"].get(f, "") for f in wanted] for r in rows],
        }}

    def _batch_create(self, a):
        token, tid = self._flag(a, "--base-token"), self._flag(a, "--table-id")
        payload = json.loads(self._flag(a, "--json"))
        creates = payload.get("create_records") or []
        ids = []
        if self.create_actually_persists:
            for fields in creates:
                self._rid += 1
                rid = f"rec{self._rid}"
                self.bases[token]["tables"][tid].append(
                    {"record_id": rid, "fields": dict(fields)})
                ids.append(rid)
        if self.unparseable_create:
            # 真实故障形态：写成功但响应结构拿不到 id
            return {"ok": True, "data": {}}
        return {"ok": True, "data": {"record_id_list": ids}}

    def _upsert(self, a):
        token, tid = self._flag(a, "--base-token"), self._flag(a, "--table-id")
        rid = self._flag(a, "--record-id")
        fields = json.loads(self._flag(a, "--json"))
        for r in self.bases[token]["tables"][tid]:
            if r["record_id"] == rid:
                r["fields"].update(fields)
                return {"ok": True, "data": {"record_id": rid}}
        raise RuntimeError(f"record 不存在: {rid}")


# ── 夹具 ────────────────────────────────────────────────
def rec(i, *, company=None, website=None, cdp=None, country="US"):
    """构造一条「引擎搜索结果」（_record_fields 的输入字段名）。"""
    out = {"countryCnName": country}
    if company:
        out["companyName"] = company
    if website:
        out["website"] = website
    if cdp:
        out["companyCdpId"] = cdp
    return out


class RegistryTestCase(unittest.TestCase):
    """把本地注册表与 lark CLI 全部关进临时目录 / 内存。"""

    def setUp(self):
        # 缺字段告警是预期噪声：本套件只断言行为，不刷日志
        logging.disable(logging.WARNING)
        self.addCleanup(logging.disable, logging.NOTSET)
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self._patch_dir = mock.patch.multiple(
            dcr, DATA_DIR=tmp, REGISTRY_FILE=tmp / "company_registry.json")
        self._patch_dir.start()
        # 租户环境隔离：canonical_company_id 会把 slug/未知值归到当前租户 supplier_id，
        # 而本套件用伪造公司号（c1/c2）验证「一企业一池、不串池」——
        # 不隔离的话两个假公司会被归成同一个租户池，测试结果随机器配置漂移。
        self._patch_canon = mock.patch.object(
            dcr, "canonical_company_id", lambda v: (v or "").strip())
        self._patch_canon.start()
        self.fake = FakeLark()
        self._patch_lark = mock.patch.object(dcr, "_run_lark", self.fake)
        self._patch_lark.start()
        # 任何真实子进程调用都是 bug（本套件禁止触网/触 CLI）
        self._patch_sub = mock.patch.object(dcr.subprocess, "run",
                                            side_effect=AssertionError("禁止真实调用 lark-cli"))
        self._patch_sub.start()

    def tearDown(self):
        self._patch_canon.stop()
        self._patch_sub.stop()
        self._patch_lark.stop()
        self._patch_dir.stop()
        self._tmp.cleanup()

    def registry(self):
        return dcr.CompanyRegistry().list_all()


# ── 归属：每企业一池，不串池 ─────────────────────────────
class TestPoolOwnership(RegistryTestCase):
    def test_one_pool_per_company_and_idempotent_ensure(self):
        p1 = dcr.ensure_company_lead_pool("c1", "Acme")
        p1b = dcr.ensure_company_lead_pool("c1", "Acme")
        self.assertTrue(p1["created"])
        self.assertFalse(p1b["created"], "已存在必须复用，不重复建")
        self.assertEqual(p1["app_token"], p1b["app_token"])
        self.assertEqual(len(self.fake.calls_of("+base-create")), 1)
        self.assertEqual(list(self.registry()), ["c1"])

    def test_company_ids_do_not_cross_pools(self):
        p1 = dcr.ensure_company_lead_pool("c1", "Acme")
        p2 = dcr.ensure_company_lead_pool("c2", "Beta")
        self.assertNotEqual(p1["app_token"], p2["app_token"], "不同 company 不得共用池")
        self.assertNotEqual(p1["table_id"], p2["table_id"])
        self.assertEqual(sorted(self.registry()), ["c1", "c2"])
        # 回访各自仍指向自己的池
        self.assertEqual(dcr.ensure_company_lead_pool("c1", "Acme")["app_token"],
                         p1["app_token"])
        self.assertEqual(dcr.ensure_company_lead_pool("c2", "Beta")["app_token"],
                         p2["app_token"])

    def test_ensure_requires_company_id_and_name(self):
        with self.assertRaises(ValueError):
            dcr.ensure_company_lead_pool("", "Acme")
        with self.assertRaises(ValueError):
            dcr.ensure_company_lead_pool("c1", "  ")

    def test_incomplete_field_map_is_refreshed_not_recreated(self):
        p1 = dcr.ensure_company_lead_pool("c1", "Acme")
        entry = dcr.CompanyRegistry().get("c1")
        entry["field_map"] = {"公司名": "fld_0"}          # 人为残缺
        dcr.CompanyRegistry().set("c1", entry)
        p2 = dcr.ensure_company_lead_pool("c1", "Acme")
        self.assertFalse(p2["created"])
        self.assertEqual(p2["app_token"], p1["app_token"])
        self.assertTrue(dcr.EXPECTED_FIELD_NAMES.issubset(p2["field_map"]))
        self.assertEqual(len(self.fake.calls_of("+base-create")), 1, "不得重建池")


# ── 幂等：重复跑不重复建、无变化不 update ────────────────
class TestSyncIdempotency(RegistryTestCase):
    def test_same_batch_twice_creates_once_and_updates_nothing(self):
        records = [rec(0, company="Acme", website="acme.com", cdp="C1", country="US"),
                   rec(1, company="Beta", website="beta.io", cdp="C2", country="DE")]
        first = dcr.sync_leads_to_pool("c1", "Acme", records, source="引擎搜索")
        self.assertEqual((first["created"], first["updated"], first["skipped"]), (2, 0, 0))
        self.assertEqual(len(first["record_ids"]), 2)

        second = dcr.sync_leads_to_pool("c1", "Acme", records, source="引擎搜索")
        self.assertEqual((second["created"], second["updated"]), (0, 0),
                         "同一批线索重复跑不得重复建")
        self.assertEqual(second["unique_keys"], first["unique_keys"])
        self.assertEqual(len(self.fake.calls_of("+record-batch-create")), 1)
        self.assertEqual(self.fake.count_records(), 2, "池里不能出现重复行")

    def test_only_changed_fields_are_updated(self):
        records = [rec(0, company="Acme", website="acme.com", cdp="C1", country="US")]
        dcr.sync_leads_to_pool("c1", "Acme", records)
        changed = [rec(0, company="Acme", website="acme.com", cdp="C1", country="MX")]
        out = dcr.sync_leads_to_pool("c1", "Acme", changed)
        self.assertEqual(out["updated"], 1)
        upserts = self.fake.calls_of("+record-upsert")
        self.assertEqual(len(upserts), 1)
        payload = json.loads(upserts[0][upserts[0].index("--json") + 1])
        self.assertEqual(payload, {"国家": "MX"}, "只写变化字段，不整行覆盖")

    def test_no_write_when_nothing_changed(self):
        records = [rec(0, company="Acme", website="acme.com", cdp="C1")]
        dcr.sync_leads_to_pool("c1", "Acme", records)
        self.fake.calls.clear()
        dcr.sync_leads_to_pool("c1", "Acme", records)
        self.assertEqual(self.fake.calls_of("+record-upsert"), [], "值无变化不做无意义 update")
        self.assertEqual(self.fake.calls_of("+record-batch-create"), [])


# ── 唯一键优先级：CDPID > 官网域名；公司名不覆盖 ─────────
class TestUniqueKeyPriority(RegistryTestCase):
    def _seed(self, **kwargs):
        dcr.sync_leads_to_pool("c1", "Acme", [rec(0, **kwargs)])

    def test_cdp_wins_over_website(self):
        """CDPID 命中即命中：官网变了也按 CDPID 匹配，不新建。"""
        self._seed(company="Acme", website="acme.com", cdp="C1")
        out = dcr.sync_leads_to_pool("c1", "Acme", [
            rec(0, company="Acme", website="acme-new.com", cdp="C1")])
        self.assertEqual(out["created"], 0, "CDPID 相同必须视为同一条线索")
        self.assertEqual(out["updated"], 1)
        self.assertEqual(self.fake.count_records(), 1)

    def test_website_matches_when_no_cdp(self):
        """无 CDPID 时按官网域名匹配（www/https 归一）。"""
        self._seed(company="Acme", website="https://www.acme.com/path")
        out = dcr.sync_leads_to_pool("c1", "Acme", [
            rec(0, company="Acme Renamed", website="acme.com")])
        self.assertEqual(out["created"], 0, "无 CDPID 时只按域名匹配")
        self.assertEqual(out["updated"], 1)
        self.assertEqual(self.fake.count_records(), 1)

    def test_company_name_alone_never_matches(self):
        """公司名不作为覆盖依据：无 CDPID/官网时同名也算新线索。"""
        self._seed(company="Acme")
        out = dcr.sync_leads_to_pool("c1", "Acme", [rec(0, company="Acme")])
        self.assertEqual(out["created"], 1, "公司名不得单独用于覆盖/匹配")
        self.assertEqual(out["updated"], 0)
        self.assertEqual(self.fake.count_records(), 2)

    def test_neither_key_matches_creates_with_default_stage(self):
        self._seed(company="Acme", website="acme.com", cdp="C1")
        out = dcr.sync_leads_to_pool("c1", "Acme", [
            rec(9, company="Gamma", website="gamma.com", cdp="C9")])
        self.assertEqual((out["created"], out["updated"]), (1, 0))
        created = self.fake.records(out["app_token"], out["table_id"])[-1]["fields"]
        self.assertEqual(created["阶段"], "待触达", "新建线索默认阶段=待触达")

    def test_full_url_and_case_normalization(self):
        """归一：scheme/www/大小写/路径不参与匹配。"""
        self._seed(company="Acme", website="HTTP://WWW.Acme.com/x")
        out = dcr.sync_leads_to_pool("c1", "Acme", [
            rec(0, company="Acme", website="acme.com")])
        self.assertEqual(out["created"], 0)


# ── 缺失关键字段：报错，不静默丢 ─────────────────────────
class TestMissingKeyFields(RegistryTestCase):
    def test_record_without_any_key_field_raises(self):
        with self.assertRaises(ValueError) as ctx:
            dcr.sync_leads_to_pool("c1", "Acme", [{"countryCnName": "US"}])
        self.assertIn("records[0]", str(ctx.exception))

    def test_error_raised_before_any_write(self):
        """坏记录不得留下半写：batch-create 从未发生。"""
        with self.assertRaises(ValueError):
            dcr.sync_leads_to_pool("c1", "Acme", [
                rec(0, company="Acme", website="acme.com", cdp="C1"),
                {"countryCnName": "US"},                       # 坏行在第 2 条
            ])
        self.assertEqual(self.fake.calls_of("+record-batch-create"), [],
                         "校验失败前不得有任何写操作")
        self.assertEqual(self.fake.count_records(), 0)

    def test_partial_fields_still_accepted(self):
        """只有公司名也能落（有归一键就不算缺失）。"""
        out = dcr.sync_leads_to_pool("c1", "Acme", [rec(0, company="Acme")])
        self.assertEqual(out["created"], 1)
        self.assertEqual(out["unique_keys"][0]["cdp"], "")


# ── create 后解析不到 record_id：只读回查，不重建 ────────
class TestRecordIdRecovery(RegistryTestCase):
    def test_recovery_by_readonly_requery(self):
        self.fake.unparseable_create = True          # 写成功但响应无 id
        out = dcr.sync_leads_to_pool("c1", "Acme", [
            rec(0, company="Acme", website="acme.com", cdp="C1"),
            rec(1, company="Beta", website="beta.io", cdp="C2")])
        self.assertEqual(out["created"], 2)
        self.assertEqual(len(out["record_ids"]), 2, "回查必须恢复出 record_id")
        self.assertEqual(out["record_ids"],
                         [r["record_id"] for r in self.fake.records(out["app_token"],
                                                                    out["table_id"])])
        self.assertEqual(len(self.fake.calls_of("+record-batch-create")), 1,
                         "恢复靠只读回查，绝不重新创建")
        self.assertTrue(self.fake.calls_of("+record-list"), "恢复必须只读重读索引")

    def test_unrecoverable_raises_and_never_recreates(self):
        self.fake.unparseable_create = True
        self.fake.create_actually_persists = False   # 回查也查不到
        with self.assertRaises(dcr.BitableResponseParseError):
            dcr.sync_leads_to_pool("c1", "Acme", [rec(0, company="Acme", cdp="C1")])
        self.assertEqual(len(self.fake.calls_of("+record-batch-create")), 1,
                         "失败后不得重新创建")

    def test_recovery_uses_cdp_then_domain(self):
        """回查按稳定唯一键对齐（CDPID 优先，无 CDPID 走域名）。"""
        self.fake.unparseable_create = True
        out = dcr.sync_leads_to_pool("c1", "Acme", [
            rec(0, company="Acme", website="acme.com", cdp="C1"),
            rec(1, company="Beta", website="beta.io")])       # 无 CDPID → 域名
        self.assertEqual(len(out["record_ids"]), 2)

    def test_no_lark_call_when_batch_empty(self):
        out = dcr.sync_leads_to_pool("c1", "Acme", [])
        self.assertEqual(out["created"], 0)
        self.assertEqual(self.fake.calls_of("+record-batch-create"), [])

    def test_parse_created_record_ids_rejects_unparseable_payload(self):
        with self.assertRaises(dcr.BitableResponseParseError):
            dcr.parse_created_record_ids({"ok": True, "data": {"weird": 1}})
        with self.assertRaises(dcr.BitableResponseParseError):
            dcr.parse_created_record_ids({"ok": True, "data": {}})
        self.assertEqual(
            dcr.parse_created_record_ids({"ok": True, "data": {"record_id_list": []}}), [],
            "明确为空（空列表）才算空")


if __name__ == "__main__":
    unittest.main(verbosity=2)
