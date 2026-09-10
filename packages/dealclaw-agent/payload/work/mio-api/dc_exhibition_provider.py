#!/usr/bin/env python3
"""dc_exhibition_provider.py — ExhibitionProvider（展会五阶段 result/action/risk/insight）

按当前展会阶段（profiling → planning → inviting → live → followup）输出：
  - result  阶段事实（画像/方案 / 邀约进度 / 到场·会议 / 闭展汇总）
  - action  阶段该做的事（阶段目标 + 客户级现场/再激活动作）
  - risk    数据质量（未同步不得报 0）、邀约拒绝/联系不上
  - insight 阶段摘要

规则（对应需求 1-8）：
  1. 读本届展会 meta、阶段、邀约、到场、会议、数据同步状态。
  2. 按五阶段输出阶段化四类 item。
  3. 只允许本届展会买家进入候选（exhibition_id == 本届），线索池不扩充范围。
  4. 展前专项卡已提醒的内容早报只摘要；逾期或状态变化仍允许进入重点。
  5. 开展后停止展前进度提醒，切换到到场/会议/现场承诺。
  6. 闭展后未到场买家转「未会面再激活」，不生成二次邀约。
  7. 数据未同步不得报 0 家，必须输出数据质量风险。
  8. 与 OpportunityProvider 重复时保留证据更完整的客户级 action（见 dc_daily_pipeline）。

纯函数 + 可注入 store：不发送、不写外部接口；collect() 只读 memory。
"""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from dc_daily_brief import (
    BriefItem, BriefContext, ProviderResult, CompletionRule,
    EvidenceRef, FactRef, TargetRef,
    make_item_key, make_action_key, make_dedupe_key, normalize_targets,
)

# 阶段（与 dc_exhibition_stage.STAGES 一致）
STAGES = ("profiling", "planning", "inviting", "live", "followup")
STAGE_LABELS = {
    "profiling": "画像", "planning": "制定获客方案", "inviting": "邀约中",
    "live": "展中对接", "followup": "展后跟进",
}
# 到场状态（对齐 getInvitationByPage isCheckIn）
CHECKIN_ARRIVED = 1
CHECKIN_PENDING = 2
CHECKIN_NOT_ARRIVED = 3
# 邀约状态（inviationState）
INV_UNREACHABLE = 2
INV_REJECTED = 3

DEFAULT_TZ = "Asia/Shanghai"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso_to_utc(iso) -> float | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


def _has(v) -> bool:
    if v is None:
        return False
    if isinstance(v, bool):
        return v is True
    if isinstance(v, (int, float)):
        return v != 0
    return str(v).strip() not in ("", "0", "false", "False", "none", "None")


def _int(v, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _exh_id(e: dict) -> str:
    return str((e or {}).get("exhibition_id") or (e or {}).get("id") or (e or {}).get("sourceId") or "")


def _local_date(now_utc: datetime, tz: str):
    try:
        return now_utc.astimezone(ZoneInfo(tz or DEFAULT_TZ)).date().isoformat()
    except Exception:  # noqa: BLE001
        return now_utc.astimezone(timezone.utc).date().isoformat()


# ── 当前展会解析（跨时区）───────────────────────────────────
def resolve_current_exhibition(meta: dict, now_utc: datetime | None = None) -> dict | None:
    """解析本届展会：优先窗口内含当前时间；否则最近的未来一届；否则最近结束一届。

    日期比较在展会时区进行（跨时区安全）。
    """
    now = now_utc or datetime.now(timezone.utc)
    exhibitions = [e for e in (meta or {}).get("exhibitions", []) if isinstance(e, dict)]
    if not exhibitions:
        return None
    enriched = []
    for e in exhibitions:
        tz = e.get("timezone") or meta.get("timezone") or DEFAULT_TZ
        today = _local_date(now, tz)
        start = str(e.get("start") or "")[:10]
        end = str(e.get("end") or e.get("start") or "")[:10]
        enriched.append({"exh": e, "today": today, "start": start, "end": end})

    for row in enriched:  # 窗口内
        if row["start"] and row["end"] and row["start"] <= row["today"] <= row["end"]:
            return {**row["exh"], "_phase": "live"}
    future = [r for r in enriched if r["start"] and r["start"] > r["today"]]
    if future:
        r = min(future, key=lambda x: x["start"])
        return {**r["exh"], "_phase": "upcoming"}
    past = [r for r in enriched if r["end"] and r["end"] <= r["today"]]
    if past:
        r = max(past, key=lambda x: x["end"])
        return {**r["exh"], "_phase": "finished"}
    return {**enriched[0]["exh"], "_phase": "upcoming"}


def resolve_stage(meta: dict, exh: dict | None, now_utc: datetime | None = None) -> str:
    """阶段 = meta.exhibition_stage；日期兜底（开展→live，闭展→followup）。"""
    stage = (meta or {}).get("exhibition_stage") or "profiling"
    if stage not in STAGES:
        stage = "profiling"
    if exh:
        phase = exh.get("_phase")
        if phase == "live" and stage in ("profiling", "planning", "inviting"):
            return "live"
        if phase == "finished" and stage in ("profiling", "planning", "inviting", "live"):
            return "followup"
    return stage


# ── 默认数据源 ──────────────────────────────────────────────
class ExhibitionMemoryStore:
    def read_meta(self, company_id: str) -> dict:
        from dc_exhibition_stage import read_meta
        return read_meta(company_id) or {}

    def list_invitations(self, company_id: str, exhibition_id: str = "") -> list[dict]:
        import json
        from pathlib import Path
        p = (Path(__file__).resolve().parents[2] / "data" / "memory" / str(company_id)
             / "exhibition-invitations.json")
        if not p.exists():
            return []
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        invs = data.get("invitations", data if isinstance(data, list) else [])
        return [i for i in invs if isinstance(i, dict)]

    def list_interactions(self, company_id: str) -> list[dict]:
        from dc_memory_data import read_interactions
        return read_interactions(company_id) or []

    def read_sync(self, company_id: str, exhibition_id: str = "") -> dict:
        import json
        from pathlib import Path
        p = (Path(__file__).resolve().parents[2] / "data" / "memory" / str(company_id)
             / "exhibition-sync.json")
        if not p.exists():
            return {}
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}


# ── 本届范围门禁（规则 3）──────────────────────────────────
def in_scope(inv: dict, exhibition_id: str) -> bool:
    """只有 exhibition_id == 本届的买家进入候选；无 exhibition_id 视为不在范围。"""
    if not exhibition_id:
        return False
    return str(inv.get("exhibitionId") or inv.get("exhibition_id") or "") == str(exhibition_id)


def is_suppressed(inv: dict) -> bool:
    st = _int(inv.get("inviationState") or inv.get("invitation_state"), 0)
    return st in (INV_REJECTED, INV_UNREACHABLE)


def has_meeting(inv: dict, interactions: list, customer_id: str = "") -> bool:
    if _int(inv.get("isMeeting") or inv.get("is_meeting"), 0) == 1:
        return True
    for it in interactions:
        if not isinstance(it, dict):
            continue
        ch = str(it.get("channel") or it.get("source") or "").lower()
        if "meeting" not in ch:
            continue
        if customer_id and str(it.get("customer_id") or "") not in ("", customer_id):
            continue
        if _has(it.get("summary")) or it.get("signals"):
            return True
    return False


def _sync_ready(sync: dict, exh: dict | None) -> tuple[bool, str]:
    """数据就绪判断（与 dc_after_exhibition_push.is_data_ready 同口径）。"""
    if not sync:
        return False, "no_sync_data"
    if sync.get("api_error"):
        return False, "api_error"
    status = sync.get("status") or ""
    if status in ("error", "syncing", "incomplete") or sync.get("sync_incomplete"):
        return False, f"sync_status_{status or 'incomplete'}"
    if sync.get("stale") or status == "stale":
        return False, "stale_cache"
    exh = exh or {}
    target = _exh_id(exh)
    sid = str(sync.get("exhibition_id") or "")
    if target and sid and target != sid:
        return False, "exhibition_id_mismatch"
    end_ts = _parse_iso_to_utc(exh.get("end"))
    through = _parse_iso_to_utc(sync.get("synced_through"))
    if end_ts and through and through < end_ts:
        return False, "synced_through_before_end"
    if _int(sync.get("records"), 0) == 0 and status != "completed_empty":
        return False, "zero_records_not_completed_empty"
    return True, ("completed_empty" if _int(sync.get("records"), 0) == 0 else "ready")


class ExhibitionProvider:
    """按展会阶段输出 result/action/risk/insight（只输出事实与候选 action）。"""
    name = "exhibition"

    def __init__(self, store=None, reminded_keys=()):
        self._store = store
        self._reminded = {k for k in (reminded_keys or ()) if k}

    def _get_store(self):
        return self._store if self._store is not None else ExhibitionMemoryStore()

    def collect(self, context: BriefContext) -> ProviderResult:
        try:
            store = self._get_store()
            meta = store.read_meta(context.company)
            exh = resolve_current_exhibition(meta)
            stage = resolve_stage(meta, exh)
            exh_id = _exh_id(exh) if exh else ""
            invitations = store.list_invitations(context.company, exh_id) if exh_id else []
            interactions = store.list_interactions(context.company)
        except Exception as e:  # noqa: BLE001
            return ProviderResult(name=self.name, items=[], updated_at="",
                                  warnings=[], errors=[f"{type(e).__name__}: {e}"])

        scoped = [i for i in invitations if in_scope(i, exh_id)]
        # 规则 7：报计数前先校验数据同步状态（未就绪 → 不报 0，输出数据质量风险）
        sync: dict = {}
        if stage in ("inviting", "live", "followup"):
            try:
                sync = store.read_sync(context.company, exh_id)
            except Exception:  # noqa: BLE001
                sync = {}
        data_ready, _sync_reason = _sync_ready(sync, exh)

        items: list[BriefItem] = []
        warnings: list[str] = []
        now_ts = datetime.now(timezone.utc)
        items.append(self._make_result(context, stage, exh, scoped, interactions, data_ready))
        items += self._make_actions(context, stage, exh, scoped, interactions, now_ts)
        items += self._make_risks(context, stage, exh, scoped, meta, sync, data_ready, _sync_reason)
        items.append(self._make_insight(context, stage, exh, scoped))
        return ProviderResult(name=self.name, items=items, updated_at=_now_iso(),
                              warnings=warnings, errors=[])

    # ── result：阶段事实 ────────────────────────────────
    def _make_result(self, context, stage, exh, scoped, interactions, data_ready) -> BriefItem:
        exh_id = _exh_id(exh) if exh else "none"
        counts = _count_buyers(scoped, interactions)
        if not data_ready and stage in ("inviting", "live", "followup"):
            # 规则 7：数据未同步不得报 0
            title = f"{STAGE_LABELS[stage]}：本届数据未同步，暂不报计数"
            return BriefItem(
                item_key=make_item_key(tenant=context.tenant, company=context.company,
                                       scope=exh_id, kind="result", source="exhibition",
                                       category="metrics", business_id="metrics", occurrence="1"),
                kind="result",
                dedupe_key=make_dedupe_key(source="exhibition", category="metrics", scope=exh_id,
                                           business_id="metrics", occurrence="1"),
                source="exhibition", scope=exh_id, category="metrics", priority="match",
                title=title,
                reason_facts=[FactRef(fact_id="data_ready", kind="text", value="false")],
                reason=f"本届数据未就绪，{STAGE_LABELS[stage]}计数不完整，不作 0 家结论",
                target_refs=[],
                evidence_refs=[EvidenceRef(type="query", source="exhibition_sync", id=exh_id,
                                           missing="数据未同步")],
                due_at=None, detail={"stage": stage, "data_ready": False},
                completion_rule=None, action_key=None, policy_version=None,
            )
        if stage in ("profiling", "planning"):
            title = f"展会阶段：{STAGE_LABELS[stage]}"
            facts = [FactRef(fact_id="stage", kind="text", value=stage)]
            detail = {"stage": stage}
        elif stage == "inviting":
            title = f"邀约 {counts['invited']} · 拒绝 {counts['rejected']} · 联系不上 {counts['unreachable']}"
            facts = [FactRef(fact_id="invited", kind="number", value=counts["invited"]),
                     FactRef(fact_id="rejected", kind="number", value=counts["rejected"])]
            detail = counts
        elif stage == "live":
            title = (f"到展 {counts['arrived']} · 会议 {counts['meeting']} · "
                     f"未到展 {counts['not_arrived']}")
            facts = [FactRef(fact_id="arrived", kind="number", value=counts["arrived"]),
                     FactRef(fact_id="meeting", kind="number", value=counts["meeting"]),
                     FactRef(fact_id="not_arrived", kind="number", value=counts["not_arrived"])]
            detail = counts
        else:  # followup
            title = (f"闭展：到展 {counts['arrived']} · 未到场 {counts['not_arrived']} · "
                     f"可再激活 {counts['reactivatable']}")
            facts = [FactRef(fact_id="arrived", kind="number", value=counts["arrived"]),
                     FactRef(fact_id="not_arrived", kind="number", value=counts["not_arrived"]),
                     FactRef(fact_id="reactivatable", kind="number", value=counts["reactivatable"])]
            detail = counts
        return BriefItem(
            item_key=make_item_key(tenant=context.tenant, company=context.company, scope=exh_id,
                                   kind="result", source="exhibition", category="metrics",
                                   business_id="metrics", occurrence="1"),
            kind="result",
            dedupe_key=make_dedupe_key(source="exhibition", category="metrics", scope=exh_id,
                                       business_id="metrics", occurrence="1"),
            source="exhibition", scope=exh_id, category="metrics", priority="match",
            title=title, reason_facts=facts, reason=title, target_refs=[],
            evidence_refs=[EvidenceRef(type="snapshot", source="exhibition_meta", id=exh_id)],
            due_at=None, detail={"stage": stage, **detail},
            completion_rule=None, action_key=None, policy_version=None,
        )

    # ── action：阶段该做的事 + 客户级现场动作 ────────────
    def _make_actions(self, context, stage, exh, scoped, interactions, now_ts) -> list[BriefItem]:
        exh_id = _exh_id(exh) if exh else "none"
        out: list[BriefItem] = []
        stage_action = self._stage_action(context, stage, exh, exh_id, now_ts)
        if stage_action is not None:
            out.append(stage_action)

        if stage == "live":
            # 规则 5：停止展前进度提醒，切换到到场/会议/现场承诺
            for b in scoped:
                if is_suppressed(b):
                    continue
                if _int(b.get("isCheckIn") or b.get("is_checkin"), 0) != CHECKIN_ARRIVED:
                    continue
                cdp = str(b.get("companyCdpId") or b.get("company_cdp_id") or "")
                meeting = has_meeting(b, interactions, cdp)
                self._append_buyer_action(out, context, exh_id, b, cdp,
                                          "onsite_followup" if meeting else "missed_meeting_reengage",
                                          "commitment" if meeting else "deadline")
        elif stage == "followup":
            # 规则 6：未到场 → 未会面再激活（不生成二次邀约）
            for b in scoped:
                if is_suppressed(b):
                    continue
                ck = _int(b.get("isCheckIn") or b.get("is_checkin"), 0)
                if ck == CHECKIN_ARRIVED:
                    continue
                cdp = str(b.get("companyCdpId") or b.get("company_cdp_id") or "")
                self._append_buyer_action(out, context, exh_id, b, cdp,
                                          "reactivate_no_meeting", "deadline")
        return out

    def _stage_action(self, context, stage, exh, exh_id, now_ts) -> BriefItem | None:
        """阶段目标 action：完成条件 = 阶段推进（signal_resolved）。"""
        goals = {
            "profiling": "锁定第一推荐产品（画像）",
            "planning": "产出获客方案（买家类型+邀约方向+沟通策略）",
            "inviting": "推进邀约，确认到展",
            "live": "现场跟进：会议纪要与现场承诺",
            "followup": "展后跟进：未会面买家再激活",
        }
        title = goals[stage]
        signal_id = f"stage:{exh_id}:{stage}"
        item = BriefItem(
            item_key=make_item_key(tenant=context.tenant, company=context.company, scope=exh_id,
                                   kind="action", source="exhibition", category=f"stage_{stage}",
                                   business_id=signal_id, occurrence="1"),
            kind="action",
            dedupe_key=make_dedupe_key(source="exhibition", category=f"stage_{stage}",
                                       scope=exh_id, business_id=signal_id, occurrence="1"),
            source="exhibition", scope=exh_id, category=f"stage_{stage}", priority="deadline",
            title=title,
            reason_facts=[FactRef(fact_id="stage", kind="text", value=stage)],
            reason=f"当前阶段「{STAGE_LABELS[stage]}」，阶段目标：{title}",
            target_refs=[TargetRef(type="exhibition", id=exh_id)],
            evidence_refs=[EvidenceRef(type="snapshot", source="exhibition_meta", id=exh_id)],
            due_at=now_ts.isoformat(), detail={"stage": stage, "stage_goal": True},
            completion_rule=CompletionRule(type="signal_resolved",
                                           params={"signal_id": signal_id}, expected_count=1),
            action_key=make_action_key(tenant=context.tenant, company=context.company,
                                       scope=exh_id, opportunity=f"stage:{exh_id}",
                                       action_type=f"stage_{stage}", target_id=exh_id,
                                       occurrence="1"),
            policy_version=None,
        )
        # 规则 4：展前专项卡已提醒且未逾期/无状态变化 → 早报只摘要（降为 insight）
        if item.dedupe_key in self._reminded and not self._is_changed(item, now_ts):
            item.kind = "insight"
            item.detail["reminded"] = True
            item.completion_rule = None
            item.action_key = None
        return item

    @staticmethod
    def _is_changed(item: BriefItem, now_ts: datetime | None = None) -> bool:
        """逾期或状态变化 → 仍允许进入重点。"""
        now_ts = now_ts or datetime.now(timezone.utc)
        due = _parse_iso_to_utc(item.due_at)
        overdue = due is not None and due < now_ts.timestamp()
        return overdue or bool(item.detail.get("state_changed"))

    def _append_buyer_action(self, out, context, exh_id, inv, cdp, action_type, priority):
        company = str(inv.get("companyName") or inv.get("company") or cdp or "")
        buyer_email = str(inv.get("email") or inv.get("contact") or "")
        target = cdp or company or exh_id
        reason = {
            "onsite_followup": f"{company} 已到场且有会议/商洽证据，匹配会议记录跟进",
            "missed_meeting_reengage": f"{company} 已到场但无会议证据，再触达约见面",
            "reactivate_no_meeting": f"{company} 本届未到场，转未会面再激活",
        }[action_type]
        refs = [EvidenceRef(type="record", source="invitation", id=cdp or company)]
        if buyer_email:
            refs.append(EvidenceRef(type="record", source="invitation_contact", id=buyer_email))
        out.append(BriefItem(
            item_key=make_item_key(tenant=context.tenant, company=context.company, scope=exh_id,
                                   kind="action", source="exhibition", category=action_type,
                                   business_id=normalize_targets([target]), occurrence="1"),
            kind="action",
            dedupe_key=make_dedupe_key(source="exhibition", category=action_type, scope=exh_id,
                                       business_id=normalize_targets([target]), occurrence="1"),
            source="exhibition", scope=exh_id, category=action_type, priority=priority,
            title=f"{_label(action_type)} {company}",
            reason_facts=[FactRef(fact_id="company", kind="entity", value=company),
                          FactRef(fact_id="checkin", kind="number",
                                  value=_int(inv.get("isCheckIn") or inv.get("is_checkin"), 0))],
            reason=reason,
            target_refs=[TargetRef(type="buyer", id=buyer_email or target)],
            evidence_refs=refs, due_at=_now_iso(),
            detail={"customer_id": cdp, "company": company, "buyer_email": buyer_email,
                    "invitation": True},
            completion_rule=CompletionRule(type="followup_sent",
                                           params={"target_ids": [buyer_email or target]},
                                           expected_count=1),
            action_key=make_action_key(tenant=context.tenant, company=context.company,
                                       scope=exh_id, opportunity=cdp or exh_id,
                                       action_type=action_type, target_id=target, occurrence="1"),
            policy_version=None,
        ))

    # ── risk：数据质量 / 邀约风险 ───────────────────────
    def _make_risks(self, context, stage, exh, scoped, meta, sync, data_ready, sync_reason) -> list[BriefItem]:
        exh_id = _exh_id(exh) if exh else "none"
        out: list[BriefItem] = []
        # 画像/方案阶段：未完成 → 进度风险
        if stage == "profiling" and not (meta or {}).get("understanding_done"):
            out.append(self._risk_item(
                context, exh_id, "stage_gap", "画像未完成",
                [FactRef(fact_id="understanding_done", kind="text", value="false")],
                "第一推荐产品尚未锁定，方案依据不足",
                EvidenceRef(type="snapshot", source="exhibition_meta", id=exh_id)))
        if stage == "planning" and not (meta or {}).get("plan_done"):
            out.append(self._risk_item(
                context, exh_id, "stage_gap", "获客方案未完成",
                [FactRef(fact_id="plan_done", kind="text", value="false")],
                "获客方案未产出，邀约方向未定",
                EvidenceRef(type="snapshot", source="exhibition_meta", id=exh_id)))
        # 规则 7：数据未同步 → 数据质量风险（不得报 0）
        if stage in ("inviting", "live", "followup") and not data_ready:
            out.append(self._risk_item(
                context, exh_id, "data_quality", "数据质量风险：本届数据未就绪",
                [FactRef(fact_id="sync_reason", kind="text", value=sync_reason)],
                f"本届数据未同步/未完成（{sync_reason}），到场与邀约数据不完整，不作 0 家结论",
                EvidenceRef(type="query", source="exhibition_sync", id=exh_id,
                            missing=sync_reason)))
        # 邀约风险：拒绝 / 联系不上
        for b in scoped:
            st = _int(b.get("inviationState") or b.get("invitation_state"), 0)
            if st not in (INV_REJECTED, INV_UNREACHABLE):
                continue
            company = str(b.get("companyName") or b.get("company") or b.get("companyCdpId") or "")
            label = "已拒绝" if st == INV_REJECTED else "联系不上"
            out.append(self._risk_item(
                context, exh_id, "invitation", f"邀约{label}：{company}",
                [FactRef(fact_id="inviationState", kind="number", value=st)],
                f"{company} 邀约状态「{label}」，停止主动触达",
                EvidenceRef(type="record", source="invitation",
                            id=str(b.get("companyCdpId") or company))))
        return out

    def _risk_item(self, context, scope, category, title, facts, reason, evidence) -> BriefItem:
        return BriefItem(
            item_key=make_item_key(tenant=context.tenant, company=context.company, scope=scope,
                                   kind="risk", source="exhibition", category=category,
                                   business_id=title, occurrence="1"),
            kind="risk",
            dedupe_key=make_dedupe_key(source="exhibition", category=category, scope=scope,
                                       business_id=title, occurrence="1"),
            source="exhibition", scope=scope, category=category, priority="match",
            title=title, reason_facts=facts, reason=reason, target_refs=[],
            evidence_refs=[evidence], due_at=None, detail={},
            completion_rule=None, action_key=None, policy_version=None,
        )

    # ── insight：阶段摘要 ──────────────────────────────
    def _make_insight(self, context, stage, exh, scoped) -> BriefItem:
        exh_id = _exh_id(exh) if exh else "none"
        name = str((exh or {}).get("name") or exh_id)
        text = f"本届展会「{name}」当前阶段：{STAGE_LABELS[stage]}"
        return BriefItem(
            item_key=make_item_key(tenant=context.tenant, company=context.company, scope=exh_id,
                                   kind="insight", source="exhibition", category="insight",
                                   business_id="insight", occurrence="1"),
            kind="insight",
            dedupe_key=make_dedupe_key(source="exhibition", category="insight", scope=exh_id,
                                       business_id="insight", occurrence="1"),
            source="exhibition", scope=exh_id, category="insight", priority="match",
            title=text, reason_facts=[FactRef(fact_id="insight", kind="text", value=text)],
            reason=text, target_refs=[],
            evidence_refs=[EvidenceRef(type="snapshot", source="exhibition_meta", id=exh_id)],
            due_at=None, detail={"stage": stage}, completion_rule=None, action_key=None,
            policy_version=None,
        )


def _label(action_type: str) -> str:
    return {"onsite_followup": "现场跟进", "missed_meeting_reengage": "再触达约见面",
            "reactivate_no_meeting": "未会面再激活"}.get(action_type, action_type)


def _count_buyers(scoped: list, interactions: list) -> dict:
    invited = len(scoped)
    arrived = 0
    not_arrived = 0
    meeting = 0
    rejected = 0
    unreachable = 0
    reactivatable = 0
    for b in scoped:
        ck = _int(b.get("isCheckIn") or b.get("is_checkin"), 0)
        st = _int(b.get("inviationState") or b.get("invitation_state"), 0)
        if st == INV_REJECTED:
            rejected += 1
        elif st == INV_UNREACHABLE:
            unreachable += 1
        if ck == CHECKIN_ARRIVED:
            arrived += 1
            if has_meeting(b, interactions, str(b.get("companyCdpId") or "")):
                meeting += 1
        else:
            not_arrived += 1
            if st not in (INV_REJECTED, INV_UNREACHABLE):
                reactivatable += 1
    return {"invited": invited, "arrived": arrived, "not_arrived": not_arrived,
            "meeting": meeting, "rejected": rejected, "unreachable": unreachable,
            "reactivatable": reactivatable}


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(description="ExhibitionProvider（调试）")
    ap.add_argument("--company", required=True)
    ap.add_argument("--tenant", default="meorient")
    ap.add_argument("--date", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    args = ap.parse_args()
    ctx = BriefContext(tenant=args.tenant, company=args.company, report_type="morning",
                       date=args.date, tz="Asia/Shanghai", as_of=_now_iso(),
                       window_start="", window_end="")
    res = ExhibitionProvider().collect(ctx)
    print(json.dumps({"errors": res.errors,
                      "items": [{"kind": i.kind, "title": i.title, "priority": i.priority}
                                for i in res.items]}, ensure_ascii=False, indent=2))
