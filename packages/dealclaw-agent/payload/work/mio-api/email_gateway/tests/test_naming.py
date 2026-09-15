"""任务 T1：DealClaw 默认邮箱命名服务 — unittest 测试（标准库，不依赖 pytest）。

运行：
    cd work/mio-api && python3 -m unittest email_gateway.tests.test_naming -v

覆盖：slug 规则边界、取词优先级与拼音降级、保留词兜底、重名稳定性与幂等、
DB 唯一索引（含并发）、状态机合法/非法路径、旧地址 tombstone 与 180 天收信保留。

所有用例使用临时 sqlite（``tempfile.TemporaryDirectory`` / ``DC_DATA_DIR``），
不接触生产库。写法和既有测试（``test_p0e1_facts.py``）一致：
文件头把 ``parents[2]``（mio-api 根）插入 ``sys.path`` 再 import ``email_gateway.*``。
"""

from __future__ import annotations

import multiprocessing
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

_MIO = Path(__file__).resolve().parents[2]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

from email_gateway import naming
from email_gateway.naming import (
    ALLOWED_TRANSITIONS,
    DEFAULT_RETENTION_DAYS,
    EXTENDED_RESERVED_WORDS,
    MAIL_DOMAIN,
    MAX_SLUG_LEN,
    MIN_RETENTION_DAYS,
    RESERVED_WORDS,
    STATE_ACTIVE,
    STATE_RECEIVE_ONLY,
    STATE_RESERVED,
    STATE_SUSPENDED,
    STATES,
    MailboxNamingStore,
    can_transition,
    is_reserved,
    is_valid_slug,
    normalize_slug,
    pinyin_abbr,
    stable_short_code,
)

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)

REQUIRED_RESERVED = [
    "admin", "support", "billing", "abuse", "postmaster", "noreply", "sales",
    "security", "root",
]

#: 禁止出现的国家/地区/组织身份后缀（需求：不得写 suntech-us）。
BANNED_IDENTITY_SUFFIXES = {
    "us", "usa", "cn", "uk", "gb", "de", "jp", "kr", "in", "br", "ru", "fr",
    "eu", "asia", "apac", "emea", "ltd", "inc", "llc", "corp", "co", "group",
    "company", "intl", "international", "hq", "global",
}


# ── 共用基类 ────────────────────────────────────────────────

class StoreTestCase(unittest.TestCase):
    """每个用例一个临时目录 + 一个临时 sqlite 库。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.store = MailboxNamingStore(self.base / "data")
        self.assertTrue(
            str(self.store.db_path).startswith(str(self.base)),
            "测试必须落在临时目录")

    def reserve(self, enterprise_id, **kw):
        kw.setdefault("at", T0)
        return self.store.reserve_default_mailbox(enterprise_id=enterprise_id, **kw)

    def sql(self, sql, args=()):
        conn = sqlite3.connect(str(self.store.db_path))
        try:
            return conn.execute(sql, args).fetchall()
        finally:
            conn.close()

    def count_addresses(self, enterprise_id=None):
        if enterprise_id is None:
            return self.sql("SELECT COUNT(*) FROM mailbox_address")[0][0]
        return self.sql("SELECT COUNT(*) FROM mailbox_address WHERE enterprise_id = ?",
                        (enterprise_id,))[0][0]


# ── A. slug 规则边界 ────────────────────────────────────────

class SlugRuleTests(unittest.TestCase):

    def test_valid_slugs(self):
        for slug in ("abc", "a1b", "suntech", "suntech-7k3", "3m1", "x1-2y",
                     "a" * MAX_SLUG_LEN):
            with self.subTest(slug=slug):
                self.assertTrue(is_valid_slug(slug))

    def test_invalid_slugs(self):
        cases = {
            "Suntech": "大写",
            "sun tech": "空格",
            "深圳科技": "中文",
            "-abc": "首部连字符",
            "abc-": "尾部连字符",
            "a--b": "连续连字符",
            "ab": "长度 2（短于下限）",
            "3m": "长度 2（短于下限）",
            "a" * 33: "长度 33（超上限）",
            "ab_c": "下划线不在字符集内",
            "ab.c": "点号不在字符集内",
            "": "空串",
            None: "非字符串",
        }
        for slug, why in cases.items():
            with self.subTest(why=why):
                self.assertFalse(is_valid_slug(slug))

    def test_normalize_lowercases_and_folds_separators(self):
        self.assertEqual(normalize_slug("SUNTECH"), "suntech")
        self.assertEqual(normalize_slug("Sun Tech Ltd"), "sun-tech-ltd")
        self.assertEqual(normalize_slug("--abc--"), "abc")
        self.assertEqual(normalize_slug("a---b"), "a-b")
        self.assertEqual(normalize_slug("Sun_Tech.Co"), "sun-tech-co")
        self.assertEqual(normalize_slug("  Suntech  "), "suntech")

    def test_normalize_boundary_lengths(self):
        self.assertEqual(normalize_slug("ab"), "", "长度 2 规范化后不可用")
        out = normalize_slug("a" * 33)
        self.assertEqual(len(out), MAX_SLUG_LEN)
        self.assertTrue(is_valid_slug(out), "截断后必须仍合法")
        self.assertTrue(is_valid_slug(normalize_slug("a" * 31 + "-zz")),
                        "截断不得留下尾部连字符")

    def test_normalize_rejects_pure_chinese(self):
        self.assertEqual(normalize_slug("深圳市辉洋进出口有限公司"), "")

    def test_normalize_output_always_valid(self):
        for raw in ("SUN Tech Ltd", "a---b", "x" * 50, "深圳", "--", "", "3M-中国"):
            with self.subTest(raw=raw):
                out = normalize_slug(raw)
                self.assertTrue(out == "" or is_valid_slug(out))


# ── B. 保留词 ───────────────────────────────────────────────

class ReservedWordTests(StoreTestCase):

    def test_required_reserved_words_present(self):
        for word in REQUIRED_RESERVED:
            with self.subTest(word=word):
                self.assertIn(word, RESERVED_WORDS)
        self.assertTrue(is_reserved("ADMIN"))
        self.assertTrue(is_reserved(" admin "))
        self.assertFalse(is_reserved("suntech"))

    def test_reserved_word_always_suffixed(self):
        r = self.reserve("ent_admin", brand_name_en="Admin")
        self.assertNotEqual(r["address"], "admin")
        self.assertTrue(r["address"].startswith("admin-"))
        self.assertTrue(r["suffixed"])
        self.assertTrue(is_valid_slug(r["address"]))
        self.assertFalse(is_reserved(r["address"]))

    def test_every_reserved_word_never_handed_out_bare(self):
        for word in sorted(RESERVED_WORDS | EXTENDED_RESERVED_WORDS):
            with self.subTest(word=word):
                r = self.reserve(f"ent_{word}", brand_name_en=word.title())
                self.assertNotEqual(r["address"], word)
                self.assertEqual(r["email"], f"{r['address']}@{MAIL_DOMAIN}")
                self.assertFalse(is_reserved(r["address"]))

    def test_reserved_bare_row_is_never_inserted(self):
        self.reserve("ent_sales", brand_name_en="Sales")
        self.assertEqual(
            self.sql("SELECT 1 FROM mailbox_address WHERE address = 'sales'"), [])


# ── C. 取词优先级 + 拼音降级 ─────────────────────────────────

class SourcePriorityTests(StoreTestCase):

    def test_brand_over_short_and_pinyin(self):
        r = self.reserve("ent_p", brand_name_en="Suntech",
                         short_name_en="ST Industrial", pinyin_abbr="st",
                         company_name="深圳市辉洋进出口有限公司")
        self.assertEqual(r["address"], "suntech")
        self.assertEqual(r["source"], "brand_name_en")

    def test_short_name_when_brand_missing(self):
        r = self.reserve("ent_p2", short_name_en="ST Industrial", pinyin_abbr="st")
        self.assertEqual(r["address"], "st-industrial")
        self.assertEqual(r["source"], "short_name_en")

    def test_given_pinyin_over_derived(self):
        r = self.reserve("ent_p3", pinyin_abbr="HYMY",
                         company_name="深圳市辉洋进出口有限公司")
        self.assertEqual(r["address"], "hymy")
        self.assertEqual(r["source"], "pinyin_abbr")

    def test_pinyin_derivation_path(self):
        """环境未装 pypinyin 时走内置降级表。"""
        with mock.patch.object(naming, "_try_pypinyin", return_value=None):
            self.assertEqual(pinyin_abbr("深圳市辉洋进出口有限公司"), "szshyjck")
            r = self.reserve("ent_p4", company_name="深圳市辉洋进出口有限公司")
            self.assertEqual(r["address"], "szshyjck")
            self.assertEqual(r["source"], "pinyin_abbr")

    def test_pinyin_helper_behaviour(self):
        # 法务后缀被剔除，避免 "yxgs" 这类无信息量结果
        self.assertNotIn("yxgs", pinyin_abbr("辉洋有限公司"))
        self.assertEqual(pinyin_abbr("辉洋有限公司"), "hy")
        # ASCII 原样保留
        self.assertEqual(pinyin_abbr("辉洋Suntech"), "hysuntech")
        self.assertEqual(pinyin_abbr("Suntech Industries"), "suntechindustries")
        # 未收录字符跳过，不抛异常
        self.assertIsInstance(pinyin_abbr("Ω科技"), str)

    def test_generated_fallback_when_nothing_usable(self):
        r = self.reserve("ent_gen", brand_name_en="!!!", short_name_en="深圳",
                         company_name=";;;")
        self.assertEqual(r["source"], "pinyin_abbr")
        self.assertFalse(r["suffixed"])
        self.assertTrue(is_valid_slug(r["address"]))
        self.assertEqual(self.reserve("ent_gen2", brand_name_en="!!!")["source"],
                         "pinyin_abbr")

    def test_short_brand_gets_valid_suffixed_address(self):
        """品牌名只有 2 个字母：裸用非法，兜底后的完整地址合法。"""
        r = self.reserve("ent_lg", brand_name_en="LG")
        self.assertNotEqual(r["address"], "lg")
        self.assertTrue(r["address"].startswith("lg-"))
        self.assertTrue(is_valid_slug(r["address"]))


# ── D. 短码稳定性 / 幂等 / 重名 ──────────────────────────────

class ShortCodeAndIdempotencyTests(StoreTestCase):

    def test_short_code_deterministic(self):
        self.assertEqual(stable_short_code("ent_1|suntech", 0),
                         stable_short_code("ent_1|suntech", 0))
        self.assertNotEqual(stable_short_code("ent_1|suntech", 0),
                            stable_short_code("ent_1|suntech", 1))
        self.assertNotEqual(stable_short_code("ent_1|suntech", 0),
                            stable_short_code("ent_2|suntech", 0))
        for seed in ("a", "b", "suntech", "深圳市"):
            with self.subTest(seed=seed):
                code = stable_short_code(seed, 0)
                self.assertEqual(len(code), 3)
                self.assertTrue(any(c.isdigit() for c in code), code)

    def test_suffix_is_never_an_identity_suffix(self):
        addrs = [self.reserve(f"ent_id{i}", brand_name_en="Suntech")["address"]
                 for i in range(10)]
        self.assertEqual(addrs[0], "suntech")
        for addr in addrs[1:]:
            with self.subTest(addr=addr):
                self.assertTrue(addr.startswith("suntech-"))
                suffix = addr.split("-")[-1]
                self.assertNotIn(suffix, BANNED_IDENTITY_SUFFIXES)
                self.assertFalse(suffix.isalpha(),
                                 f"{addr}: 纯字母短码可能伪装成国家/组织后缀")
                self.assertTrue(any(c.isdigit() for c in suffix), addr)
                self.assertTrue(is_valid_slug(addr))
                self.assertLessEqual(len(addr), MAX_SLUG_LEN)

    def test_same_enterprise_is_idempotent(self):
        first = self.reserve("ent_1", brand_name_en="Suntech")
        second = self.reserve("ent_1", brand_name_en="Suntech")
        third = self.reserve("ent_1", brand_name_en="Completely Different")
        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertTrue(third["idempotent"])
        self.assertEqual(first["address"], "suntech")
        self.assertEqual(second["address"], "suntech")
        self.assertEqual(third["address"], "suntech")
        self.assertEqual(self.count_addresses(), 1)

    def test_same_name_different_enterprises_are_different_and_stable(self):
        a = self.reserve("ent_a", brand_name_en="Suntech")
        b = self.reserve("ent_b", brand_name_en="Suntech")
        self.assertEqual(a["address"], "suntech")
        self.assertNotEqual(b["address"], a["address"])
        self.assertTrue(b["address"].startswith("suntech-"))
        self.assertTrue(b["suffixed"])
        # 稳定：重复调用仍返回同一地址
        self.assertEqual(self.reserve("ent_b", brand_name_en="Suntech")["address"],
                         b["address"])
        self.assertEqual(self.reserve("ent_a", brand_name_en="Suntech")["address"],
                         a["address"])

    def test_three_same_name_enterprises_are_all_distinct(self):
        addrs = {self.reserve(f"ent_{i}", brand_name_en="Suntech")["address"]
                 for i in range(3)}
        self.assertEqual(len(addrs), 3)

    def test_lookup_helpers(self):
        r = self.reserve("ent_1", brand_name_en="Suntech")
        self.assertEqual(self.store.get_current_address("ent_1")["address"], r["address"])
        self.assertIsNone(self.store.get_current_address("nobody"))
        self.assertEqual(len(self.store.list_addresses(enterprise_id="ent_1")), 1)
        self.assertEqual(self.store.get_address(r["address"])["email"],
                         f"suntech@{MAIL_DOMAIN}")


# ── E. 唯一索引（DB 级，不靠应用层） ─────────────────────────

class UniqueIndexTests(StoreTestCase):

    def test_unique_indexes_exist_in_schema(self):
        indexes = {row[0] for row in self.sql(
            "SELECT name FROM sqlite_master WHERE type = 'index'")}
        for name in ("ux_mailbox_address_address", "ux_mailbox_address_full",
                     "ux_mailbox_current_per_enterprise"):
            with self.subTest(index=name):
                self.assertIn(name, indexes)

    def test_db_rejects_duplicate_address_without_app_logic(self):
        """绕过应用层直接 INSERT：唯一索引必须拦住重复占位。"""
        self.reserve("ent_1", brand_name_en="Suntech")
        cols = ("address, full_address, enterprise_id, owner_open_id, status,"
                " is_current, base_slug, source, suffixed, created_at, updated_at,"
                " status_reason")
        sql = (f"INSERT INTO mailbox_address ({cols}) VALUES "
               "('suntech', 'suntech@mail.dealclaw.io', 'ent_other', NULL,"
               " 'reserved', 1, 'suntech', 'manual', 0, ?, ?, '')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.sql(sql, (T0.isoformat(), T0.isoformat()))

    def test_db_enforces_single_current_address_per_enterprise(self):
        self.reserve("ent_1", brand_name_en="Suntech")
        sql = ("INSERT INTO mailbox_address (address, full_address, enterprise_id,"
               " status, is_current, created_at, updated_at, status_reason)"
               " VALUES ('other', 'other@mail.dealclaw.io', 'ent_1', 'reserved', 1,"
               " ?, ?, '')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.sql(sql, (T0.isoformat(), T0.isoformat()))


# ── F. 并发占位不重复 ───────────────────────────────────────

class ConcurrencyTests(StoreTestCase):

    def _run_threads(self, n, target):
        barrier = threading.Barrier(n)
        results, errors = [], []
        lock = threading.Lock()

        def worker(i):
            store = MailboxNamingStore(self.base / "data")
            barrier.wait()
            try:
                out = target(store, i)
                with lock:
                    results.append(out)
            except BaseException as exc:  # pragma: no cover
                with lock:
                    errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return results, errors

    def test_concurrent_same_name_different_enterprises_unique(self):
        n = 8
        results, errors = self._run_threads(
            n, lambda s, i: s.reserve_default_mailbox(
                enterprise_id=f"ent_c{i}", brand_name_en="Suntech")["address"])
        self.assertEqual(errors, [])
        self.assertEqual(len(results), n)
        self.assertEqual(len(set(results)), n, f"并发出现重复占位：{sorted(results)}")
        self.assertEqual(sum(1 for a in results if a == "suntech"), 1)
        self.assertEqual(self.count_addresses(), n)

    def test_concurrent_same_enterprise_yields_one_address(self):
        n = 8
        results, errors = self._run_threads(
            n, lambda s, i: s.reserve_default_mailbox(
                enterprise_id="ent_same", brand_name_en="Suntech")["address"])
        self.assertEqual(errors, [])
        self.assertEqual(len(set(results)), 1,
                         f"同企业并发产生了多个地址：{sorted(set(results))}")
        self.assertEqual(self.count_addresses(), 1)

    def test_multiprocess_same_enterprise_yields_one_address(self):
        ctx = multiprocessing.get_context("fork")
        queue = ctx.Queue()
        procs = [ctx.Process(target=_mp_reserve,
                             args=(str(self.base / "data"), "ent_mp", "Suntech", queue))
                 for _ in range(6)]
        for p in procs:
            p.start()
        for p in procs:
            p.join()
        out = [queue.get() for _ in procs]
        self.assertFalse(any(str(o).startswith("ERROR:") for o in out), out)
        self.assertEqual(len(set(out)), 1, out)
        self.assertEqual(self.count_addresses(), 1)


def _mp_reserve(data_dir, enterprise_id, brand, queue):
    from email_gateway.naming import MailboxNamingStore as S
    try:
        queue.put(S(data_dir).reserve_default_mailbox(
            enterprise_id=enterprise_id, brand_name_en=brand)["address"])
    except BaseException as exc:  # pragma: no cover
        queue.put(f"ERROR:{exc!r}")


# ── G. 状态机 ───────────────────────────────────────────────

class StateMachineTests(StoreTestCase):

    def test_state_and_transition_tables_shape(self):
        self.assertEqual(STATES,
                         {STATE_RESERVED, STATE_ACTIVE, STATE_RECEIVE_ONLY,
                          STATE_SUSPENDED})
        self.assertEqual(ALLOWED_TRANSITIONS[STATE_RESERVED],
                         {STATE_ACTIVE, STATE_SUSPENDED})

    def test_legal_transitions(self):
        for current, target in (
            (STATE_RESERVED, STATE_ACTIVE),
            (STATE_RESERVED, STATE_SUSPENDED),
            (STATE_ACTIVE, STATE_RECEIVE_ONLY),
            (STATE_ACTIVE, STATE_SUSPENDED),
            (STATE_RECEIVE_ONLY, STATE_ACTIVE),
            (STATE_RECEIVE_ONLY, STATE_SUSPENDED),
            (STATE_SUSPENDED, STATE_ACTIVE),
            (STATE_SUSPENDED, STATE_RECEIVE_ONLY),
        ):
            with self.subTest(current=current, target=target):
                self.assertTrue(can_transition(current, target))

    def test_illegal_transitions(self):
        for current, target in (
            (STATE_RESERVED, STATE_RECEIVE_ONLY),
            (STATE_ACTIVE, STATE_RESERVED),
            (STATE_RECEIVE_ONLY, STATE_RESERVED),
            (STATE_SUSPENDED, STATE_RESERVED),
            (STATE_ACTIVE, STATE_ACTIVE),
            (STATE_RESERVED, STATE_RESERVED),
            (STATE_RECEIVE_ONLY, STATE_RECEIVE_ONLY),
            (STATE_SUSPENDED, STATE_SUSPENDED),
            ("bogus", STATE_ACTIVE),
            (STATE_ACTIVE, "bogus"),
        ):
            with self.subTest(current=current, target=target):
                self.assertFalse(can_transition(current, target))

    def test_lifecycle_reserved_active_receive_only(self):
        addr = self.reserve("ent_1", brand_name_en="Suntech")["address"]
        self.assertEqual(self.store.get_address(addr)["status"], STATE_RESERVED)
        self.assertFalse(self.store.can_send(addr), "未激活不得发信")

        active = self.store.activate(addr, at=T0)
        self.assertEqual(active["status"], STATE_ACTIVE)
        self.assertEqual(active["activated_at"], T0.isoformat())
        self.assertTrue(self.store.can_send(addr))
        self.assertTrue(self.store.can_receive(addr))

        paused = self.store.set_receive_only(addr, at=T0, reason="manual")
        self.assertEqual(paused["status"], STATE_RECEIVE_ONLY)
        self.assertFalse(self.store.can_send(addr), "receive_only 立即停发")
        self.assertTrue(self.store.can_receive(addr))

        resumed = self.store.resume(addr, at=T0)
        self.assertEqual(resumed["status"], STATE_ACTIVE)
        self.assertEqual(resumed["activated_at"], T0.isoformat())

    def test_suspend_blocks_send_and_receive(self):
        addr = self.reserve("ent_1", brand_name_en="Suntech")["address"]
        self.store.activate(addr, at=T0)
        self.store.suspend(addr, at=T0, reason="violation")
        self.assertFalse(self.store.can_send(addr))
        self.assertFalse(self.store.can_receive(addr), "suspended 全停")
        self.assertEqual(self.store.resume(addr, at=T0)["status"], STATE_ACTIVE)

    def test_illegal_transition_paths_raise(self):
        addr = self.reserve("ent_1", brand_name_en="Suntech")["address"]
        with self.assertRaises(naming.InvalidTransitionError):
            self.store.set_receive_only(addr, at=T0)      # reserved -> receive_only
        self.store.activate(addr, at=T0)
        with self.assertRaises(naming.InvalidTransitionError):
            self.store.activate(addr, at=T0)              # 同状态
        self.store.suspend(addr, at=T0)
        with self.assertRaises(naming.InvalidTransitionError):
            self.store.transition(addr, STATE_RESERVED, at=T0)
        with self.assertRaises(naming.NamingError):
            self.store.transition(addr, "bogus", at=T0)
        with self.assertRaises(naming.NamingError):
            self.store.transition("nope", STATE_ACTIVE, at=T0)


# ── H. 旧地址 tombstone + 180 天收信保留 ─────────────────────

class RetentionAndTombstoneTests(StoreTestCase):

    def test_retire_stops_sending_immediately_and_keeps_receiving(self):
        addr = self.reserve("ent_1", brand_name_en="Suntech")["address"]
        self.store.activate(addr, at=T0)
        retired = self.store.retire(addr, at=T0,
                                    retention_days=DEFAULT_RETENTION_DAYS)
        self.assertEqual(retired["status"], STATE_RECEIVE_ONLY)
        self.assertEqual(retired["retired_at"], T0.isoformat())
        self.assertEqual(retired["receive_only_until"],
                         (T0 + timedelta(days=DEFAULT_RETENTION_DAYS)).isoformat())
        self.assertFalse(self.store.can_send(addr), "被替换即立即停止发信")
        self.assertTrue(retired["is_tombstoned"])

    def test_retention_window_is_at_least_180_days(self):
        addr = self.reserve("ent_1", brand_name_en="Suntech")["address"]
        self.store.activate(addr, at=T0)
        self.store.retire(addr, at=T0)

        self.assertTrue(self.store.can_receive(addr, at=T0 + timedelta(days=179)))
        self.assertTrue(self.store.can_receive(addr, at=T0 + timedelta(days=180)))
        self.assertFalse(self.store.can_receive(addr, at=T0 + timedelta(days=181)))

        self.assertEqual(
            self.store.enforce_retention(at=T0 + timedelta(days=179))["count"], 0)
        self.assertEqual(
            self.store.enforce_retention(at=T0 + timedelta(days=181))["expired"], [addr])
        self.assertEqual(self.store.get_address(addr)["status"], STATE_SUSPENDED)
        self.assertFalse(self.store.can_receive(addr, at=T0 + timedelta(days=200)))
        self.assertFalse(self.store.can_send(addr))

    def test_retention_below_180_days_is_rejected(self):
        addr = self.reserve("ent_1", brand_name_en="Suntech")["address"]
        self.store.activate(addr, at=T0)
        with self.assertRaises(ValueError):
            self.store.retire(addr, at=T0, retention_days=MIN_RETENTION_DAYS - 1)
        with self.assertRaises(ValueError):
            MailboxNamingStore(self.base / "other", default_retention_days=30)

    def test_retired_address_can_never_send_again(self):
        addr = self.reserve("ent_1", brand_name_en="Suntech")["address"]
        self.store.activate(addr, at=T0)
        self.store.retire(addr, at=T0)
        with self.assertRaises(naming.InvalidTransitionError):
            self.store.transition(addr, STATE_ACTIVE, at=T0)
        with self.assertRaises(naming.InvalidTransitionError):
            self.store.resume(addr, at=T0)
        self.assertFalse(self.store.can_send(addr))

    def test_tombstone_permits_no_reallocation(self):
        old = self.reserve("ent_1", brand_name_en="Suntech")["address"]
        self.store.activate(old, at=T0)
        self.store.retire(old, at=T0)

        self.assertTrue(self.store.is_tombstoned(old))
        self.assertFalse(self.store.is_allocatable(old))
        self.assertEqual(self.store.list_tombstones()[0]["address"], old)
        self.assertTrue(self.store.get_address(old)["is_tombstoned"])

        # 该企业再要地址：绝不回到旧地址
        r = self.store.replace_default_mailbox(enterprise_id="ent_1",
                                               brand_name_en="Suntech", at=T0)
        self.assertNotEqual(r["address"], old)
        self.assertFalse(r["replaced"],
                         "retire() 已清空 current，故本次没有可替换的当前地址")

        # 全新企业即使同名也拿不到 tombstone 地址
        fresh = self.reserve("ent_brand_new", brand_name_en="Suntech")
        self.assertNotEqual(fresh["address"], old)
        self.assertTrue(fresh["address"].startswith("suntech-"))
        self.assertTrue(self.store.is_tombstoned(old), "tombstone 永久有效")

    def test_replace_is_atomic(self):
        """替换默认邮箱：旧地址转 receive_only、当前地址切新（2026-09-15 减去幂等重放，只测原子替换）。"""
        first = self.reserve("ent_1", brand_name_en="Suntech")
        second = self.store.replace_default_mailbox(
            enterprise_id="ent_1", brand_name_en="Suntech", at=T0)
        self.assertTrue(second["replaced"])
        self.assertNotEqual(second["address"], first["address"])
        self.assertEqual(self.store.get_address(first["address"])["status"],
                         STATE_RECEIVE_ONLY)
        self.assertEqual(self.count_addresses("ent_1"), 2)
        self.assertEqual(self.store.get_current_address("ent_1")["address"],
                         second["address"])

    def test_replace_without_existing_address_just_reserves(self):
        r = self.store.replace_default_mailbox(enterprise_id="ent_new",
                                               brand_name_en="Suntech", at=T0)
        self.assertFalse(r["replaced"])
        self.assertIsNone(r["previous"])
        self.assertEqual(r["status"], STATE_RESERVED)


# ── I. 数据隔离 / 临时库 ────────────────────────────────────

class IsolationTests(StoreTestCase):

    def test_owner_open_id_is_metadata_not_scope(self):
        a = self.reserve("ent_1", brand_name_en="Suntech", owner_open_id="ou_a")
        b = self.reserve("ent_1", brand_name_en="Suntech", owner_open_id="ou_b")
        self.assertEqual(a["address"], b["address"])
        self.assertTrue(b["idempotent"])
        self.assertEqual(self.store.get_current_address("ent_1")["owner_open_id"],
                         "ou_a")

    def test_dc_data_dir_overrides_default_location(self):
        target = self.base / "isolated"
        with mock.patch.dict(os.environ, {"DC_DATA_DIR": str(target)}):
            s = MailboxNamingStore()
        self.assertTrue(str(s.db_path).startswith(str(target)))
        self.assertEqual(s.db_path.name, "addresses.sqlite3")

    def test_store_never_touches_production_path(self):
        self.reserve("ent_1", brand_name_en="Suntech")
        self.assertTrue(str(self.store.db_path).startswith(str(self.base)))
        self.assertFalse(str(self.store.db_path).startswith(str(_MIO / "data")))

    def test_missing_enterprise_id_is_rejected(self):
        with self.assertRaises(naming.NamingError):
            self.store.reserve_default_mailbox(enterprise_id="",
                                               brand_name_en="Suntech")


if __name__ == "__main__":
    unittest.main()
