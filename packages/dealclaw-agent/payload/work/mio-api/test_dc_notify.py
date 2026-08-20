#!/usr/bin/env python3
"""DC-Notify 统一通知底座 — 验收测试（P0-1.1 完整版）

使用临时目录 + mock sender + mock audit，禁止污染真实企业数据。
运行：cd work/mio-api && python3 test_dc_notify.py
"""

import json
import os
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_notify import NotifyEngine, MockSender, FeishuSender, MAX_ATTEMPTS


class MockAudit:
    def __init__(self):
        self.calls = []

    def log(self, action, user_open_id="", enterprise="", target="", detail="", before=None, after=None):
        self.calls.append({"action": action, "enterprise": enterprise,
                           "target": target, "detail": detail})


def _utcnow_iso():
    return datetime.now(timezone.utc).isoformat()


def make_engine(sender=None, audit=None, route=True):
    """创建 engine。route=True 时预置三条测试路由。"""
    tmp = tempfile.mkdtemp(prefix="dc-notify-test-")
    engine = NotifyEngine(data_dir=Path(tmp), sender=sender, audit=audit)
    if route:
        engine.set_route("haoqixiong", "oc_test_haoqixiong")
        engine.set_route("xuetelang", "oc_test_xuetelang")
        engine.set_route("texstead", "oc_test_texstead")
    return engine, Path(tmp)


def seed_failed(engine, company_id, attempts=1, next_retry_at=""):
    """构造一条 failed 记录，结束后恢复原 sender。"""
    original_sender = engine.sender
    fail_sender = MockSender(fail_on=lambda r: True)
    engine.sender = fail_sender
    r = engine.publish(company_id, "plan_item", {"title": "seed"}, slot="morning")
    engine.dispatch(company_id, slot="morning")  # 进 failed, attempts=1
    nid = r["notification_id"]
    patch = {"attempts": attempts}
    if next_retry_at:
        patch["next_retry_at"] = next_retry_at
    engine.store.update_failed(nid, patch)
    engine.sender = original_sender  # 恢复
    return nid


def main():
    passed = []
    failures = []

    def check(name, cond, extra=""):
        if cond:
            passed.append(name)
            print(f"  ✅ {name}")
        else:
            failures.append(name)
            print(f"  ❌ {name}  {extra}")

    print("=" * 70)

    # 白名单：本测试用 MockSender 验证 send→sent/failed 链路，需放行测试企业。
    os.environ["DC_NOTIFY_ALLOWED_COMPANIES"] = "haoqixiong,xuetelang,texstead"

    # 1. publish plan_item 后 morning dispatch 读取
    engine, tmp = make_engine(MockSender(), MockAudit())
    r = engine.publish("haoqixiong", "plan_item", {"title": "今日待触达 3 家"},
                       slot="morning", campaign_id="q2-indo")
    check("1. publish plan_item", r["status"] == "published", json.dumps(r, ensure_ascii=False))
    d = engine.dispatch("haoqixiong", slot="morning", dry_run=True)
    check("1. morning dispatch 读取到", d["status"] == "dry_run" and len(d["batches"]) == 1,
          json.dumps(d, ensure_ascii=False))

    # 2. 同一 slot 多条 plan_item 合并为一条
    engine, tmp = make_engine(MockSender(), MockAudit())
    engine.publish("haoqixiong", "plan_item", {"title": "A"}, slot="morning")
    engine.publish("haoqixiong", "plan_item", {"title": "B"}, slot="morning")
    engine.publish("haoqixiong", "plan_item", {"title": "C"}, slot="morning")
    d = engine.dispatch("haoqixiong", slot="morning", dry_run=True)
    merged = d["batches"][0]
    check("2. 同 slot 多条 plan_item 合并为一条",
          len(d["batches"]) == 1 and len(merged["items"]) == 3,
          json.dumps(d, ensure_ascii=False))

    # 3. 相同 dedupe_key 连续 publish 两次只保留一条
    engine, tmp = make_engine(MockSender(), MockAudit())
    r1 = engine.publish("xuetelang", "plan_item", {"title": "X"}, slot="morning", dedupe_key="k-1")
    r2 = engine.publish("xuetelang", "plan_item", {"title": "X"}, slot="morning", dedupe_key="k-1")
    pending = engine.store.read_pending()
    check("3. 相同 dedupe_key 只保留一条",
          r1["status"] == "published" and r2["status"] == "duplicate" and len(pending) == 1,
          f"r1={r1['status']} r2={r2['status']} pending={len(pending)}")

    # 4. dry-run 不标记 sent（保持 pending）
    engine, tmp = make_engine(MockSender(), MockAudit())
    engine.publish("texstead", "plan_item", {"title": "D"}, slot="morning")
    engine.dispatch("texstead", slot="morning", dry_run=True)
    check("4. dry-run 保持 pending 不标记 sent",
          len(engine.store.read_sent()) == 0 and len(engine.store.read_pending()) == 1,
          f"sent={len(engine.store.read_sent())} pending={len(engine.store.read_pending())}")

    # 5. mock 发送成功后状态变为 sent 并写 sent_at
    engine, tmp = make_engine(MockSender(), MockAudit())
    engine.publish("texstead", "plan_item", {"title": "E"}, slot="morning")
    d = engine.dispatch("texstead", slot="morning")
    sent = engine.store.read_sent()
    check("5. 发送成功 → sent + sent_at",
          d["results"][0]["status"] == "sent" and len(sent) == 1 and sent[0].get("sent_at"),
          json.dumps(d, ensure_ascii=False))

    # 6. mock 发送失败 → failed + attempts + last_error
    def fail_all(n):
        return True
    engine, tmp = make_engine(MockSender(fail_on=fail_all), MockAudit())
    engine.publish("texstead", "plan_item", {"title": "F"}, slot="morning")
    d = engine.dispatch("texstead", slot="morning")
    failed_records = engine.store.read_failed()
    check("6. 发送失败 → failed + attempts + last_error",
          d["results"][0]["status"] == "failed" and len(failed_records) == 1
          and failed_records[0]["attempts"] == 1 and failed_records[0]["last_error"] == "mock failure",
          json.dumps(d, ensure_ascii=False))

    # 7. retry-failed 成功后进入 sent（保留累计 attempts）
    engine, tmp = make_engine(MockSender(), MockAudit())
    seed_failed(engine, "texstead", attempts=3, next_retry_at="2000-01-01T00:00:00+00:00")
    ret = engine.retry_failed("texstead")
    sent = engine.store.read_sent()
    check("7. retry-failed 成功 → sent 且保留 attempts",
          ret["results"][0]["status"] == "sent" and sent and sent[0].get("attempts") == 3,
          json.dumps(ret, ensure_ascii=False))

    # 8. system_alert 只写 audit 不发企业用户
    engine, tmp = make_engine(MockSender(), MockAudit())
    audit = engine._audit
    engine.publish("xuetelang", "system_alert", {"message": "credits-ledger down"})
    d = engine.dispatch("xuetelang", slot="morning", dry_run=True)
    audit_only = [c for c in audit.calls if c["action"] == "notify.audit_only"]
    check("8. system_alert 只写 audit 不发企业用户",
          d["status"] == "quiet" and len(audit_only) == 1 and len(engine.store.read_pending()) == 0,
          f"dispatch={d['status']} audit_only={len(audit_only)} pending={len(engine.store.read_pending())}")

    # 9. 并发 publish 不破坏 Markdown 文件
    engine, tmp = make_engine(MockSender(), MockAudit())
    def worker(wid):
        for i in range(10):
            engine.publish("haoqixiong", "plan_item", {"title": f"w{wid}-{i}"}, slot="morning")
    threads = [threading.Thread(target=worker, args=(w,)) for w in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    pending = engine.store.read_pending()
    check("9. 并发 publish 不破坏文件", len(pending) == 50, f"pending={len(pending)}")

    # 10. 无待发内容返回 quiet
    engine, tmp = make_engine(MockSender(), MockAudit())
    d = engine.dispatch("haoqixiong", slot="morning", dry_run=True)
    check("10. 无待发内容返回 quiet", d["status"] == "quiet", json.dumps(d, ensure_ascii=False))

    # 11. opportunity / handoff 已移除（与现有邮件通知 / IQ断点重复）
    engine, tmp = make_engine(MockSender(), MockAudit())
    r_o = engine.publish("haoqixiong", "opportunity", {"buyer": "X"})
    r_h = engine.publish("haoqixiong", "handoff", {"reason": "缺资料"})
    check("11. opportunity/handoff 已移除（invalid kind）",
          r_o["status"] == "error" and r_h["status"] == "error"
          and "invalid kind" in r_o.get("error", "") and "invalid kind" in r_h.get("error", ""),
          f"opp={r_o['status']} handoff={r_h['status']}")

    # 12. route_missing 不发送（消息保留 pending）
    engine, tmp = make_engine(MockSender(), MockAudit(), route=False)
    engine.publish("unknown_co", "plan_item", {"title": "X"}, slot="morning")
    d = engine.dispatch("unknown_co", slot="morning")
    check("12. route_missing 不发送且保留 pending",
          d["status"] == "route_error" and d["route_status"] == "route_missing"
          and len(engine.store.read_pending()) == 1 and len(engine.store.read_sent()) == 0,
          json.dumps(d, ensure_ascii=False))

    # 13. route_invalid 不发送
    engine, tmp = make_engine(MockSender(), MockAudit(), route=False)
    engine.set_route("bad_co", "not_a_valid_target")
    engine.publish("bad_co", "plan_item", {"title": "X"}, slot="morning")
    d = engine.dispatch("bad_co", slot="morning")
    check("13. route_invalid 不发送且保留 pending",
          d["status"] == "route_error" and d["route_status"] == "route_invalid"
          and len(engine.store.read_pending()) == 1,
          json.dumps(d, ensure_ascii=False))

    # 14. 生产路由：company_id 不得直接作 target，必须解析 chat_id
    engine, tmp = make_engine(MockSender(), MockAudit(), route=False)
    t_missing = engine.resolve_target("no_route_co")
    check("14. 无映射 resolve 返回 route_missing",
          t_missing["status"] == "route_missing",
          json.dumps(t_missing, ensure_ascii=False))
    engine.set_route("haoqixiong", "oc_real_123", "皓琦熊")
    t_ok = engine.resolve_target("haoqixiong")
    check("14. 有映射 resolve 返回合法 chat_id",
          t_ok["status"] == "ok" and t_ok["chat_id"] == "oc_real_123",
          json.dumps(t_ok, ensure_ascii=False))

    # 15. FeishuSender disabled → dry_run 不真实发送
    fs = FeishuSender(enabled=False)
    r = fs.send("oc_test", "hello", "idem_1")
    check("15. FeishuSender disabled → dry_run 不真实发送",
          r.ok and r.dry_run and not r.sent and r.backend == "feishu",
          f"ok={r.ok} sent={r.sent} dry_run={r.dry_run}")

    # 16. FeishuSender 参数校验
    r_empty_target = fs.send("", "hello", "idem_2")
    r_empty_msg = fs.send("oc_test", "", "idem_3")
    check("16. FeishuSender 参数校验",
          not r_empty_target.ok and "target" in r_empty_target.error
          and not r_empty_msg.ok and "message" in r_empty_msg.error,
          f"target_err={r_empty_target.error!r} msg_err={r_empty_msg.error!r}")

    # 17. 未到期不重试
    engine, tmp = make_engine(MockSender(), MockAudit())
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    seed_failed(engine, "texstead", attempts=1, next_retry_at=future)
    ret = engine.retry_failed("texstead")
    check("17. 未到期不重试",
          ret["status"] == "quiet" and len(ret.get("results", [])) == 0,
          json.dumps(ret, ensure_ascii=False))

    # 18. 到期允许重试
    engine, tmp = make_engine(MockSender(), MockAudit())
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    seed_failed(engine, "texstead", attempts=1, next_retry_at=past)
    ret = engine.retry_failed("texstead")
    check("18. 到期允许重试",
          ret["status"] == "dispatched" and len(ret["results"]) == 1
          and ret["results"][0]["status"] == "sent",
          json.dumps(ret, ensure_ascii=False))

    # 19. 达到最大次数停止自动重试（force 可强制）
    engine, tmp = make_engine(MockSender(), MockAudit())
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    seed_failed(engine, "texstead", attempts=MAX_ATTEMPTS, next_retry_at=past)
    ret = engine.retry_failed("texstead")
    check("19a. 达到 max_attempts 停止自动重试",
          ret["status"] == "quiet" and len(ret.get("results", [])) == 0,
          json.dumps(ret, ensure_ascii=False))
    ret_force = engine.retry_failed("texstead", force=True)
    check("19b. --force 强制重试",
          ret_force["status"] == "dispatched" and len(ret_force["results"]) == 1,
          json.dumps(ret_force, ensure_ascii=False))

    # 20. disabled Sender（FeishuSender）→ dispatch 结果 dry_run 且 pending 保持
    engine, tmp = make_engine(FeishuSender(enabled=False), MockAudit())
    engine.publish("haoqixiong", "plan_item", {"title": "Y"}, slot="morning")
    d = engine.dispatch("haoqixiong", slot="morning")
    check("20. disabled Sender 不真实发送，pending 保持",
          d["results"][0]["status"] == "dry_run"
          and len(engine.store.read_pending()) == 1 and len(engine.store.read_sent()) == 0,
          json.dumps(d, ensure_ascii=False))

    # 21. 原有模块 import / health smoke test
    import importlib
    smoke_ok = True
    smoke_err = []
    for m in ["dc_registry", "dc_health", "dc_send_log", "dc_ls_store", "dc_audit",
              "dc_dashboard", "dc_iq_engine", "dc_kb_engine", "heartbeat_data"]:
        try:
            importlib.import_module(m)
        except Exception as e:
            smoke_ok = False
            smoke_err.append(f"{m}: {e}")
    check("21. 原有模块 import smoke test", smoke_ok, "; ".join(smoke_err))

    print("=" * 70)
    print(f"\n结果：{len(passed)} passed, {len(failures)} failed")
    if failures:
        print("失败项：", failures)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
