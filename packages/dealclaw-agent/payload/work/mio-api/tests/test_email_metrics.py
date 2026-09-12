#!/usr/bin/env python3
"""email_metrics 测试 —— 覆盖 v1 文档要求的场景与不变量。

场景（对齐任务第 8 条）：
  1. 延迟退信：delivered 之后再来 bounced
  2. 重复 / 乱序 webhook
  3. 强引用回复（In-Reply-To / References / thread）
  4. 自动回复（不算人工回复）
  5. 未归属回信（unassigned / ambiguous，不丢弃也不计入批次）
  6. 跨租户隔离
  7. 跨日回复（按业务日分桶）
  8. 时区边界
  9. partial 同步（watermark）

不变量：
  - legacy_unverified 不映射为 accepted、不计入 sent
  - accepted / delivered / bounced 不强制凑平（另有 pending / failed / unknown）
  - complained / unsubscribed 不覆盖送达状态
  - delivered_final ≠ delivered_ever（延迟退信后）
  - 率只在 campaign_view 算，分母是该批次

直接运行：python3 tests/test_email_metrics.py
或：pytest tests/test_email_metrics.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from email_metrics import schema as S  # noqa: E402
from email_metrics.adapter import adapt_all, adapt_outbound, load_legacy_from_dir  # noqa: E402
from email_metrics.facts import replay, to_local_date  # noqa: E402
from email_metrics.pseudonym import buyer_key  # noqa: E402
from email_metrics.reconcile import old_metrics, reconcile, render_markdown  # noqa: E402
from email_metrics.views import activity_view, campaign_view, metrics_view  # noqa: E402

C1, C2 = "152600996207", "100000834234"


def ev(event_type, *, occurred, message="m1", company=C1, campaign="cmp1",
       direction=S.DIRECTION_OUTBOUND, event_id=None, thread="", lead="", contact="",
       in_reply_to="", references=None, binding=None, received_id="", buyer="",
       auto_reply=False, source=S.SOURCE_PROVIDER):
    """构造一条事实层事件（字段全部来自 schema 常量）。"""
    rec = {
        S.F_SCHEMA_VERSION: S.SCHEMA_VERSION,
        S.F_EVENT_ID: event_id or f"{event_type}:{message}:{occurred}",
        S.F_EVENT_TYPE: event_type,
        S.F_OCCURRED_AT_UTC: occurred,
        S.F_INGESTED_AT_UTC: occurred,
        S.F_PROVIDER: "resend",
        S.F_PROVIDER_MESSAGE_ID: message if direction == S.DIRECTION_OUTBOUND else "",
        S.F_PROVIDER_RECEIVED_ID: received_id or ("" if direction == S.DIRECTION_OUTBOUND else message),
        S.F_COMPANY_ID: company,
        S.F_CAMPAIGN_ID: campaign,
        S.F_LEAD_ID: lead,
        S.F_CONTACT_ID: contact,
        S.F_THREAD_ID: thread,
        S.F_DIRECTION: direction,
        S.F_IN_REPLY_TO: in_reply_to,
        S.F_REFERENCES: list(references or []),
        S.F_BUYER_KEY: buyer,
        S.F_SOURCE: source,
    }
    if binding:
        rec[S.F_BINDING_STATUS] = binding
    if auto_reply:
        rec["auto_reply"] = True
    return rec


# ── 1. 延迟退信 ─────────────────────────────────────────
def test_late_bounce_after_delivered():
    events = [
        ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00"),
        ev(S.EV_DELIVERED, occurred="2026-09-01T01:00:05+00:00"),
        ev(S.EV_BOUNCED, occurred="2026-09-03T02:00:00+00:00"),
    ]
    res = replay(events)
    st = res.messages["m1"]
    assert st.delivered_ever is True, "历史出现过送达"
    assert st.delivered_final is False, "终态是退信，delivered_final 必须为 False"
    assert st.final_state == S.STATE_BOUNCED

    m = metrics_view(res, company_id=C1)
    assert m["sent"] == 1
    assert m["delivered_final"] == 0
    assert m["delivered_ever"] == 1
    assert m["bounced"] == 1


# ── 2. 重复 / 乱序 webhook ───────────────────────────────
def test_duplicate_and_out_of_order():
    delivered = ev(S.EV_DELIVERED, occurred="2026-09-01T02:00:00+00:00")
    bounced = ev(S.EV_BOUNCED, occurred="2026-09-01T03:00:00+00:00")

    # 重复：同一 event_id 出现两次
    res = replay([delivered, dict(delivered), bounced])
    assert res.duplicates == 1
    assert res.messages["m1"].final_state == S.STATE_BOUNCED

    # 乱序：晚到的「更早事件」不能覆盖已确立的终态
    res2 = replay([bounced, delivered])
    assert res2.messages["m1"].final_state == S.STATE_BOUNCED, "早到事件不得回退终态"

    # 反向：先到 delivered(晚)，后到 bounced(早) —— bounced 是旧事件，不能覆盖
    late_delivered = ev(S.EV_DELIVERED, occurred="2026-09-01T05:00:00+00:00")
    stale_bounced = ev(S.EV_BOUNCED, occurred="2026-09-01T01:00:00+00:00")
    res3 = replay([late_delivered, stale_bounced])
    assert res3.messages["m1"].final_state == S.STATE_DELIVERED


# ── 3. 强引用回复 ────────────────────────────────────────
def test_strong_reference_binding():
    outbound = ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00", message="m1",
                  thread="th1", lead="L1")
    by_reply_to = ev(S.EV_INBOUND_RECEIVED, occurred="2026-09-02T01:00:00+00:00",
                     message="in1", direction=S.DIRECTION_INBOUND,
                     in_reply_to="m1", lead="L1")
    by_reference = ev(S.EV_INBOUND_RECEIVED, occurred="2026-09-02T02:00:00+00:00",
                      message="in2", direction=S.DIRECTION_INBOUND,
                      references=["m1"], lead="L1")
    by_thread = ev(S.EV_INBOUND_RECEIVED, occurred="2026-09-02T03:00:00+00:00",
                   message="in3", direction=S.DIRECTION_INBOUND, thread="th1", lead="L1")

    res = replay([outbound, by_reply_to, by_reference, by_thread])
    m = metrics_view(res, company_id=C1)
    assert m["inbound_messages"] == 3, "三封入站都要被强引用关联上"
    assert m["unique_repliers"] == 1, "同一 lead 只算一个买家"
    assert m["replied_threads"] == 1


# ── 4. 自动回复 ──────────────────────────────────────────
def test_auto_reply_not_human():
    outbound = ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00", message="m1")
    auto = ev(S.EV_INBOUND_RECEIVED, occurred="2026-09-02T01:00:00+00:00", message="in1",
              direction=S.DIRECTION_INBOUND, in_reply_to="m1", auto_reply=True)
    human = ev(S.EV_INBOUND_RECEIVED, occurred="2026-09-02T02:00:00+00:00", message="in2",
               direction=S.DIRECTION_INBOUND, in_reply_to="m1")
    res = replay([outbound, auto, human])
    m = metrics_view(res, company_id=C1)
    assert m["inbound_messages"] == 1, "自动回复不计入人工回复"


# ── 5. 未归属回信 ────────────────────────────────────────
def test_unassigned_and_ambiguous_not_counted():
    outbound = ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00", message="m1")
    unassigned = ev(S.EV_INBOUND_RECEIVED, occurred="2026-09-02T01:00:00+00:00",
                    message="in1", direction=S.DIRECTION_INBOUND,
                    binding=S.BINDING_UNASSIGNED, campaign="")
    ambiguous = ev(S.EV_INBOUND_RECEIVED, occurred="2026-09-02T02:00:00+00:00",
                   message="in2", direction=S.DIRECTION_INBOUND,
                   references=["unknown-id"], binding=S.BINDING_AMBIGUOUS, campaign="")

    res = replay([outbound, unassigned, ambiguous])
    assert len(res.unassigned) == 1
    assert len(res.ambiguous) == 1
    m = metrics_view(res, company_id=C1)
    assert m["inbound_messages"] == 0, "未匹配回信不得计入批次效果"
    assert m["unique_repliers"] == 0
    assert m["data_completeness"]["inbound_unassigned"] == 1

    report = reconcile(res, company_id=C1, legacy_unverified=0)
    assert len(report["unassigned"]) == 1 and len(report["ambiguous"]) == 1
    assert report["unassigned"][0]["counted"] is False
    md = render_markdown(report)
    assert "未归属明细" in md


# ── 6. 跨租户隔离 ────────────────────────────────────────
def test_cross_tenant_isolated():
    a = ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00", message="a1", company=C1)
    b = ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00", message="b1", company=C2)
    res = replay([a, b])
    assert metrics_view(res, company_id=C1)["sent"] == 1
    assert metrics_view(res, company_id=C2)["sent"] == 1
    assert metrics_view(res, company_id="someone-else")["sent"] == 0
    act = activity_view(res, company_id=C1)
    assert sum(d["sent"] for d in act["days"]) == 1


# ── 7. 跨日回复 ──────────────────────────────────────────
def test_reply_on_different_day_bucketed():
    outbound = ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00", message="m1")
    reply = ev(S.EV_INBOUND_RECEIVED, occurred="2026-09-03T01:00:00+00:00", message="in1",
               direction=S.DIRECTION_INBOUND, in_reply_to="m1")
    res = replay([outbound, reply])
    act = activity_view(res, company_id=C1)
    by_day = {d["business_date"]: d for d in act["days"]}
    assert by_day["2026-09-01"]["sent"] == 1
    assert by_day["2026-09-03"]["inbound_messages"] == 1


# ── 8. 时区边界 ──────────────────────────────────────────
def test_timezone_boundary():
    # 16:30 UTC = 次日 00:30 北京时间
    assert to_local_date("2026-09-10T16:30:00+00:00", "Asia/Shanghai") == "2026-09-11"
    # 15:59:59 UTC 仍是当天 23:59:59 北京时间
    assert to_local_date("2026-09-10T15:59:59+00:00", "Asia/Shanghai") == "2026-09-10"

    res = replay([ev(S.EV_ACCEPTED, occurred="2026-09-10T16:30:00+00:00")])
    act = activity_view(res, company_id=C1, report_timezone="Asia/Shanghai")
    assert act["days"][0]["business_date"] == "2026-09-11"

    # 同一条事实换时区 → 落不同业务日（事实层不存 business_date）
    act_utc = activity_view(res, company_id=C1, report_timezone="UTC")
    assert act_utc["days"][0]["business_date"] == "2026-09-10"

    # 日期过滤也按业务时区
    assert metrics_view(res, company_id=C1, date="2026-09-11")["sent"] == 1
    assert metrics_view(res, company_id=C1, date="2026-09-10")["sent"] == 0


# ── 9. partial 同步 ──────────────────────────────────────
def test_partial_sync_watermark():
    events = [
        ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00", message="m1"),
        ev(S.EV_ACCEPTED, occurred="2026-09-05T01:00:00+00:00", message="m2"),
    ]
    res = replay(events, watermark_utc="2026-09-02T00:00:00+00:00")
    assert res.completeness["partial"] is True
    assert res.completeness["events_out_of_window"] == 1
    m = metrics_view(res, company_id=C1)
    assert m["sent"] == 1
    assert m["data_completeness"]["data_complete"] is False, "partial 必须可被下游识别"


# ── 不变量：legacy_unverified ────────────────────────────
def test_legacy_unverified_not_counted_as_sent():
    with_provider = {"resend_id": "r1", "sent_at": "2026-09-01T01:00:00+00:00",
                     "company_id": C1, "campaign_id": "cmp1",
                     "provider_status": "delivered"}
    without_provider = {"sent_at": "2026-09-01T02:00:00+00:00", "company_id": C1,
                        "campaign_id": "cmp1", "provider_status": "delivered"}

    assert adapt_outbound(without_provider)["events"] == []
    assert adapt_outbound(without_provider)["unverified"][S.F_LEGACY_UNVERIFIED] is True

    adapted = adapt_all([with_provider, without_provider])
    assert adapted["stats"]["legacy_unverified"] == 1
    res = replay(adapted["events"])
    m = metrics_view(res, company_id=C1, legacy_unverified=adapted["stats"]["legacy_unverified"])
    assert m["sent"] == 1, "无 provider id 不得计入 sent"
    assert m["legacy_unverified"] == 1


# ── 不变量：不强制凑平 ───────────────────────────────────
def test_metrics_do_not_force_balance():
    events = [
        ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00", message="m1"),
        ev(S.EV_DELIVERED, occurred="2026-09-01T01:00:01+00:00", message="m1"),
        ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:02+00:00", message="m2"),
        # m3 只有 delivered、没有 accepted —— 不为它补一条 accepted（不凑平）
        ev(S.EV_DELIVERED, occurred="2026-09-01T01:00:03+00:00", message="m3"),
        # m4 只有 failed、没有 accepted
        ev(S.EV_FAILED, occurred="2026-09-01T01:00:04+00:00", message="m4"),
    ]
    res = replay(events)
    m = metrics_view(res, company_id=C1)
    assert m["sent"] == 2, "sent 只数有 accepted 事件的消息"
    assert m["delivered_final"] == 2, "m1 与「无 accepted 但有 delivered」的 m3"
    assert m["failed"] == 1
    assert m["pending"] == 1, "m2 有 accepted 无终态 → pending，不并入 delivered"
    assert m["unknown"] == 0
    assert m["data_completeness"]["messages_missing_accepted"] == 2
    # 不强制凑平：accepted 数可以大于/小于「终态之和」
    assert m["sent"] != m["delivered_final"] + m["bounced"] + m["failed"]


# ── 不变量：complained 不覆盖送达 ────────────────────────
def test_complaint_does_not_override_delivery():
    events = [
        ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00"),
        ev(S.EV_DELIVERED, occurred="2026-09-01T01:00:01+00:00"),
        ev(S.EV_COMPLAINED, occurred="2026-09-01T03:00:00+00:00"),
        ev(S.EV_UNSUBSCRIBED, occurred="2026-09-01T04:00:00+00:00"),
    ]
    res = replay(events)
    st = res.messages["m1"]
    assert st.delivered_final is True, "投诉/退订属于 engagement，不覆盖送达状态"
    assert st.complained is True and st.unsubscribed is True


# ── 不变量：率只在 campaign_view ─────────────────────────
def test_campaign_view_rate_basis():
    events = [
        ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00", message="a1", campaign="cmpA"),
        ev(S.EV_DELIVERED, occurred="2026-09-01T01:00:01+00:00", message="a1", campaign="cmpA"),
        ev(S.EV_ACCEPTED, occurred="2026-09-05T01:00:00+00:00", message="b1", campaign="cmpB"),
        ev(S.EV_DELIVERED, occurred="2026-09-05T01:00:01+00:00", message="b1", campaign="cmpB"),
        ev(S.EV_INBOUND_RECEIVED, occurred="2026-09-05T02:00:00+00:00", message="in1",
           direction=S.DIRECTION_INBOUND, in_reply_to="a1", campaign="cmpA", lead="L9"),
    ]
    res = replay(events)
    va = campaign_view(res, company_id=C1, campaign_id="cmpA")
    vb = campaign_view(res, company_id=C1, campaign_id="cmpB")
    assert va["sent"] == 1 and va["delivered_final"] == 1 and va["unique_repliers"] == 1
    assert vb["sent"] == 1 and vb["delivered_final"] == 1 and vb["unique_repliers"] == 0
    assert va["rate_basis"] == "campaign"


# ── 不变量：待跟进不报 0 ─────────────────────────────────
def test_followup_without_lead_source_is_not_zero():
    res = replay([ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00")])
    m = metrics_view(res, company_id=C1)
    assert m["followup"]["count"] is None
    assert m["followup"]["data_complete"] is False
    assert m["followup"]["reason"] == "lead_source_missing"


def test_followup_conditions():
    events = [
        ev(S.EV_ACCEPTED, occurred="2026-09-01T01:00:00+00:00", message="m1", lead="L1"),
        ev(S.EV_DELIVERED, occurred="2026-09-01T01:00:01+00:00", message="m1", lead="L1"),
    ]
    res = replay(events)
    base = {"sequence_status": "active", "delivered_final": True,
            "next_touch_due": True, "touch_number": 1, "max_rounds": 3}
    leads = [
        dict(base, lead_id="L1"),
        dict(base, lead_id="L2", channel_valid=False),
        dict(base, lead_id="L3", sequence_status="paused"),
        dict(base, lead_id="L4", unsubscribed=True),
        dict(base, lead_id="L5", touch_number=3),
        dict(base, lead_id="L6", manually_paused=True),
    ]
    m = metrics_view(res, company_id=C1, leads=leads)
    f = m["followup"]
    assert f["count"] == 1, "只有 L1 全部条件满足"
    assert [x["lead_id"] for x in f["missing_contact"]] == ["L2"]
    assert "L5" in [x["lead_id"] for x in f["excluded"]]

    # 有商机 next_step 的不重复计入普通待跟进
    m2 = metrics_view(res, company_id=C1, leads=[dict(base, lead_id="L1")],
                      opportunity_signals=[{"signal_type": "quote_request", "lead_id": "L1",
                                            "source_message_id": "m1"}])
    assert m2["followup"]["count"] == 0
    assert m2["followup"]["skipped_opportunity"][0]["lead_id"] == "L1"
    assert m2["confirmed_opportunity_repliers"] == 1


# ── 假名稳定性 ───────────────────────────────────────────
def test_pseudonym_stable_and_distinct():
    assert buyer_key("A@x.com") == buyer_key("A@x.com")
    assert buyer_key("a@x.com") != buyer_key("b@x.com")
    assert buyer_key("a@x.com").startswith("buyer_")
    assert "a@x.com" not in buyer_key("a@x.com")


# ── 对账报告（旧 vs 新）──────────────────────────────────
def test_reconcile_report_shows_gap_and_reasons():
    outbounds = [
        {"resend_id": "r1", "sent_at": "2026-09-01T01:00:00+00:00", "company_id": C1,
         "campaign_id": "cmp1", "provider_status": "delivered"},
        {"resend_id": "r2", "sent_at": "2026-09-01T01:00:00+00:00", "company_id": C1,
         "campaign_id": "cmp1", "provider_status": "bounced"},
        {"sent_at": "2026-09-01T01:00:00+00:00", "company_id": C1, "campaign_id": "cmp1",
         "provider_status": "delivered"},
    ]
    adapted = adapt_all(outbounds)
    res = replay(adapted["events"])
    report = reconcile(res, outbound_records=outbounds, company_id=C1,
                       legacy_unverified=adapted["stats"]["legacy_unverified"])

    old = old_metrics(outbounds, [], None, company_id=C1)
    assert old["sent"] == 3, "旧口径就是 outbound 记录数"
    assert report["new"]["sent"] == 2, "新口径只数 provider accepted"
    assert report["diff"][0]["metric"] == "sent"
    assert report["diff"][0]["delta"] == -1
    assert report["diff"][0]["reason"]
    assert report["not_counted"]["legacy_unverified"]["count"] == 1

    md = render_markdown(report)
    assert "指标差异" in md and "未计入原因" in md


# ── 旧数据 Adapter（目录读取 + 幂等）─────────────────────
def test_adapter_reads_legacy_dir_and_is_idempotent():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "email-facts"
        (root / "outbound" / C1 / "2026-09").mkdir(parents=True)
        (root / "inbound" / C1 / "2026-09").mkdir(parents=True)
        (root / "delivery-events").mkdir(parents=True)

        def snap(rec):
            return "# DealClaw Email Fact\n\n" + json.dumps(rec, ensure_ascii=False) + "\n"

        (root / "outbound" / C1 / "2026-09" / "a.md").write_text(snap({
            "resend_id": "r1", "sent_at": "2026-09-01T01:00:00+00:00",
            "company_id": C1, "campaign_id": "cmp1", "provider_status": "delivered",
            "smtp_message_id": "smtp1",
        }), encoding="utf-8")
        (root / "inbound" / C1 / "2026-09" / "b.md").write_text(snap({
            "resend_received_id": "in1", "message_id": "mid1", "received_at":
            "2026-09-02T01:00:00+00:00", "company_id": C1, "campaign_id": "cmp1",
            "in_reply_to": "smtp1", "binding_status": "unmatched",
        }), encoding="utf-8")
        (root / "delivery-events" / "2026-09-01.md").write_text(json.dumps({
            "event_id": "d1", "event_type": "delivered", "resend_id": "r1",
            "created_at": "2026-09-01T01:00:05+00:00"}) + "\n", encoding="utf-8")

        first = load_legacy_from_dir(root)
        second = load_legacy_from_dir(root)
        assert first["stats"]["events_out"] == second["stats"]["events_out"]
        assert first["stats"]["legacy_unverified"] == 0

        res = replay(first["events"])
        m = metrics_view(res, company_id=C1)
        assert m["sent"] == 1
        assert m["delivered_final"] == 1
        assert m["inbound_messages"] == 1, "In-Reply-To 命中 smtp_message_id → 强引用"
        assert m["legacy_unverified"] == 0


# ── 导出包不含 PII / 正文 / 配置 ─────────────────────────
def test_diagnostic_export_has_no_pii():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "export_email_diagnostic", str(ROOT / "export-email-diagnostic.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "email-facts"
        (root / "outbound" / C1 / "2026-09").mkdir(parents=True)
        (root / "outbound" / C1 / "2026-09" / "a.md").write_text(
            "# DealClaw Email Fact\n\n" + json.dumps({
                "resend_id": "r1", "sent_at": "2026-09-01T01:00:00+00:00",
                "company_id": C1, "campaign_id": "cmp1", "provider_status": "delivered",
                "recipients": ["buyer@example.com"], "subject": "SECRET SUBJECT",
                "text": "SECRET BODY", "sender": "me@dealclaw.io",
            }, ensure_ascii=False) + "\n", encoding="utf-8")

        payload = mod.build_export(tmp, company_id=C1)
        blob = json.dumps(payload, ensure_ascii=False)
        assert "buyer@example.com" not in blob
        assert "SECRET SUBJECT" not in blob and "SECRET BODY" not in blob
        assert "me@dealclaw.io" not in blob
        assert payload["metrics"]["sent"] == 1
        assert payload["source"]["mode"] == "read_only"


ALL_TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]


def main() -> int:
    failed = []
    for fn in ALL_TESTS:
        try:
            fn()
            print(f"PASS  {fn.__name__}")
        except AssertionError as e:
            failed.append((fn.__name__, f"AssertionError: {e}"))
            print(f"FAIL  {fn.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            failed.append((fn.__name__, f"{type(e).__name__}: {e}"))
            print(f"ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(ALL_TESTS) - len(failed)}/{len(ALL_TESTS)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
