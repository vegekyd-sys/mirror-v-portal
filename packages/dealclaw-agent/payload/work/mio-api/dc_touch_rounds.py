#!/usr/bin/env python3
"""
dc_touch_rounds.py — 多轮个性化触达轮次引擎（Mio 2026-09-17 客户需求）

一句话：把「发过信息没回复的买家，隔几天换个角度再触达一次，最多 3 轮，一回复就停」
变成产品里的可执行队列 + 早晚报 todo + 线索池可见状态。

职责（只读事实、只产出队列/草稿/文案，**从不自己发邮件**）：
  1. 轮次引擎：读 outbound（含 `touch_number`）+ inbound（是否回复）+ 线索池分层
     （「跟进优先级」）→ 产出「待触达队列」；
  2. 到期判定与 `dc_email_signals.evaluate_due` 对齐，`no_reply_due` 语义扩成
     「第 N 轮到期」（evidence 带 round/tier/cadence）；
  3. 早晚报「多轮触达」todo 区块渲染（早报 + 晚报，数量大时分批/汇总）；
  4. 每轮不同内容角度（配置化），复用现有草稿链生成 `pending_confirmation` 草稿；
  5. 线索池字段投影（**复用现有字段，不新增字段名**）。

参数集中在本文件「一、参数」段，可用环境变量覆盖，客户可调。

不发送、不推送、不改线索池远端、不新增字段名、不碰生产/k8s/cron/.env。

CLI:
  python3 dc_touch_rounds.py queue    --company-id <id> [--at ISO]
  python3 dc_touch_rounds.py render   --company-id <id> [--slot morning|evening]
  python3 dc_touch_rounds.py generate --company-id <id> [--tier T1] [--round 2] [--dry-run]
  python3 dc_touch_rounds.py due      --company-id <id> [--at ISO]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# ─────────────────────────────────────────────────────────────
# 一、参数（客户可调：集中定义；环境变量可覆盖）
# ─────────────────────────────────────────────────────────────

#: 轮次上限：R1 首触 / R2 / R3（EDM 数据显示 R2、R3 回复率显著提升）
MAX_ROUNDS = int(os.environ.get("DC_TOUCH_MAX_ROUNDS", "3") or 3)


def max_rounds() -> int:
    """当前生效的轮次上限（运行时可覆盖，便于运维不开进程改参数）。"""
    return int(os.environ.get("DC_TOUCH_MAX_ROUNDS", str(MAX_ROUNDS)) or MAX_ROUNDS)


def unknown_tier_due_days() -> int:
    """未定分层时的兜底节奏天数（运行时读 env，可被运维显式覆盖）。"""
    try:
        return int(os.environ.get("DC_FOLLOWUP_DUE_DAYS", str(LEGACY_DUE_DAYS)) or LEGACY_DUE_DAYS)
    except (TypeError, ValueError):
        return LEGACY_DUE_DAYS

#: T1/T2 是内部任务代号；产品里落到线索池现有字段「跟进优先级」三档：
#:   优先跟进            → T1（高优先级，节奏快）
#:   普通跟进 / 长期培育 → T2（中低优先级，节奏慢）
#: 说明：**不新增字段名**，只在报告里说明这层映射。
PRIORITY_TO_TIER = {
    "优先跟进": "T1",
    "普通跟进": "T2",
    "长期培育": "T2",
}
TIER_LABEL = {
    "T1": "T1（线索池「优先跟进」）",
    "T2": "T2（线索池「普通跟进 / 长期培育」）",
}
TIER_RANK = {"T1": 0, "T2": 1}

#: 节奏：{分层: {当前轮次: 距下一轮天数}}
#:   T1：R1 后 3 天做 R2，R2 后 5 天做 R3
#:   T2：R1 后 7 天做 R2，R2 后 10 天做 R3
GAP_DEFAULT = {
    "T1": {1: 3, 2: 5},
    "T2": {1: 7, 2: 10},
}
GAP_ENV = {
    ("T1", 1): "DC_TOUCH_T1_GAP_R1_R2",
    ("T1", 2): "DC_TOUCH_T1_GAP_R2_R3",
    ("T2", 1): "DC_TOUCH_T2_GAP_R1_R2",
    ("T2", 2): "DC_TOUCH_T2_GAP_R2_R3",
}

#: 未定分层（线索池查不到该买家 / 该买家没有「跟进优先级」）时的兜底节奏。
#: 保持既有线上行为不变（dc_followup 的 DC_FOLLOWUP_DUE_DAYS，默认 2 天）；
#: 这是需要客户定夺的参数之一：也可以改成「未定分层一律按 T2 的 7 天」。
LEGACY_DUE_DAYS = int(os.environ.get("DC_FOLLOWUP_DUE_DAYS", "2") or 2)

#: 每轮内容角度（写进配置，不散落硬编码）：角度轮换，避免每轮只说同一件事。
ROUND_ANGLES = {
    1: {
        "round": 1,
        "key": "first_touch",
        "label": "首触：产品 + 能力",
        "bullets": ["产品线与核心能力", "与我们合作的整体价值"],
    },
    2: {
        "round": 2,
        "key": "value_reinforce",
        "label": "价值强化：认证 / 产能 / 案例 / 价格锚点",
        "bullets": ["认证与资质", "产能与交期", "同类买家案例", "价格锚点（区间 / 起订量）"],
    },
    3: {
        "round": 3,
        "key": "opportunity",
        "label": "机会型：展会邀约 / 限时 / 样品",
        "bullets": ["展会邀约（展位 / 时间）", "限时（档期 / 价格窗口）", "样品可先寄"],
    },
}

#: 硬门槛（不进入下一轮）
STOP_REPLIED = "replied"                # 买家已回复 → 停止序列、转人工
STOP_AUTO_REPLY = "auto_reply"          # 自动回复 / OOO
STOP_REJECTED = "rejected"              # 明确拒绝
STOP_BOUNCED = "bounced"                # 退信
STOP_COMPLAINED = "complained"          # 投诉
STOP_UNSUBSCRIBED = "unsubscribed"      # 退订
STOP_DO_NOT_CONTACT = "do_not_contact"  # 线索池「联系策略」/「阶段=停止触达」
STOP_OPP_CLOSED = "opportunity_closed"  # 商机 won / lost / paused
STOP_UNDELIVERED = "undelivered"        # 最新一轮还没送达（不是门槛，只是尚未推进）
STOP_MAX_ROUNDS = "max_rounds"          # 已到第 N 轮上限，序列正常结束

#: 这些算「硬门槛停止」，晚报会汇总显示（让客户看到门槛在工作）
HARD_STOP_REASONS = (STOP_REPLIED, STOP_AUTO_REPLY, STOP_REJECTED, STOP_BOUNCED,
                     STOP_COMPLAINED, STOP_UNSUBSCRIBED, STOP_DO_NOT_CONTACT,
                     STOP_OPP_CLOSED)
#: 这些不是「停止触达」，而是「序列已走完 / 本轮尚未送达」——仍算等待回复中
SEQUENCE_END_REASONS = (STOP_MAX_ROUNDS, STOP_UNDELIVERED)
STOP_LABEL = {
    STOP_REPLIED: "已回复（转人工）",
    STOP_AUTO_REPLY: "自动回复",
    STOP_REJECTED: "明确拒绝",
    STOP_BOUNCED: "退信",
    STOP_COMPLAINED: "投诉",
    STOP_UNSUBSCRIBED: "退订",
    STOP_DO_NOT_CONTACT: "不触达",
    STOP_OPP_CLOSED: "商机关闭/暂停",
    STOP_UNDELIVERED: "未送达",
    STOP_MAX_ROUNDS: "已达轮次上限",
}

#: provider_status 里代表「硬门槛」的取值
_HARD_STOP_STATUSES = {
    "bounced": STOP_BOUNCED,
    "complained": STOP_COMPLAINED,
    "unsubscribed": STOP_UNSUBSCRIBED,
}

BUSINESS_TZ = "Asia/Shanghai"


# ─────────────────────────────────────────────────────────────
# 二、小工具
# ─────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(s: str) -> str:
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()


def _parse_ts(ts) -> float | None:
    if not ts:
        return None
    if isinstance(ts, (int, float)):
        return float(ts)
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except (ValueError, TypeError, OSError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _iso_add_days(iso: str, days: int) -> str:
    try:
        dt = datetime.fromisoformat(str(iso or "").replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (dt + timedelta(days=int(days))).isoformat()
    except (ValueError, TypeError, OSError):
        return (datetime.now(timezone.utc) + timedelta(days=int(days))).isoformat()


def _local_date(ts) -> str:
    """带时区 ISO → 业务时区（Asia/Shanghai）日期。"""
    if not ts:
        return ""
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(ZoneInfo(BUSINESS_TZ)).date().isoformat()
    except Exception:
        return str(ts)[:10]


def _today(tz: str = BUSINESS_TZ) -> str:
    return datetime.now(timezone.utc).astimezone(ZoneInfo(tz)).date().isoformat()


def _tomorrow(tz: str = BUSINESS_TZ) -> str:
    return (datetime.now(timezone.utc).astimezone(ZoneInfo(tz)).date()
            + timedelta(days=1)).isoformat()


def _recipient(outbound: dict) -> str:
    rec = outbound.get("recipients") or []
    if isinstance(rec, str):
        rec = [rec]
    return str(rec[0]).strip().lower() if rec and rec[0] else ""


# ─────────────────────────────────────────────────────────────
# 三、轮次与节奏（参数读取，全部从这里出发）
# ─────────────────────────────────────────────────────────────

def _env_int(name: str, default: int | None) -> int | None:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        val = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return val if val > 0 else default


def gap_days(tier: str | None, current_round: int) -> int | None:
    """当前轮次 → 下一轮的间隔天数。未定分层或超出配置返回 None（走兜底节奏）。"""
    if not tier:
        return None
    table = GAP_DEFAULT.get(tier)
    if not table:
        return None
    default = table.get(int(current_round))
    env_name = GAP_ENV.get((tier, int(current_round)))
    if env_name:
        return _env_int(env_name, default)
    return default


def cadence_table() -> dict:
    """当前生效的节奏表（报告/排查用，展示实际值而不是默认值）。"""
    out = {}
    for tier, table in GAP_DEFAULT.items():
        out[tier] = {str(r): gap_days(tier, r) for r in sorted(table)}
    return out


def current_round_of(outbound: dict) -> int:
    """outbound 事实的 `touch_number` → 已发出去的轮次。

    `touch_number` 0 与 1 都视为 R1：0 是 `smtp_send` 的首触默认值，
    1 是历史跟进链的首触值（旧 dc_followup 把 0 当首触会重复发 R1，这里统一口径）。
    """
    touch = int(outbound.get("touch_number", 0) or 0)
    return touch if touch >= 1 else 1


def angle_for_round(round_number: int) -> dict:
    """轮次 → 内容角度（配置化；超出配置回落最后一档角度）。"""
    r = int(round_number or 1)
    if r in ROUND_ANGLES:
        return dict(ROUND_ANGLES[r])
    last = dict(ROUND_ANGLES[max(ROUND_ANGLES)])
    last["round"] = r
    last["label"] = f"第 {r} 轮（超出配置，沿用「{last['label']}」角度）"
    return last


def angle_label(round_number: int) -> str:
    return angle_for_round(round_number)["label"]


def priority_to_tier(priority: str) -> str | None:
    """线索池「跟进优先级」→ T1/T2。未定 → None（走兜底节奏）。"""
    return PRIORITY_TO_TIER.get((priority or "").strip())


def due_at_for(outbound: dict, tier: str | None = None, current_round: int | None = None,
               fallback_due_days: int | None = None) -> tuple[str, str]:
    """outbound → (下一轮应触达时间, 判定依据)。

    优先级：显式 `followup_due_at` > 分数节奏（T1/T2）> 兜底节奏。
    若运维显式设了 `DC_FOLLOWUP_DUE_DAYS`，它优先于分数节奏（保持线上可回归）。
    """
    explicit = outbound.get("followup_due_at")
    if explicit:
        return str(explicit), "explicit"
    sent_at = outbound.get("sent_at") or outbound.get("created_at") or ""
    cur = int(current_round) if current_round is not None else current_round_of(outbound)
    if os.environ.get("DC_FOLLOWUP_DUE_DAYS") is not None:
        return _iso_add_days(sent_at, unknown_tier_due_days()), "legacy_default"
    g = gap_days(tier, cur)
    if g is not None:
        return _iso_add_days(sent_at, g), f"tier:{tier}:R{cur}->R{cur + 1}"
    days = fallback_due_days if fallback_due_days is not None else unknown_tier_due_days()
    return _iso_add_days(sent_at, int(days)), "legacy_default"


# ─────────────────────────────────────────────────────────────
# 四、买家回复 / 硬门槛判定
# ─────────────────────────────────────────────────────────────

def _matching_inbounds(outbound: dict, inbounds: list[dict]) -> list[dict]:
    """找回复了这封 outbound 的 inbound（binding 路径 + Adapter 引用路径，两条都认）。

    与 `dc_email_controller.dc_followup._has_reply` / `email_metrics.legacy.has_reply`
    同一口径：强引用（In-Reply-To / References / thread）与旧字段名都匹配。
    """
    thread_id = outbound.get("thread_id") or outbound.get("local_message_id") or ""
    contact_id = outbound.get("contact_id") or ""
    sent_at = outbound.get("sent_at") or outbound.get("created_at") or ""
    hits: list[dict] = []
    for ib in inbounds or []:
        if not isinstance(ib, dict):
            continue
        if ib.get("binding_status") == "bound":
            if thread_id and ib.get("thread_id") == thread_id:
                hits.append(ib)
                continue
            if contact_id and ib.get("contact_id") == contact_id \
                    and (ib.get("received_at") or "") >= sent_at:
                hits.append(ib)
                continue
    try:
        from email_metrics.legacy import inbound_refs, outbound_ids
        oids = set(outbound_ids(outbound))
        if oids:
            for ib in inbounds or []:
                if not isinstance(ib, dict):
                    continue
                if oids & set(inbound_refs(ib)):
                    hits.append(ib)
    except Exception:
        pass
    seen, out = set(), []
    for ib in hits:
        key = id(ib)
        if key in seen:
            continue
        seen.add(key)
        out.append(ib)
    return out


def has_reply(outbound: dict, inbounds: list[dict], outbounds: list[dict] | None = None) -> bool:
    """该 outbound 是否已被人工回复（停止序列的判据）。"""
    if _matching_inbounds(outbound, inbounds):
        return True
    try:
        from email_metrics import legacy as _legacy
        return bool(_legacy.has_reply(outbound, outbounds or [outbound], inbounds))
    except Exception:
        return False


def reply_intent(inbounds: list[dict]) -> str:
    """回复正文 → intent（复用 dc_iq_engine 纯分析；失败返回空串）。

    只有 `自动回复` / `拒绝` 两种会改变停止原因，其余一律按「已回复，转人工」。
    """
    for ib in inbounds or []:
        text = ib.get("text_preview") or ib.get("text") or ib.get("body") or ""
        if not text:
            continue
        try:
            from dc_iq_engine import analyze_only
            intent = (analyze_only(str(text)) or {}).get("intent", "") or ""
        except Exception:
            intent = ""
        if intent in ("自动回复", "拒绝"):
            return intent
        if intent:
            return intent
    return ""


def stop_reason_from_reply(intent: str) -> str:
    if intent == "自动回复":
        return STOP_AUTO_REPLY
    if intent == "拒绝":
        return STOP_REJECTED
    return STOP_REPLIED


def lead_stop_reason(lead: dict | None) -> str:
    """线索池里的买家状态是否已要求停止触达（复用现有字段，不新增字段名）。"""
    if not lead:
        return ""
    stage = str(lead.get("stage") or "").strip()
    policy = str(lead.get("contact_policy") or "").strip().lower()
    opp = str(lead.get("opportunity_status") or "").strip().lower()
    if stage == "停止触达" or policy == "do_not_contact":
        return STOP_DO_NOT_CONTACT
    if opp in ("won", "lost", "paused") or stage == "成交":
        return STOP_OPP_CLOSED
    return ""


# ─────────────────────────────────────────────────────────────
# 五、线索池分层（读现有字段：跟进优先级）
# ─────────────────────────────────────────────────────────────

def build_lead_index(leads: list[dict] | None) -> dict:
    """线索池行 → 按域名 / 公司名建索引（分层与停止判定都从这里取）。"""
    by_domain: dict[str, dict] = {}
    by_company: dict[str, dict] = {}

    def _norm_domain(v: str) -> str:
        d = str(v or "").strip().lower()
        if "@" in d:
            d = d.split("@")[-1]
        for pre in ("http://", "https://"):
            if d.startswith(pre):
                d = d[len(pre):]
        return d.split("/")[0].replace("www.", "")

    for lead in leads or []:
        if not isinstance(lead, dict):
            continue
        d = _norm_domain(lead.get("website") or lead.get("domain") or "")
        if d and d not in by_domain:
            by_domain[d] = lead
        c = str(lead.get("company") or lead.get("company_name") or "").strip().lower()
        if c and c not in by_company:
            by_company[c] = lead
    return {"by_domain": by_domain, "by_company": by_company}


def lead_of(index: dict, outbound: dict) -> dict | None:
    """outbound → 线索池行（优先按买家邮箱域名匹配「官网」，其次公司名）。"""
    idx = index or {}
    email = _recipient(outbound)
    if "@" in email:
        dom = email.split("@")[-1]
        hit = (idx.get("by_domain") or {}).get(dom)
        if hit:
            return hit
    name = str(outbound.get("buyer_company") or outbound.get("company_name") or "").strip().lower()
    if name:
        hit = (idx.get("by_company") or {}).get(name)
        if hit:
            return hit
    return None


def resolve_tier(index: dict, outbound: dict) -> dict:
    """outbound → 分层结果 {tier, priority, source, lead}。

    source:
      lead_pool_priority          线索池有「跟进优先级」→ 映射 T1/T2
      lead_pool_priority_missing  线索池有这条买家但优先级为空 → tier=None（兜底节奏）
      no_lead_record              线索池没有这条买家 → tier=None（兜底节奏）
    """
    lead = lead_of(index, outbound)
    if not lead:
        return {"tier": None, "priority": "", "source": "no_lead_record", "lead": None}
    priority = str(lead.get("followup_priority") or "").strip()
    tier = priority_to_tier(priority)
    return {
        "tier": tier,
        "priority": priority,
        "source": "lead_pool_priority" if tier else "lead_pool_priority_missing",
        "lead": lead,
    }


def read_lead_pool(company_id: str) -> list[dict]:
    """读线索池归集（memory leads.json）。失败返回空列表，不影响出数。"""
    try:
        from dc_memory_data import read_leads
        return read_leads(company_id) or []
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────
# 六、轮次引擎：待触达队列
# ─────────────────────────────────────────────────────────────

def _sequence_key(outbound: dict) -> str:
    """同一买家的判定键：买家邮箱 > contact_id > thread（买家一回复立即停止整条序列）。"""
    return _recipient(outbound) or str(outbound.get("contact_id") or "") \
        or str(outbound.get("thread_id") or outbound.get("local_message_id") or "")


def _buyer_label(outbound: dict, lead: dict | None) -> str:
    """报告里的人类可读标签：公司名优先（报告不出现买家邮箱/联系方式）。"""
    for src in (lead, outbound):
        for field in ("company", "company_name", "buyer_company"):
            v = str((src or {}).get(field) or "").strip()
            if v:
                return v
    email = _recipient(outbound)
    return email.split("@")[-1] if "@" in email else (email or "（未知买家）")


def build_touch_queue(company_id: str, at: str | None = None, store=None,
                      leads: list[dict] | None = None) -> dict:
    """核心：产出「待触达队列」。

    每个买家一条：{买家/公司, 当前轮次, 下一轮次, 应触达日期, 分层, 建议内容角度, 依据}。
    幂等：同一买家同一轮只会出现在队列里一次（按买家邮箱聚合出最末一轮）。
    """
    from email_gateway.store import EmailStore
    store = store or EmailStore()
    outbounds = store.list_outbound_records(company_id=company_id) or []
    inbounds = store.list_inbound_records(company_id=company_id) or []
    index = build_lead_index(leads if leads is not None else read_lead_pool(company_id))
    at_ts = _parse_ts(at) or datetime.now(timezone.utc).timestamp()

    groups: dict[str, list[dict]] = {}
    for ob in outbounds:
        key = _sequence_key(ob)
        if key:
            groups.setdefault(key, []).append(ob)

    # 买家拦截名单（与 dc_followup 同一判据：拒绝/排除/黑名单）
    ls = None
    try:
        from dc_ls_store import LeadStore
        ls = LeadStore()
    except Exception:
        ls = None

    rows: list[dict] = []
    stopped: list[dict] = []
    for key, obs in groups.items():
        obs = sorted(obs, key=lambda o: _parse_ts(o.get("sent_at") or o.get("created_at")) or 0)
        latest = obs[-1]
        cur_round = current_round_of(latest)
        tier_info = resolve_tier(index, latest)
        tier, lead = tier_info["tier"], tier_info["lead"]
        buyer = _buyer_label(latest, lead)
        base = {
            "buyer": buyer,
            "buyer_email": _recipient(latest),
            "contact_id": latest.get("contact_id", ""),
            "campaign_id": latest.get("campaign_id", ""),
            "lead_id": latest.get("lead_id", ""),
            "current_round": cur_round,
            "last_sent_at": latest.get("sent_at") or latest.get("created_at", ""),
            "tier": tier or "未定",
            "tier_source": tier_info["source"],
            "priority": tier_info["priority"],
        }

        # 硬门槛 1：退信 / 投诉 / 退订（序列里任意一轮命中即停）
        hit_status = ""
        for ob in obs:
            st = str(ob.get("provider_status") or "").lower()
            if st in _HARD_STOP_STATUSES:
                hit_status = _HARD_STOP_STATUSES[st]
                break
        if hit_status:
            stopped.append({**base, "stop_reason": hit_status,
                            "stop_label": STOP_LABEL.get(hit_status, hit_status),
                            "evidence": f"provider_status={hit_status}"})
            continue

        # 硬门槛 2：线索池要求不触达 / 商机关闭
        lstop = lead_stop_reason(lead)
        if lstop:
            stopped.append({**base, "stop_reason": lstop,
                            "stop_label": STOP_LABEL.get(lstop, lstop),
                            "evidence": f"线索池：阶段={lead.get('stage', '')} "
                                        f"联系策略={lead.get('contact_policy', '')} "
                                        f"商机状态={lead.get('opportunity_status', '')}"})
            continue

        # 硬门槛 3：买家被标拒绝/排除（LeadStore，与 dc_followup / 发送前拦截同一名单）
        if ls is not None:
            try:
                if ls.is_buyer_blocked(company_id, _recipient(latest)):
                    stopped.append({**base, "stop_reason": STOP_REJECTED,
                                    "stop_label": STOP_LABEL[STOP_REJECTED],
                                    "evidence": "LeadStore 标注为拒绝/排除/黑名单"})
                    continue
            except Exception:
                pass

        # 硬门槛 4：已回复（自动回复 / 拒绝 / 真实回复都停序列）
        replies = []
        for ob in obs:
            replies += _matching_inbounds(ob, inbounds)
        if not replies and has_reply(latest, inbounds, outbounds):
            replies = _matching_inbounds(latest, inbounds)
        if replies:
            intent = reply_intent(replies)
            reason = stop_reason_from_reply(intent)
            stopped.append({**base, "stop_reason": reason,
                            "stop_label": STOP_LABEL.get(reason, reason),
                            "evidence": f"inbound intent={intent or '（未识别，按真实回复）'}"})
            continue

        # 硬门槛 5：轮次上限（序列走完，不再推进；仍算「等待回复中」）
        if cur_round >= max_rounds():
            rows.append({**base, "next_round": None, "due": False,
                         "sequence_end": True,
                         "stop_reason": STOP_MAX_ROUNDS,
                         "stop_label": STOP_LABEL[STOP_MAX_ROUNDS],
                         "due_at": "", "due_date": "", "days_until_due": 0,
                         "gap_days": None, "due_policy": "sequence_end",
                         "angle": None, "angle_label": "",
                         "action": {"kind": "strategy_review", "round": cur_round,
                                    "tier": tier or ""},
                         "action_hint": "已走完 3 轮，转策略复盘（不再自动触达）",
                         "evidence": f"touch_number={cur_round} 已达 {max_rounds()} 轮",
                         "reasons": [f"已触达 {cur_round} 轮仍无回复", "序列正常结束"]})
            continue

        # 最新一轮未送达 → 不推进（等送达，不算硬门槛，仍算等待中）
        if str(latest.get("provider_status") or "").lower() != "delivered":
            rows.append({**base, "next_round": cur_round + 1, "due": False,
                         "sequence_end": False, "delivery_pending": True,
                         "stop_reason": STOP_UNDELIVERED,
                         "stop_label": STOP_LABEL[STOP_UNDELIVERED],
                         "due_at": "", "due_date": "", "days_until_due": 0,
                         "gap_days": None, "due_policy": "not_delivered",
                         "angle": None, "angle_label": "",
                         "action": {"kind": "wait_delivery", "round": cur_round},
                         "action_hint": "等送达后再计到期",
                         "evidence": f"provider_status={latest.get('provider_status', '')}",
                         "reasons": ["最新一轮尚未送达，不推进下一轮"]})
            continue

        next_round = cur_round + 1
        due_at, policy = due_at_for(latest, tier=tier, current_round=cur_round)
        due_ts = _parse_ts(due_at)
        due = due_ts is not None and at_ts >= due_ts
        angle = angle_for_round(next_round)
        rows.append({
            **base,
            # 内部用：本轮对应的 outbound 事实（草稿生成/排查用，不进报告文案）
            "_outbound": latest,
            "next_round": next_round,
            "due_at": due_at,
            "due_date": _local_date(due_at),
            "due": due,
            "days_until_due": (max(0, int(round((due_ts - at_ts) / 86400))) if due_ts else 0),
            "gap_days": gap_days(tier, cur_round),
            "due_policy": policy,
            "angle": angle,
            "angle_label": angle["label"],
            "action": {"kind": "generate_round_draft", "round": next_round,
                       "tier": tier or "", "batch": True},
            "action_hint": f"一键生成 R{next_round} 草稿",
            "evidence": (f"touch_number={cur_round} · 收到 {policy} · "
                         f"分层 {tier or '未定'}（{tier_info['source']}）"),
            "reasons": [
                f"第 {cur_round} 轮已送达且无回复",
                f"距上次触达节奏：{policy}",
                f"下一轮角度：{angle['label']}",
            ],
        })

    tier_rank = lambda r: (TIER_RANK.get(r.get("tier"), 9), r.get("due_at") or "")
    rows.sort(key=tier_rank)
    due_rows = [r for r in rows if r["due"]]

    waiting: dict[int, int] = {}
    for r in rows:
        if r.get("due"):
            continue  # 今日该做的已在上面的 todo 行里，不重复计入「等待回复中」
        waiting[r["current_round"]] = waiting.get(r["current_round"], 0) + 1
    waiting_line = " · ".join(f"R{i} {waiting[i]} 家" for i in sorted(waiting)) or "无"

    return {
        "company_id": company_id,
        "as_of": _now(),
        "at": at or "",
        "max_rounds": max_rounds(),
        "config": {
            "max_rounds": max_rounds(),
            "cadence_days": cadence_table(),
            "legacy_due_days_unknown_tier": unknown_tier_due_days(),
            "tier_mapping": {"T1": ["优先跟进"], "T2": ["普通跟进", "长期培育"]},
            "angles": {str(k): v["label"] for k, v in ROUND_ANGLES.items()},
        },
        "rows": rows,
        "due_rows": due_rows,
        "waiting": [{"round": r, "count": waiting[r]} for r in sorted(waiting)],
        "waiting_line": waiting_line,
        "waiting_note": "等待回复中 = 在序列内且今日无到期动作的买家（含已走完轮次仍等回复的）",
        "stopped": stopped,
        "totals": {"active": len(rows), "due": len(due_rows), "stopped": len(stopped),
                   "waiting": sum(waiting.values())},
    }


def stopped_summary(queue: dict, reasons: tuple = HARD_STOP_REASONS) -> str:
    """停止原因汇总（只统计硬门槛；「已达轮次上限/未送达」不计）。"""
    counts: dict[str, int] = {}
    for s in queue.get("stopped") or []:
        r = s.get("stop_reason")
        if r in reasons:
            counts[r] = counts.get(r, 0) + 1
    if not counts:
        return ""
    ordered = [r for r in reasons if r in counts]
    return " · ".join(f"{STOP_LABEL.get(r, r)} {counts[r]}" for r in ordered)


def due_rows_by_tier_and_round(queue: dict) -> dict:
    """到期行 → {(tier, next_round): [行, ...]}（报告分批/汇总用）。"""
    buckets: dict[tuple, list] = {}
    for r in queue.get("due_rows") or []:
        buckets.setdefault((r.get("tier") or "未定", r.get("next_round")), []).append(r)
    return dict(sorted(buckets.items(), key=lambda kv: (TIER_RANK.get(kv[0][0], 9), kv[0][1])))


def render_touch_rounds_section(queue: dict, slot: str = "morning",
                                limit: int = 3, always: bool = True) -> str:
    """早晚报「多轮触达」todo 区块（早报 + 晚报都要有）。

    · 按分层排序，每条给动作入口（一键生成 R{N} 草稿）；
    · 数量多时按 (分层, 轮次) 汇总，只在小批量时展开买家名，不刷屏；
    · `always=True` 时即使 0 到期也输出区块（让客户确认这段没被省掉）。
    """
    queue = queue or {}
    due = queue.get("due_rows") or []
    waiting_line = queue.get("waiting_line") or "无"
    today = _today()
    title = "■ 多轮触达（今天）" if slot == "morning" else "■ 多轮触达（今日核销 / 明日预告）"
    lines = [title]

    if due:
        for (tier, rnd), rows in due_rows_by_tier_and_round(queue).items():
            names = "、".join(r["buyer"] for r in rows[:limit])
            head = f"· {tier} {len(rows)} 家该做第 {rnd} 轮"
            if len(rows) <= limit and names:
                head += f"：{names}"
            angle = rows[0].get("angle_label") or angle_label(rnd)
            lines.append(f"{head} → 一键生成 R{rnd} 草稿（{angle}）")
        if len(due) > limit * 2:
            lines.append(f"· （今日共 {len(due)} 家到期，超过 {limit * 2} 家不逐一展开，"
                         f"明细见线索池「下一步动作 / 截止时间」）")
    else:
        lines.append("· 今日无到期轮次")

    if slot == "evening":
        tomorrow = _tomorrow()
        upcoming = {}
        for r in (queue.get("rows") or []):
            if r.get("due") or r.get("due_date") != tomorrow:
                continue  # 只预告「明天到期」的（不是所有未来到期）
            key = r.get("tier") or "未定"
            upcoming[key] = upcoming.get(key, 0) + 1
        if upcoming:
            seg = " · ".join(f"{k} {v} 家" for k, v in sorted(
                upcoming.items(), key=lambda kv: TIER_RANK.get(kv[0], 9)))
            lines.append(f"· 明日到期：{seg}")

    stops = stopped_summary(queue)
    lines.append(f"（等待回复中：{waiting_line}）")
    if stops:
        lines.append(f"（已停止触达：{stops}）")

    if not always and not due and not stops and not (queue.get("rows") or []):
        return ""
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────
# 七、no_reply_due → 「第 N 轮到期」
# ─────────────────────────────────────────────────────────────

def round_due_resolver(company_id: str, leads: list[dict] | None = None):
    """构造 evaluate_due 的 due 解析器：把「到期」算成「第 N 轮到期」。

    返回 (outbound) -> (due_at, evidence_extra)；
    显式 `followup_due_at` 仍然优先（与 evaluate_due 原语义一致）。
    """
    index = build_lead_index(leads if leads is not None else read_lead_pool(company_id))

    def _resolve(outbound: dict):
        cur = current_round_of(outbound)
        tier_info = resolve_tier(index, outbound)
        tier = tier_info["tier"]
        due_at, policy = due_at_for(outbound, tier=tier, current_round=cur)
        return due_at, {
            "next_touch": cur + 1,
            "round_number": cur,
            "tier": tier or "未定",
            "tier_source": tier_info["source"],
            "cadence_policy": policy,
            "angle": angle_label(cur + 1),
            "stop_semantics": "回复/退信/投诉/退订/拒绝/自动回复 一律停止下一轮",
        }

    return _resolve


def evaluate_round_due(company_id: str, at: str | None = None, store=None,
                       leads: list[dict] | None = None) -> list[dict]:
    """生成 `no_reply_due` 信号，语义为「第 N 轮到期」（复用 evaluate_due 单一路径）。"""
    from dc_email_controller.dc_email_signals import evaluate_due
    return evaluate_due(company_id, at=at, due_for=round_due_resolver(company_id, leads),
                        store=store)


# ─────────────────────────────────────────────────────────────
# 八、草稿生成（只生成，绝不发送）
# ─────────────────────────────────────────────────────────────

def followup_id(company_id: str, campaign_id: str, lead_id: str, contact_id: str,
                touch_number: int) -> str:
    """跟进草稿幂等键（与既有 dc_followup 完全同式，两条路径不会各自生成一份）。"""
    return _hash("|".join(["followup", company_id or "", campaign_id or "",
                           lead_id or "", contact_id or "", str(touch_number)]))


def round_email_body(round_number: int, buyer_name: str = "",
                     product: str = "our products") -> str:
    """按轮次给不同角度的邮件正文（R1 产品+能力 / R2 价值强化 / R3 机会型）。"""
    name = f" {buyer_name}" if buyer_name else ""
    r = int(round_number or 1)
    if r <= 1:
        return (f"Hi{name}, we supply {product} and run our own production + QC, "
                f"so OEM/ODM projects are supported end to end. "
                f"Would it help if I sent our product list and capability overview?")
    if r == 2:
        return (f"Hi{name}, following up on {product}. To make it concrete: we are certified "
                f"(CE / ISO), our capacity keeps lead times stable, and we already supply "
                f"similar buyers in your market. Happy to share case references and a price "
                f"range — what volume are you planning?")
    return (f"Hi{name}, one last note on {product}. We can ship samples before you commit, "
            f"and we will be exhibiting soon — if you are attending, we could meet at our "
            f"booth (or set up a short call). Would either be useful?")


def generate_round_drafts(company_id: str, tier: str | None = None, round_number: int | None = None,
                          at: str | None = None, store=None, leads: list[dict] | None = None,
                          dry_run: bool = False, limit: int | None = None) -> dict:
    """按队列生成 `pending_confirmation` 草稿（幂等：同买家同轮只生成一次）。

    **只生成草稿等用户确认，绝不自动发送**（发送仍走 dc_reply_draft.confirm_and_send）。
    """
    from dc_email_controller.dc_reply_draft import get_draft, record_draft
    queue = build_touch_queue(company_id, at=at, store=store, leads=leads)
    rows = [r for r in (queue.get("due_rows") or [])
            if (not tier or r.get("tier") == tier)
            and (round_number is None or r.get("next_round") == int(round_number))]
    if limit:
        rows = rows[:int(limit)]
    generated, skipped = [], 0
    for r in rows:
        local = r.get("_outbound") or {}
        ob = {
            "campaign_id": local.get("campaign_id", "") or r.get("campaign_id", ""),
            "lead_id": local.get("lead_id", "") or r.get("lead_id", ""),
            "contact_id": local.get("contact_id", "") or r.get("contact_id", ""),
            "subject": local.get("subject", ""),
            "resend_id": local.get("resend_id", "") or local.get("local_message_id", ""),
            "account_id": local.get("account_id", ""),
        }
        fid = followup_id(company_id, ob["campaign_id"], ob["lead_id"], ob["contact_id"],
                          r.get("next_round"))
        if get_draft(fid):
            skipped += 1
            continue
        buyer_name = (r["buyer_email"].split("@")[0] if "@" in (r.get("buyer_email") or "") else "")
        angle = r.get("angle") or angle_for_round(r.get("next_round"))
        rec = {
            "draft_id": fid,
            "company_id": company_id,
            "campaign_id": ob["campaign_id"],
            "lead_id": ob["lead_id"],
            "contact_id": ob["contact_id"],
            "account_id": ob.get("account_id", ""),
            "buyer_email": r.get("buyer_email", ""),
            "related_reply_id": ob["resend_id"],
            "subject": f"Re: {ob['subject']}" if ob["subject"] else "Follow-up",
            "text": round_email_body(r.get("next_round"), buyer_name),
            "missing_fields": [],
            "status": "pending_confirmation",
            "category": "followup",
            "created_at": _now(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
            "updated_at": _now(),
            "message_id": "",
            "sent_at": "",
            "failure_reason": "",
            "next_action": "",
            "attempts": 0,
            "touch_number": int(r.get("next_round") or 0),
            "round_tier": r.get("tier", ""),
            "round_angle": angle.get("key", ""),
            "round_angle_label": angle.get("label", ""),
            "round_due_at": r.get("due_at", ""),
            "round_evidence": r.get("evidence", ""),
        }
        if not dry_run:
            record_draft(rec)
        generated.append(rec)
    return {
        "company_id": company_id,
        "due": len(queue.get("due_rows") or []),
        "matched": len(rows),
        "generated": len(generated),
        "skipped": skipped,
        "dry_run": dry_run,
        "drafts": [{"draft_id": g["draft_id"], "touch_number": g["touch_number"],
                    "tier": g["round_tier"], "angle": g["round_angle"],
                    "subject": g["subject"]} for g in generated],
    }


# ─────────────────────────────────────────────────────────────
# 九、线索池可见性（复用现有字段，不新增字段名）# ─────────────────────────────────────────────────────────────

def lead_pool_patch(row: dict) -> dict:
    """队列行 → 线索池字段补丁（**只写自由文本字段，不覆盖枚举字段**）。

    复用现有字段承载「第几轮 / 下次触达时间 / 是否已回」：
      下一步动作   ← 「第 2 轮触达（价值强化：认证 / 产能 / 案例 / 价格锚点）」
      截止时间     ← 下次触达日期
      最近联系时间 ← 上次已送达时间
    不写「联系策略 / 商机状态」：它们承载 contact_policy / opportunity_status 枚举语义
    （dc_priority、dc_memory_data 在读），写文本会破坏枚举口径。
    「是否已回」由既有「阶段=已回复 + 买家回复数」承载；停止序列时在「下一步动作」写明。
    """
    last = _local_date(row.get("last_sent_at"))
    reason = row.get("stop_reason")
    if reason in HARD_STOP_REASONS:
        label = row.get("stop_label") or reason
        return {"下一步动作": f"停止触达：{label}", "截止时间": "", "最近联系时间": last}
    if reason == STOP_MAX_ROUNDS:
        return {"下一步动作": f"已触达 {row.get('current_round')} 轮（序列完成，等回复 / 转策略复盘）",
                "截止时间": "", "最近联系时间": last}
    if reason == STOP_UNDELIVERED:
        return {"下一步动作": f"第 {row.get('current_round')} 轮待送达（送达后再计到期）",
                "截止时间": "", "最近联系时间": last}
    nxt = row.get("next_round")
    return {
        "下一步动作": f"第 {nxt} 轮触达（{row.get('angle_label') or angle_label(nxt)}）",
        "截止时间": row.get("due_date", ""),
        "最近联系时间": last,
    }


def apply_round_fields_to_leads(company_id: str, queue: dict | None = None,
                                leads: list[dict] | None = None) -> dict:
    """把轮次状态写回线索池归集（memory leads.json，本地文件，不触外网）。"""
    from dc_memory_data import read_leads, _write_json
    queue = queue or build_touch_queue(company_id, leads=leads)
    rows = list(queue.get("rows") or []) + list(queue.get("stopped") or [])
    by_key: dict[str, dict] = {}
    for r in rows:
        by_key[(r.get("buyer_email") or "").lower()] = r
        by_key[(r.get("buyer") or "").strip().lower()] = r

    leads = read_leads(company_id) if leads is None else leads
    patched = 0
    out = []
    for lead in leads or []:
        lead = dict(lead)
        key_email = str(lead.get("website") or "").strip().lower()
        key_name = str(lead.get("company") or "").strip().lower()
        row = by_key.get(key_name)
        if not row and key_email:
            for r in rows:
                em = (r.get("buyer_email") or "").lower()
                if em and "@" in em and em.split("@")[-1] == key_email.split("/")[0].replace("www.", ""):
                    row = r
                    break
        if row:
            lead.update(lead_pool_patch(row))
            patched += 1
        out.append(lead)
    path = _write_json(company_id, "leads.json", out)
    return {"status": "ok", "leads": len(out), "patched": patched, "path": str(path)}


def push_round_fields_to_pool(company_id: str, queue: dict | None = None,
                              dry_run: bool = True) -> dict:
    """把轮次字段推到线上飞书线索池（默认 dry_run，不写线上）。

    用现有 `+record-upsert` 按 record_id 更新，只写 `lead_pool_patch` 的三个自由文本字段。
    需要客户/运维显式 `dry_run=False` 才会真写；默认绝不改线上线索池。
    """
    from dc_company_registry import CompanyRegistry, _existing_record_index, _run_lark
    queue = queue or build_touch_queue(company_id)
    entry = CompanyRegistry().get(company_id)
    if not entry:
        return {"status": "error", "error": "无线索池（未建 Base）", "dry_run": dry_run}
    app_token, table_id = entry.get("app_token", ""), entry.get("table_id", "")
    rows = list(queue.get("rows") or []) + list(queue.get("stopped") or [])
    if dry_run:
        return {"status": "ok", "dry_run": True, "planned": len(rows),
                "note": "默认 dry_run：未写线上线索池"}
    index = _existing_record_index(app_token, table_id)
    written = 0
    for r in rows:
        rid = index.get(f"website:{(r.get('buyer_email') or '').split('@')[-1]}")
        if not rid:
            continue
        _run_lark("base", "+record-upsert", "--base-token", app_token,
                  "--table-id", table_id, "--record-id", rid,
                  "--json", json.dumps(lead_pool_patch(r), ensure_ascii=False),
                  "--as", "bot")
        written += 1
    return {"status": "ok", "dry_run": False, "written": written}


# ─────────────────────────────────────────────────────────────
# 十、CLI
# ─────────────────────────────────────────────────────────────

def _cli():
    ap = argparse.ArgumentParser(description="DealClaw 多轮个性化触达轮次引擎")
    sub = ap.add_subparsers(dest="cmd", required=True)

    q = sub.add_parser("queue", help="待触达队列（JSON）")
    q.add_argument("--company-id", required=True)
    q.add_argument("--at", help="ISO 时间（到期判定基准）")

    r = sub.add_parser("render", help="早晚报「多轮触达」区块")
    r.add_argument("--company-id", required=True)
    r.add_argument("--slot", default="morning", choices=["morning", "evening"])
    r.add_argument("--at")

    g = sub.add_parser("generate", help="按队列生成 R2/R3 草稿（只生成，不发送）")
    g.add_argument("--company-id", required=True)
    g.add_argument("--tier", choices=["T1", "T2"])
    g.add_argument("--round", type=int, dest="round_number")
    g.add_argument("--at")
    g.add_argument("--limit", type=int)
    g.add_argument("--dry-run", action="store_true")

    d = sub.add_parser("due", help="生成「第 N 轮到期」no_reply_due 信号")
    d.add_argument("--company-id", required=True)
    d.add_argument("--at")

    args = ap.parse_args()
    if args.cmd == "queue":
        print(json.dumps(build_touch_queue(args.company_id, at=args.at),
                         ensure_ascii=False, indent=2, default=str))
    elif args.cmd == "render":
        print(render_touch_rounds_section(build_touch_queue(args.company_id, at=args.at),
                                          slot=args.slot))
    elif args.cmd == "generate":
        print(json.dumps(generate_round_drafts(
            args.company_id, tier=args.tier, round_number=args.round_number,
            at=args.at, dry_run=args.dry_run, limit=args.limit),
            ensure_ascii=False, indent=2, default=str))
    elif args.cmd == "due":
        produced = evaluate_round_due(args.company_id, at=args.at)
        print(json.dumps({"produced": len(produced),
                          "signals": [{k: s.get(k) for k in
                                       ("signal_id", "company_id", "contact_id",
                                        "evidence", "occurred_at")} for s in produced]},
                         ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
