#!/usr/bin/env python3
"""dc_email_provider.py — EmailProvider + 最小运行编排 + 模板 Advisor

EmailProvider 从 EmailStore/email-facts 读取真实数据，输出四类 BriefItem：
  - result:  今日发送/送达/退信/回复统计
  - action:  跟进动作（超过等待期仍未回复才生成；仍在观察期不下结论）
  - risk:    退信（无效邮箱）
  - insight: 经营洞察（送达高但回复低 / 无数据等）

最小编排：
  - run_morning_brief: EmailProvider → 去重排序 → build_plan(top3) → write_plan → plan.json
  - run_evening_brief: 读 plan.json → 依据真实 inbound reply 事件核销 → review_plan → review.json

模板 Advisor（不接真实 LLM）：把候选 action 用模板转成 Advice。

范围约束：不发送邮件、不接定时任务、不开发其他 Provider。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dc_daily_brief import (
    BriefItem, BriefContext, ProviderResult, CompletionRule, EvidenceRef, FactRef, TargetRef,
    make_item_key, make_action_key, make_dedupe_key, normalize_targets,
    sort_items, dedupe_actions, build_plan, write_plan, review_plan,
    safe_memory_dir, atomic_write_json,
)
from dc_daily_advisor import AdvisorSnapshot, ProposedAction, Advice, build_snapshot

# 统一读入口（口径由 email_metrics.config 决定，默认 legacy = 线上行为不变）
from email_metrics import legacy as legacy_adapter
from email_metrics.service import STATUS_UNAVAILABLE, read_email_metrics


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso_to_utc(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


def _iso_add_days(iso: str, days: int) -> str:
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (dt + timedelta(days=days)).isoformat()
    except (ValueError, TypeError):
        return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


# 与 dc_followup 对齐（默认值，环境变量可覆盖）
FOLLOWUP_DUE_DAYS = 2
FOLLOWUP_MAX_ROUNDS = 3
_STOP_STATUSES = {"bounced", "complained", "failed"}


class EmailProvider:
    """从 EmailStore/email-facts 读数据，输出 result/action/risk/insight 四类 BriefItem。"""
    name = "email"

    def __init__(self, store=None, metrics=None, date=None, date_range=None):
        self._store = store
        self._metrics = metrics           # 复用上游已算好的口径结果（同一次计算、同一批数字）
        self._date = date                 # 缺省 None = 全部时间（保持旧可见语义）
        self._date_range = date_range

    def _get_store(self):
        if self._store is not None:
            return self._store
        from email_gateway.store import EmailStore
        return EmailStore()

    def _read_metrics(self, context, outbounds, inbounds):
        """统一口径读数（legacy / shadow / v1 三态由开关决定，消费方不自己聚合）。"""
        if self._metrics is not None:
            return self._metrics
        metrics = read_email_metrics(
            company_id=context.company, tenant=getattr(context, "tenant", None),
            date=self._date, date_range=self._date_range,
            report_timezone=getattr(context, "tz", None),
            outbound_records=outbounds, inbound_records=inbounds,
            consumer="email_provider",
        )
        # 旧口径的「回复」= 入站消息数（字段名已兼容）；v1 口径走 metrics_view 的唯一回复买家
        if metrics.get("legacy") is not None:
            metrics["legacy"]["replied"] = metrics["legacy"]["inbound_messages"]
        return metrics

    def collect(self, context: BriefContext) -> ProviderResult:
        try:
            store = self._get_store()
            outbounds = store.list_outbound_records(company_id=context.company)
            inbounds = store.list_inbound_records(company_id=context.company)
        except Exception as e:  # noqa: BLE001
            return ProviderResult(name=self.name, items=[], updated_at="",
                                  warnings=[], errors=[f"{type(e).__name__}: {e}"])

        self._metrics = self._read_metrics(context, outbounds, inbounds)
        items: list[BriefItem] = []
        items.append(self._make_result(context, outbounds, inbounds))
        items += self._make_actions(context, outbounds, inbounds)
        items += self._make_risks(context, outbounds)
        items.append(self._make_insight(context, outbounds, inbounds))
        return ProviderResult(name=self.name, items=items, updated_at=_now_iso(),
                              warnings=[], errors=[])

    # ── 四类 BriefItem ────────────────────────────────
    def _make_result(self, context, outbounds, inbounds) -> BriefItem:
        m = self._metrics or {}
        metrics = m.get("metrics") or {}
        sent, delivered = metrics.get("sent"), metrics.get("delivered")
        bounced, replied = metrics.get("bounced"), metrics.get("replied")
        status = m.get("status")
        if status == STATUS_UNAVAILABLE or sent is None:
            # 数据源不可用：绝不显示 0，显式标注原因（可下钻 evidence）
            reasons = "，".join(m.get("reasons") or []) or "数据源不可用"
            return BriefItem(
                item_key=make_item_key(tenant=context.tenant, company=context.company,
                                       scope="global", kind="result", source="email",
                                       category="metrics", business_id="metrics", occurrence="1"),
                kind="result",
                dedupe_key=make_dedupe_key(source="email", category="metrics", scope="global",
                                           business_id="metrics", occurrence="1"),
                source="email", scope="global", category="metrics", priority="match",
                title=f"邮件数据不可用（{reasons}）",
                reason_facts=[FactRef(fact_id="data_status", kind="text",
                                      value=str(status))],
                reason=f"邮件数据不可用：{reasons}",
                target_refs=[],
                evidence_refs=[EvidenceRef(type="query", source="email_metrics", id="unavailable",
                                           missing=reasons)],
                due_at=None,
                detail={"sent": None, "delivered": None, "bounced": None, "replied": None,
                        "data_status": status, "data_reasons": list(m.get("reasons") or [])},
                completion_rule=None, action_key=None, policy_version=None,
            )
        suffix = "（数据不完整）" if status == "partial" else ""
        facts = [
            FactRef(fact_id="sent", kind="number", value=sent),
            FactRef(fact_id="delivered", kind="number", value=delivered),
            FactRef(fact_id="bounced", kind="number", value=bounced),
            FactRef(fact_id="replied", kind="number", value=replied),
        ]
        return BriefItem(
            item_key=make_item_key(tenant=context.tenant, company=context.company, scope="global",
                                   kind="result", source="email", category="metrics",
                                   business_id="metrics", occurrence="1"),
            kind="result", dedupe_key=make_dedupe_key(source="email", category="metrics",
                                                      scope="global", business_id="metrics", occurrence="1"),
            source="email", scope="global", category="metrics", priority="match",
            title=f"发送 {sent} · 送达 {delivered} · 回复 {replied} · 退信 {bounced}{suffix}",
            reason_facts=facts,
            reason=f"发送 {sent} 封，送达 {delivered}，回复 {replied}，退信 {bounced}",
            target_refs=[], evidence_refs=[EvidenceRef(type="snapshot", source="email_facts",
                                                       id=f"{context.company}:outbound")],
            due_at=None, detail={"sent": sent, "delivered": delivered, "bounced": bounced,
                                 "replied": replied, "data_status": status,
                                 "data_reasons": list(m.get("reasons") or []),
                                 "mode": m.get("mode")},
            completion_rule=None, action_key=None, policy_version=None,
        )

    def _make_actions(self, context, outbounds, inbounds) -> list[BriefItem]:
        """跟进 action：delivered + 超过等待期仍无回复 + 未到最大轮次。仍在观察期不下结论（第 8 条）。

        无商机证据时，同级候选合并为「批量跟进」行动，不按读取顺序虚假选 Top3（待 OpportunityProvider 分层）。
        """
        overdue = self._collect_overdue(outbounds, inbounds)
        if not overdue:
            return []
        return [self._make_batch_followup(context, overdue)]

    def _collect_overdue(self, outbounds, inbounds) -> list[dict]:
        """收集「超过等待期仍无回复」的买家（观察期内的不下结论）。"""
        now_ts = datetime.now(timezone.utc).timestamp()
        overdue: list[dict] = []
        for ob in outbounds:
            if ob.get("provider_status") != "delivered":
                continue
            buyer_email = (ob.get("recipients") or [""])[0]
            if not buyer_email:
                continue
            if self._has_reply(ob, inbounds):
                continue
            touch = int(ob.get("touch_number", 0) or 0)
            next_touch = touch + 1
            if next_touch > FOLLOWUP_MAX_ROUNDS:
                continue
            sent_at = ob.get("sent_at") or ob.get("created_at", "")
            due_at = ob.get("followup_due_at") or _iso_add_days(sent_at, FOLLOWUP_DUE_DAYS)
            due_ts = _parse_iso_to_utc(due_at)
            if due_ts is None or now_ts < due_ts:
                continue  # 仍在观察期，禁止提前下结论
            overdue.append({
                "buyer_email": buyer_email, "next_touch": next_touch,
                "due_at": due_at, "resend_id": ob.get("resend_id", ""),
            })
        return overdue

    def _make_batch_followup(self, context, overdue: list[dict]) -> BriefItem:
        """把无商机证据的同级候选合并为一个批量跟进行动（completion_rule=followup_sent）。"""
        target_ids = [b["buyer_email"] for b in overdue]
        n = len(overdue)
        action_key = make_action_key(
            tenant=context.tenant, company=context.company, scope="global",
            opportunity="global", action_type="followup",
            target_id=normalize_targets(target_ids), occurrence="1",
        )
        due_times = [b["due_at"] for b in overdue if b["due_at"]]
        due_at = min(due_times) if due_times else None
        return BriefItem(
            item_key=make_item_key(tenant=context.tenant, company=context.company, scope="global",
                                   kind="action", source="email", category="followup",
                                   business_id=normalize_targets(target_ids), occurrence="1"),
            kind="action",
            dedupe_key=make_dedupe_key(source="email", category="followup", scope="global",
                                       business_id=normalize_targets(target_ids), occurrence="1"),
            source="email", scope="global", category="followup", priority="overdue",
            title=f"跟进 {n} 家（待商机分层）",
            reason_facts=[FactRef(fact_id="overdue_count", kind="number", value=n),
                          FactRef(fact_id="wait_state", kind="text", value="超过观察期仍无回复")],
            reason=f"{n} 家送达超过观察期仍无回复，待 OpportunityProvider 分层后确定跟进优先级",
            target_refs=[TargetRef(type="buyer", id=t) for t in target_ids],
            evidence_refs=[EvidenceRef(type="snapshot", source="email_facts",
                                       id=f"{context.company}:outbound")],
            due_at=due_at,
            detail={"overdue_count": n, "buyer_emails": target_ids, "pending_layering": True},
            completion_rule=CompletionRule(type="followup_sent",
                                           params={"target_ids": target_ids}, expected_count=n),
            action_key=action_key, policy_version=None,
        )

    def _make_risks(self, context, outbounds) -> list[BriefItem]:
        """risk：退信 → 无效邮箱。"""
        items: list[BriefItem] = []
        for ob in outbounds:
            if ob.get("provider_status") != "bounced":
                continue
            buyer_email = (ob.get("recipients") or [""])[0]
            resend_id = ob.get("resend_id", "")
            items.append(BriefItem(
                item_key=make_item_key(tenant=context.tenant, company=context.company, scope="global",
                                       kind="risk", source="email", category="invalid_email",
                                       business_id=resend_id or buyer_email, occurrence="1"),
                kind="risk",
                dedupe_key=make_dedupe_key(source="email", category="invalid_email", scope="global",
                                           business_id=buyer_email, occurrence="1"),
                source="email", scope="global", category="invalid_email", priority="match",
                title=f"退信：{buyer_email}",
                reason_facts=[FactRef(fact_id="buyer_email", kind="entity", value=buyer_email)],
                reason=f"{buyer_email} 邮箱退信，建议标无效、换联系人",
                target_refs=[TargetRef(type="buyer", id=buyer_email)],
                evidence_refs=[EvidenceRef(type="record", source="email_facts", id=resend_id or buyer_email)],
                due_at=None, detail={"resend_id": resend_id},
                completion_rule=None, action_key=None, policy_version=None,
            ))
        return items

    def _make_insight(self, context, outbounds, inbounds) -> BriefItem:
        """只输出事实，不含原因推断（推断在 Template Advisor 层，标低置信度假设）。"""
        m = self._metrics or {}
        metrics = m.get("metrics") or {}
        sent, delivered = metrics.get("sent"), metrics.get("delivered")
        bounced, replied = metrics.get("bounced"), metrics.get("replied")
        if m.get("status") == STATUS_UNAVAILABLE or sent is None:
            reasons = "，".join(m.get("reasons") or []) or "数据源不可用"
            return self._insight(context, f"邮件数据不可用（{reasons}）",
                                 evidence=EvidenceRef(type="query", source="email_metrics",
                                                      id="unavailable", missing=reasons))
        overdue_count = len(self._collect_overdue(outbounds, inbounds))
        if sent == 0:
            return self._insight(context, "暂无发送记录",
                                 evidence=EvidenceRef(type="query", source="email_facts",
                                                      id=f"{context.company}:outbound", missing="无 outbound 记录"))
        if overdue_count > 0:
            return self._insight(context, f"{overdue_count} 家送达超过观察期仍无回复",
                                 evidence=EvidenceRef(type="snapshot", source="email_facts",
                                                      id=f"{context.company}:outbound"))
        if replied > 0:
            return self._insight(context, f"今日 {replied} 家回复",
                                 evidence=EvidenceRef(type="snapshot", source="email_facts",
                                                      id=f"{context.company}:outbound"))
        return self._insight(context, f"发送 {sent} 封，送达 {delivered}，退信 {bounced}",
                             evidence=EvidenceRef(type="snapshot", source="email_facts",
                                                  id=f"{context.company}:outbound"))

    def _insight(self, context, text: str, evidence: EvidenceRef) -> BriefItem:
        return BriefItem(
            item_key=make_item_key(tenant=context.tenant, company=context.company, scope="global",
                                   kind="insight", source="email", category="insight",
                                   business_id="insight", occurrence="1"),
            kind="insight", dedupe_key=make_dedupe_key(source="email", category="insight",
                                                       scope="global", business_id="insight", occurrence="1"),
            source="email", scope="global", category="insight", priority="match",
            title=text, reason_facts=[FactRef(fact_id="insight", kind="text", value=text)],
            reason=text, target_refs=[], evidence_refs=[evidence],
            due_at=None, detail={}, completion_rule=None, action_key=None, policy_version=None,
        )

    # ── 辅助 ───────────────────────────────────────────
    def _count_replied(self, inbounds) -> int:
        """旧口径「回复」= 入站消息数。字段名兼容走 Adapter：落盘是 `record_type`，
        历史代码读 `direction` → 恒 0（本次修掉的 bug）。"""
        return len([ib for ib in inbounds if legacy_adapter.is_inbound(ib, default=True)])

    def _has_reply(self, outbound, inbounds) -> bool:
        """已回复判定（字段名 / 引用兼容）。

        入站实测把 id 存在 `resend_received_id` 上，历史代码只读 `resend_id`
        → 待跟进虚高（本次修掉的 bug）。这里统一按 Adapter 的引用索引匹配：
        In-Reply-To / References / thread + 旧 id 兼容，匹配不到**不硬挂**。
        """
        replied_ids = set((self._metrics or {}).get("replied_outbound_ids") or [])
        ids = set(legacy_adapter.outbound_ids(outbound))
        if ids & replied_ids:
            return True
        if self._metrics is None:  # 未走统一读入口时退化为直接匹配
            return legacy_adapter.has_reply(outbound, [outbound], inbounds)
        return False


# ── 最小运行编排 ───────────────────────────────────────
def run_morning_brief(context: BriefContext, base_dir: Path, store=None) -> dict:
    """早报：EmailProvider → 去重排序 → build_plan(top3) → write_plan → plan.json。"""
    provider = EmailProvider(store=store)
    result = provider.collect(context)
    plan = build_plan(result.items, max_actions=3)
    d = safe_memory_dir(base_dir, context.tenant, context.company, context.date)
    plan = write_plan(d / "plan.json", plan)
    return {"plan": plan, "provider_errors": result.errors, "provider_warnings": result.warnings}


def run_evening_brief(context: BriefContext, base_dir: Path, store=None) -> dict:
    """晚报：读 plan.json → 依据真实「跟进已发送」事件核销 → review_plan → review.json。"""
    d = safe_memory_dir(base_dir, context.tenant, context.company, context.date)
    plan_path = d / "plan.json"
    if not plan_path.exists():
        return {"review": None, "error": "no plan.json"}
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    events = _collect_followup_events(context, plan, store)
    review = review_plan(plan, events)
    atomic_write_json(d / "review.json", review)
    return {"review": review}


def _collect_followup_events(context: BriefContext, plan: dict, store=None) -> list[dict]:
    """从 outbound 找已发送的跟进（touch_number >= 1），生成 followup_sent 真实事件。"""
    try:
        s = store or EmailProvider()._get_store()
        outbounds = s.list_outbound_records(company_id=context.company)
    except Exception:  # noqa: BLE001
        return []
    events = []
    for action in plan.get("actions", []):
        rule = action.get("completion_rule") or {}
        target_ids = set(rule.get("params", {}).get("target_ids", []))
        akey = action.get("action_key")
        for ob in outbounds:
            if int(ob.get("touch_number", 0) or 0) < 1:
                continue
            buyer_email = (ob.get("recipients") or [""])[0]
            if buyer_email in target_ids:
                events.append({
                    "action_key": akey,
                    "kind": "followup_sent",
                    "target_id": buyer_email,
                    "event_id": f"fs_{buyer_email}",
                    "occurred_at": ob.get("sent_at") or ob.get("created_at") or _now_iso(),
                })
    return events


# ── 模板 Advisor（不接真实 LLM）────────────────────────
def template_advise(snapshot: AdvisorSnapshot) -> tuple[Advice, ...]:
    """模板 Advisor：转 action，并对「送达无回复」提出低置信度验证性假设。"""
    advices: list[Advice] = []
    for cand in snapshot.candidates:
        if cand.kind != "action":
            continue
        fact_ids = tuple(f.fact_id for f in cand.reason_facts)
        advices.append(Advice(
            advice_key=f"adv_{cand.action_key}",
            claim=f"建议跟进：{cand.title}",
            evidence_refs=tuple(cand.evidence_refs),
            confidence="medium",
            confidence_reason="基于邮件送达与超过观察期的事实",
            assumptions=("买家仍在运营且未退订",),
            counter_evidence=(),
            limitations=("尚未接入 OpportunityProvider 分层",),
            recommendation=cand.reason,
            proposed_actions=(ProposedAction(
                proposal_id=f"proposal_{cand.action_key}",
                action_type="followup",
                scope=cand.scope,
                target_refs=tuple(cand.target_refs),
                reason=cand.reason,
                fact_refs=fact_ids,
            ),),
            action_refs=(cand.action_key,),
            fact_refs=fact_ids,
            reason_adjusted=None,
        ))

    result_item = next((c for c in snapshot.candidates if c.kind == "result"), None)
    if result_item and result_item.detail.get("delivered", 0) > 0 and result_item.detail.get("replied", 0) == 0:
        advices.append(Advice(
            advice_key="adv_email_no_reply_hypothesis",
            claim="送达但暂无回复，可能与邮件表达或买家匹配度有关",
            evidence_refs=tuple(result_item.evidence_refs),
            confidence="low",
            confidence_reason="缺少历史基线（打开率、回复率与文案 A/B），暂不能判断具体原因",
            assumptions=("单日送达无回复具有分析价值", "发送对象和邮件内容未发生其他异常"),
            counter_evidence=(),
            limitations=("缺少历史基线", "尚未接入 OpportunityProvider 商机分层"),
            recommendation="验证邮件主题/内容与买家匹配度，不直接执行发送",
            proposed_actions=(),
            action_refs=(),
            fact_refs=tuple(f.fact_id for f in result_item.reason_facts),
            reason_adjusted=None,
        ))
    return tuple(advices)
