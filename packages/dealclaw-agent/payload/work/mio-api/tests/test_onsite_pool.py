#!/usr/bin/env python3
"""test_onsite_pool.py — 现场推荐落池（每届展会一个独立线索池）。

客户 2026-09-15 口径：
  - 来源 =「展中推荐」（与展后推荐的「展会线索」区分）、阶段 =「现场对接中」
  - 每届展会一个独立池（Base 标题 `<展会名>｜展中推荐线索池`），与企业主池分开
  - 公司名+官网幂等去重：同一场重复执行不重复建池、不重复写同一条线索
  - 排除不落：suppressed（denied/blacklisted/人工排除）/ 邀约状态 3=已拒绝 不落池也不推
  - 汇总气泡带池入口；≤10 条时入口挂在末条明细气泡
  - 落池失败不丢明细（error 字段）；dry-run 不写远端

全部用**内存假 lark-cli**（patch `dc_company_registry._run_lark`）：
不调飞书、不写远端、不起子进程（`subprocess.run` 被打死为断言）。

运行：cd work/mio-api && python3 -m unittest discover -s . -t . -p "test_onsite_pool.py"
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dc_company_registry as dcr  # noqa: E402
import dc_onsite_recommend as onsite  # noqa: E402

TENANT = "151897148668"
CHAT = "oc_onsite_test"
EXHIBITION_ID = "exh-1"
EXHIBITION_NAME = "印尼包装展"
POOL_TITLE = f"{EXHIBITION_NAME}｜展中推荐线索池"
POOL_KEY = f"{TENANT}::exhibition::{EXHIBITION_ID}"
KEYWORDS = ["包装袋"]

SEARCH_FIELDS = ["公司名", "官网", "公司CDPID", "国家", "来源"]


def buyer(i, **kw):
    """一条「buyer onsite」记录。"""
    out = {
        "companyName": f"PT Buyer{i}",
        "website": f"buyer{i}.co.id",
        "companyCdpId": f"C{i}",
        "countryCnName": "印尼",
        "companyAttributes": [1],
        "purchaseTags": [{"name": "包装袋"}],
    }
    out.update(kw)
    return out


def make_args(**kw):
    base = {"company_id": TENANT, "exhibition_id": EXHIBITION_ID,
            "chat_id": CHAT, "dry_run": False}
    base.update(kw)
    return argparse.Namespace(**base)


# ── 内存假 lark-cli ───────────────────────────────────────
class FakeLark:
    """模拟 lark-cli（columnar v1.0.85）。绝不触网、绝不写远端。"""

    def __init__(self):
        self.bases: dict[str, dict] = {}
        self.calls: list[list[str]] = []
        self._seq = 0
        self._rid = 0

    # ── 断言辅助 ──
    def calls_of(self, verb: str) -> list[list[str]]:
        return [c for c in self.calls if verb in c]

    def base_name(self, app_token: str) -> str:
        return self.bases[app_token]["name"]

    def records(self, app_token: str, table_id: str) -> list[dict]:
        return self.bases[app_token]["tables"][table_id]["records"]

    def count_records(self) -> int:
        return sum(len(t["records"]) for b in self.bases.values() for t in b["tables"].values())

    def drop_option(self, app_token: str, table_id: str, field_name: str, option: str) -> None:
        """模拟老池：字段选项里没有新口径的值。"""
        fields = self.bases[app_token]["tables"][table_id]["fields"]
        fields[field_name]["options"] = [o for o in fields[field_name]["options"]
                                        if o.get("name") != option]

    def field_options(self, app_token: str, table_id: str, field_name: str) -> list[str]:
        fields = self.bases[app_token]["tables"][table_id]["fields"]
        return [o.get("name") for o in fields[field_name].get("options") or []]

    def table_id_of(self, app_token: str) -> str:
        return next(iter(self.bases[app_token]["tables"]))

    # ── 假 CLI ──
    def __call__(self, *args, **kwargs):
        argv = [str(x) for x in args]
        self.calls.append(argv)
        handlers = {
            ("base", "+base-create"): self._base_create,
            ("base", "+field-list"): self._field_list,
            ("base", "+field-get"): self._field_get,
            ("base", "+field-update"): self._field_update,
            ("base", "+record-list"): self._record_list,
            ("base", "+record-batch-create"): self._batch_create,
            ("base", "+record-upsert"): self._upsert,
            ("base", "+table-list"): self._table_list,
            ("drive", "+search"): self._drive_search,
        }
        try:
            handler = handlers[(argv[0], argv[1])]
        except (IndexError, KeyError):
            raise RuntimeError(f"假 lark-cli 不认识的命令: {argv}")
        return handler(argv)

    def _flag(self, argv: list[str], name: str) -> str:
        return argv[argv.index(name) + 1] if name in argv else ""

    def _flags(self, argv: list[str], name: str) -> list[str]:
        return [argv[i + 1] for i, x in enumerate(argv) if x == name]

    def _base_create(self, argv):
        self._seq += 1
        token, tid = f"basetok{self._seq}", f"tbl{self._seq}"
        name = self._flag(argv, "--name")
        fields = {}
        for f in json.loads(self._flag(argv, "--fields") or "[]"):
            fields[f["name"]] = json.loads(json.dumps(f))
        self.bases[token] = {"name": name, "tables": {tid: {"fields": fields, "records": []}}}
        return {"ok": True, "data": {
            "base": {"base_token": token, "name": name, "url": f"https://x/base/{token}"},
            "table": {"id": tid}}}

    def _field_list(self, argv):
        token, tid = self._flag(argv, "--base-token"), self._flag(argv, "--table-id")
        fields = self.bases[token]["tables"][tid]["fields"]
        return {"ok": True, "data": {"fields": [{"name": n, "id": f"fld_{i}"}
                                                for i, n in enumerate(fields)]}}

    def _field_get(self, argv):
        token, tid = self._flag(argv, "--base-token"), self._flag(argv, "--table-id")
        field = self.bases[token]["tables"][tid]["fields"].get(self._flag(argv, "--field-id"))
        return {"ok": True, "data": {"field": json.loads(json.dumps(field)) if field else None}}

    def _field_update(self, argv):
        token, tid = self._flag(argv, "--base-token"), self._flag(argv, "--table-id")
        definition = json.loads(self._flag(argv, "--json"))
        name = self._flag(argv, "--field-id")
        self.bases[token]["tables"][tid]["fields"][name] = definition
        return {"ok": True, "data": {"field": definition}}

    def _record_list(self, argv):
        token, tid = self._flag(argv, "--base-token"), self._flag(argv, "--table-id")
        wanted = self._flags(argv, "--field-id") or SEARCH_FIELDS
        rows = self.bases[token]["tables"][tid]["records"]
        return {"ok": True, "data": {
            "record_id_list": [r["record_id"] for r in rows],
            "fields": wanted,
            "data": [[r["fields"].get(f, "") for f in wanted] for r in rows]}}

    def _batch_create(self, argv):
        token, tid = self._flag(argv, "--base-token"), self._flag(argv, "--table-id")
        creates = json.loads(self._flag(argv, "--json")).get("create_records") or []
        ids = []
        for fields in creates:
            self._rid += 1
            rid = f"rec{self._rid}"
            self.bases[token]["tables"][tid]["records"].append(
                {"record_id": rid, "fields": dict(fields)})
            ids.append(rid)
        return {"ok": True, "data": {"record_id_list": ids}}

    def _upsert(self, argv):
        token, tid = self._flag(argv, "--base-token"), self._flag(argv, "--table-id")
        rid = self._flag(argv, "--record-id")
        fields = json.loads(self._flag(argv, "--json"))
        for r in self.bases[token]["tables"][tid]["records"]:
            if r["record_id"] == rid:
                r["fields"].update(fields)
                return {"ok": True, "data": {"record_id": rid}}
        raise RuntimeError(f"record 不存在: {rid}")

    def _table_list(self, argv):
        token = self._flag(argv, "--base-token")
        return {"ok": True, "data": {"tables": [{"name": "线索池", "id": tid}
                                                for tid in self.bases[token]["tables"]]}}

    def _drive_search(self, argv):
        return {"ok": True, "data": {"results": []}}


class OnsitePoolTestCase(unittest.TestCase):
    """现场数据全部内存化；lark-cli 与注册表关进临时目录。"""

    def setUp(self):
        logging.disable(logging.WARNING)
        self.addCleanup(logging.disable, logging.NOTSET)
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.fake = FakeLark()
        self.sent: list[str] = []
        self.buyers: list[dict] = []

        patchers = [
            mock.patch.multiple(dcr, DATA_DIR=tmp,
                                REGISTRY_FILE=tmp / "company_registry.json"),
            # 生产同款 canonical：非数字 id（如 slug / 复合键）一律折叠成租户 supplier_id。
            # 展会池键必须绕过它，否则会与企业主池撞键。
            mock.patch.object(dcr, "canonical_company_id",
                              lambda v: (v or "").strip() if (v or "").strip().isdigit()
                              else TENANT),
            mock.patch.object(onsite, "canonical_company_id", lambda v: (v or "").strip()),
            mock.patch.object(dcr, "_run_lark", self.fake),
            mock.patch.object(dcr.subprocess, "run",
                              side_effect=AssertionError("禁止真实调用 lark-cli")),
            mock.patch.object(onsite, "fetch_onsite", lambda exh_id, kw: self.buyers),
            mock.patch.object(onsite, "load_products", lambda cid: KEYWORDS),
            mock.patch.object(onsite, "load_invited_cdp_ids", lambda cid: set()),
            mock.patch.object(onsite, "send_card",
                              lambda chat_id, text, dry_run=False: (self.sent.append(text), True)[1]),
        ]
        for p in patchers:
            p.start()
        self.addCleanup(self._stop_all, patchers)
        self.addCleanup(self._tmp.cleanup)

    def _stop_all(self, patchers):
        for p in reversed(patchers):
            p.stop()

    def registry(self):
        return dcr.CompanyRegistry().list_all()

    def pool_entries(self):
        """(app_token, table_id) of the exhibition pool, or (None, None)."""
        entry = self.registry().get(POOL_KEY)
        return (entry["app_token"], entry["table_id"]) if entry else (None, None)


# ── 池身份：标题 / 隔离 / 幂等 ──────────────────────────
class TestExhibitionPoolIdentity(OnsitePoolTestCase):
    def test_1_title_and_separate_from_enterprise_pool(self):
        ent = dcr.ensure_company_lead_pool(TENANT, "德粘堡")
        pool = dcr.ensure_exhibition_lead_pool(TENANT, EXHIBITION_ID, EXHIBITION_NAME)
        self.assertNotEqual(ent["app_token"], pool["app_token"], "展会池不得复用企业主池")
        self.assertEqual(pool["title"], POOL_TITLE)
        self.assertEqual(self.fake.base_name(pool["app_token"]), POOL_TITLE)
        reg = self.registry()
        self.assertIn(TENANT, reg, "企业主池注册表条目不得被踩")
        self.assertIn(POOL_KEY, reg, "展会池用独立注册表键")

    def test_2_ensure_is_idempotent(self):
        p1 = dcr.ensure_exhibition_lead_pool(TENANT, EXHIBITION_ID, EXHIBITION_NAME)
        p2 = dcr.ensure_exhibition_lead_pool(TENANT, EXHIBITION_ID, EXHIBITION_NAME)
        self.assertTrue(p1["created"])
        self.assertFalse(p2["created"], "已存在必须复用，不重复建")
        self.assertEqual(p1["app_token"], p2["app_token"])
        self.assertEqual(len(self.fake.calls_of("+base-create")), 1)

    def test_3_each_exhibition_gets_its_own_pool(self):
        p1 = dcr.ensure_exhibition_lead_pool(TENANT, "exh-1", "印尼包装展")
        p2 = dcr.ensure_exhibition_lead_pool(TENANT, "exh-2", "越南包装展")
        self.assertNotEqual(p1["app_token"], p2["app_token"])
        self.assertEqual(len(self.fake.calls_of("+base-create")), 2)
        self.assertEqual(len(self.registry()), 2)

    def test_4_missing_exhibition_id_rejected(self):
        with self.assertRaises(ValueError):
            dcr.ensure_exhibition_lead_pool(TENANT, "", EXHIBITION_NAME)


# ── 字段映射 ───────────────────────────────────────────
class TestOnsitePoolRecord(OnsitePoolTestCase):
    def test_5_fields_source_stage_and_type_mapping(self):
        record = onsite.onsite_pool_record(buyer(1), KEYWORDS)
        self.assertEqual(record["来源"], "展中推荐")
        self.assertEqual(record["阶段"], "现场对接中")
        self.assertEqual(record["公司名"], "PT Buyer1")
        self.assertEqual(record["官网"], "buyer1.co.id")
        self.assertEqual(record["公司CDPID"], "C1")
        self.assertEqual(record["国家"], "印尼")
        self.assertEqual(record["推荐理由"], "产品匹配:包装袋,生产商")
        self.assertEqual(record["匹配产品"], ["包装袋"])
        self.assertEqual(record["买家类型"], "制造商", "生产商 → 池枚举 制造商")

    def test_6_unnamed_and_websiteless_not_landed(self):
        self.assertIsNone(onsite.onsite_pool_record({"countryCnName": "印尼"}, KEYWORDS),
                          "无公司名也无官网 → 无法幂等去重，不落")
        self.assertIsNotNone(onsite.onsite_pool_record({"companyName": "X"}, KEYWORDS))

    def test_7_pool_type_enum_covers_all_attributes(self):
        for attr in (1, 2, 3, 4, 5):
            record = onsite.onsite_pool_record(buyer(1, companyAttributes=[attr]), KEYWORDS)
            self.assertIn(record["买家类型"], {"品牌商", "制造商", "经销商", "工程商"})


# ── 落池写入 ─────────────────────────────────────────
class TestLanding(OnsitePoolTestCase):
    def test_8_land_writes_records_with_source_and_stage(self):
        out = onsite.land_onsite_leads(TENANT, {"exhibitionId": EXHIBITION_ID,
                                                "name": EXHIBITION_NAME},
                                       [buyer(1), buyer(2)], KEYWORDS, chat_id=CHAT)
        self.assertNotIn("error", out)
        self.assertEqual((out["created"], out["updated"]), (2, 0))
        self.assertEqual(out["title"], POOL_TITLE)
        self.assertTrue(out["url"].startswith("https://"))
        token, tid = self.pool_entries()
        rows = self.fake.records(token, tid)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["fields"]["来源"], "展中推荐")
        self.assertEqual(rows[0]["fields"]["阶段"], "现场对接中")

    def test_9_rerun_does_not_duplicate_pool_or_rows(self):
        for _ in range(2):
            onsite.land_onsite_leads(TENANT, {"exhibitionId": EXHIBITION_ID,
                                              "name": EXHIBITION_NAME},
                                     [buyer(1), buyer(2)], KEYWORDS, chat_id=CHAT)
        self.assertEqual(len(self.fake.calls_of("+base-create")), 1, "池只建一次")
        token, tid = self.pool_entries()
        self.assertEqual(len(self.fake.records(token, tid)), 2, "线索不重复写")

    def test_10_dedupe_by_website_within_batch(self):
        same_site = [buyer(1), buyer(2, website="buyer1.co.id")]
        out = onsite.land_onsite_leads(TENANT, {"exhibitionId": EXHIBITION_ID,
                                                "name": EXHIBITION_NAME},
                                       same_site, KEYWORDS, chat_id=CHAT)
        self.assertEqual(out["created"], 1)
        self.assertEqual(out["duplicates"], 1, "同批同域名只落第一条（计数不静默）")

    def test_11_missing_select_option_is_healed(self):
        pool = dcr.ensure_exhibition_lead_pool(TENANT, EXHIBITION_ID, EXHIBITION_NAME)
        token, tid = pool["app_token"], pool["table_id"]
        self.fake.drop_option(token, tid, "来源", "展中推荐")
        self.fake.drop_option(token, tid, "阶段", "现场对接中")
        onsite.land_onsite_leads(TENANT, {"exhibitionId": EXHIBITION_ID,
                                          "name": EXHIBITION_NAME},
                                 [buyer(1)], KEYWORDS, chat_id=CHAT)
        self.assertIn("展中推荐", self.fake.field_options(token, tid, "来源"))
        self.assertIn("现场对接中", self.fake.field_options(token, tid, "阶段"))

    def test_12_dry_run_writes_nothing(self):
        out = onsite.land_onsite_leads(TENANT, {"exhibitionId": EXHIBITION_ID,
                                                "name": EXHIBITION_NAME},
                                       [buyer(1)], KEYWORDS, chat_id=CHAT, dry_run=True)
        self.assertTrue(out["dry_run"])
        self.assertEqual(out["skipped"], 1)
        self.assertEqual(self.fake.calls_of("+base-create"), [])
        self.assertEqual(self.fake.count_records(), 0)


# ── 端到端 run()：发送序列 + 池入口 + 排除 ───────────────
class TestRunFlow(OnsitePoolTestCase):
    def test_13_ten_leads_one_batch_with_pool_link(self):
        self.buyers = [buyer(i) for i in range(10)]
        result = onsite.run(make_args())
        row = result["results"][0]
        self.assertEqual((row["candidates"], row["excluded"]), (10, 0))
        self.assertEqual((row["bubbles"], row["sent"]), (1, 1))
        self.assertNotIn("全部明细分", self.sent[0], "≤10 不发汇总气泡")
        for i in range(10):
            self.assertIn(f"PT Buyer{i}", self.sent[0], "明细一条不省略")
        self.assertIn("📊 本展会线索池：", self.sent[0], "≤10 时池入口挂末条气泡")
        self.assertIn(row["pool"]["url"], self.sent[0])
        self.assertEqual(row["pool"]["source"], "展中推荐")
        self.assertEqual(row["pool"]["created"], 10)

    def test_14_eleven_leads_summary_first_then_all_batches(self):
        self.buyers = [buyer(i) for i in range(11)]
        result = onsite.run(make_args())
        row = result["results"][0]
        self.assertEqual((row["bubbles"], row["sent"]), (3, 3), "汇总 + 2 批明细")
        summary = self.sent[0]
        self.assertIn("共 11 家", summary)
        self.assertIn("全部明细分 2 批逐条发出，不省略", summary)
        self.assertIn("📊 本展会线索池：", summary, "汇总气泡给池入口")
        self.assertIn(row["pool"]["url"], summary)
        self.assertNotIn("📊 本展会线索池：", self.sent[1])   # 明细批形态不变
        joined = "\n".join(self.sent[1:])
        for i in range(11):
            self.assertIn(f"PT Buyer{i}", joined, "11 条明细分批全覆盖")
        self.assertNotIn("其余", "\n".join(self.sent))
        self.assertNotIn("未逐条", "\n".join(self.sent))

    def test_15_forty_nine_leads_summary_plus_five_batches(self):
        self.buyers = [buyer(i) for i in range(49)]
        result = onsite.run(make_args())
        row = result["results"][0]
        self.assertEqual((row["bubbles"], row["sent"]), (1 + 5, 6))
        joined = "\n".join(self.sent[1:])
        for i in range(49):
            self.assertIn(f"PT Buyer{i}", joined, "49 条明细一条不丢")
        self.assertEqual(row["pool"]["created"], 49)

    def test_16_excluded_not_pushed_not_landed(self):
        self.buyers = [
            buyer(1), buyer(2), buyer(3),
            buyer(4, denied=True),
            buyer(5, blacklisted=True),
            buyer(6, manual_excluded=1),
            buyer(7, inviationState="3"),
        ]
        result = onsite.run(make_args())
        row = result["results"][0]
        self.assertEqual(row["candidates"], 7)
        self.assertEqual(row["excluded"], 4, "denied/blacklisted/manual_excluded/已拒绝 都排除")
        self.assertEqual(row["main"] + row["follow"], 3)
        text = "\n".join(self.sent)
        for i in (4, 5, 6, 7):
            self.assertNotIn(f"PT Buyer{i}", text, "被排除的买家不推")
        token, tid = self.pool_entries()
        landed = {r["fields"]["公司名"] for r in self.fake.records(token, tid)}
        self.assertEqual(landed, {"PT Buyer1", "PT Buyer2", "PT Buyer3"}, "排除不落")

    def test_17_pool_failure_does_not_drop_bubbles(self):
        self.buyers = [buyer(i) for i in range(11)]
        with mock.patch.object(dcr, "sync_exhibition_leads_to_pool",
                               side_effect=RuntimeError("boom")):
            result = onsite.run(make_args())
        row = result["results"][0]
        self.assertIn("boom", row["pool"]["error"])
        self.assertEqual((row["bubbles"], row["sent"]), (3, 3), "落池失败不影响明细推送")
        self.assertEqual(row["pool"]["url"], "")
        self.assertNotIn("📊", "\n".join(self.sent), "没有池链接时不编一个假入口")
        self.assertIn("PT Buyer10", "\n".join(self.sent))

    def test_18_run_dry_run_writes_nothing(self):
        self.buyers = [buyer(i) for i in range(11)]
        result = onsite.run(make_args(dry_run=True))
        row = result["results"][0]
        self.assertTrue(row["pool"]["dry_run"])
        self.assertEqual(self.fake.calls_of("+base-create"), [])
        self.assertEqual(self.fake.count_records(), 0)

    def test_19_onsite_run_never_touches_enterprise_pool(self):
        self.buyers = [buyer(i) for i in range(3)]
        ent = dcr.ensure_company_lead_pool(TENANT, "德粘堡")
        onsite.run(make_args())
        self.assertEqual(self.fake.records(ent["app_token"], ent["table_id"]), [],
                         "展中推荐只进本展会池，不写企业主池")


if __name__ == "__main__":
    unittest.main(verbosity=2)
