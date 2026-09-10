#!/usr/bin/env python3
"""
dc_marketing_automation.py — 展会自动营销决策（轻量方案，纯函数层）

统一决策入口 evaluate_next_action()：把买家当前所处状态映射为下一步营销动作，
不为展前/展中/展后分别建状态机。

五态 → 五动作：
  first_invite            从未邀约 → 首封邀约信
  second_invite           已邀约 · 未到场（isCheckIn∈{2,3}）→ 二次邀约
  onsite_followup         已到场 · 有会议/商洽证据 → 匹配会议记录跟进
  missed_meeting_reengage 已到场 · 无会议/商洽证据 → 再触达约见面
  nurture                 多轮触达无回复（touch ≥ 阈值）→ 长期培育

设计约束（详见 dc_marketing_automation_spec.md）：
  1. 复用 meta / exhibition-invitations / interactions / opportunity / raw memory，不复制正文。
  2. automations.json 只存流程状态 + 引用。
  3. evaluate_next_action() 无副作用：不写文件、不调接口、不修改输入。
  4. 规则决定资格/频控/停止/时间；模型只生成邮件内容。
  5. 动作执行复用已有 Skill；本模块只产出「下一步做什么」。
  6. 长期状态写 memory，临时任务/锁写 data/runtime/jobs。
  7. 同一 opportunity 同时只能有一个 active automation。
  8. 不开发复杂调度框架（无 cron/lease/重试）。

规则版本：1.0.0
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

RULE_VERSION = "1.0.0"

# ── 动作集合 ────────────────────────────────────────────────
FIRST_INVITE = "first_invite"
SECOND_INVITE = "second_invite"
ONSITE_FOLLOWUP = "onsite_followup"
MISSED_MEETING_REENGAGE = "missed_meeting_reengage"
NURTURE = "nurture"
NONE = "none"

ACTIONS = (FIRST_INVITE, SECOND_INVITE, ONSITE_FOLLOWUP, MISSED_MEETING_REENGAGE, NURTURE)

# ── 到展状态（对齐 getInvitationByPage isCheckIn）─────────────
CHECKIN_ARRIVED = 1       # 到展
CHECKIN_PENDING = 2       # 暂未到展
CHECKIN_NOT_ARRIVED = 3   # 未到展

# ── 邀约状态（inviationState）───────────────────────────────
INV_STATE_UNREACHABLE = 2   # 联系不上
INV_STATE_REJECTED = 3      # 已拒绝

# ── 默认配置（规则决定资格/频控/停止/时间）─────────────────────
DEFAULT_CONFIG = {
    "nurture_touch_threshold": 3,          # touch ≥ 3 且无回复 → nurture
    "second_invite_max": 1,                # 每买家最多 1 次二次邀约
    "first_invite_stages": ["inviting", "live"],
    "second_invite_stages": ["live"],
    "onsite_stages": ["live", "followup"],
    "nurture_interval_days": 30,           # nurture due_at = now + 30d
    # 各动作是否需要用户确认（默认；可被租户/展会配置覆盖）
    # 审批分级（2026-09-11 田耕郡定「直接发」）——
    #   暖场景（已邀约未到场 / 已到场跟进 / 到场再触达）→ False，直接发送；
    #   首邀（冷启动・第一印象）→ 保守保留确认，可一句话放开。
    #   注：False 只豁免「人工确认」，不豁免时区窗口 / 退订 / buyer_blocked / 日限额等硬护栏。
    "requires_approval": {
        FIRST_INVITE: True,
        SECOND_INVITE: False,
        ONSITE_FOLLOWUP: False,
        MISSED_MEETING_REENGAGE: False,
        NURTURE: False,
    },
}

# 硬停止触达的 opportunity_status（不主动追）
_STOP_OPP_STATUS = {"won", "lost", "paused"}
# 硬停止触达的 contact_policy
_STOP_CONTACT_POLICY = "do_not_contact"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_dt(s) -> Optional[datetime]:
    if not s:
        return None
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, OSError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _has(v) -> bool:
    """非空且非零（数字 0/空串/False 视为无）。"""
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


def _stable_id(*parts) -> str:
    base = "|".join(str(p) for p in parts if str(p))
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


# ─────────────────────────────────────────────────────────────
# 1. 配置解析（展会 meta 配置 > 租户 > DEFAULT_CONFIG）
# ─────────────────────────────────────────────────────────────

def _resolve_config(config: Optional[dict], meta: Optional[dict]) -> dict:
    """合并配置：显式 config 覆盖 DEFAULT_CONFIG；meta 里的 automation 配置次之。

    纯函数，不读环境变量、不读文件（调用方把租户/展会配置组装好传入）。
    """
    merged = dict(DEFAULT_CONFIG)
    for k in ("nurture_touch_threshold", "second_invite_max", "nurture_interval_days"):
        v = (meta or {}).get(k)
        if _has(v):
            try:
                merged[k] = int(v)
            except (TypeError, ValueError):
                pass
    # stage 列表覆盖
    for k in ("first_invite_stages", "second_invite_stages", "onsite_stages"):
        v = (meta or {}).get(k)
        if isinstance(v, list) and v:
            merged[k] = list(v)
    # requires_approval 逐动作覆盖
    ra = (meta or {}).get("requires_approval")
    if isinstance(ra, dict):
        merged["requires_approval"] = {**DEFAULT_CONFIG["requires_approval"], **ra}

    if isinstance(config, dict) and config:
        for k, v in config.items():
            if k == "requires_approval" and isinstance(v, dict):
                merged["requires_approval"] = {**merged["requires_approval"], **v}
            elif k in merged:
                merged[k] = v
    return merged


# ─────────────────────────────────────────────────────────────
# 2. 排除层（硬停止触达）
# ─────────────────────────────────────────────────────────────

def _exclude(customer: dict, opportunity: dict, invitation: Optional[dict]) -> tuple[bool, str]:
    """返回 (excluded, reason)。excluded=True 表示硬停止触达。"""
    cp = (customer or {}).get("contact_policy") or "active"
    if cp == _STOP_CONTACT_POLICY:
        return True, "do_not_contact"

    opp_status = (opportunity or {}).get("opportunity_status") or "active"
    if opp_status in _STOP_OPP_STATUS:
        return True, f"opportunity_status_{opp_status}"

    # 邀约状态：联系不上 / 已拒绝 → 停止
    inv_state = _int((invitation or {}).get("inviationState", 0) or (invitation or {}).get("invitation_state", 0))
    if inv_state == INV_STATE_REJECTED:
        return True, "invitation_rejected"
    if inv_state == INV_STATE_UNREACHABLE:
        return True, "invitation_unreachable"

    return False, ""


# ─────────────────────────────────────────────────────────────
# 3. 会议/商洽证据判定
# ─────────────────────────────────────────────────────────────

def _has_meeting_evidence(invitation: Optional[dict], interactions: list) -> bool:
    """是否到场后有实际会议/商洽证据。

    - isMeeting=1（邀约记录里已商洽）→ 有
    - 存在 source/channel=meeting 且有实际沟通内容（summary 或 signals）→ 有
    """
    if _int((invitation or {}).get("isMeeting", 0) or (invitation or {}).get("is_meeting", 0)) == 1:
        return True
    for it in (interactions or []):
        if not isinstance(it, dict):
            continue
        src = str(it.get("source") or "").lower()
        ch = str(it.get("channel") or "").lower()
        if "meeting" in (src, ch):
            if _has(it.get("summary")) or (it.get("signals")):
                return True
    return False


# ─────────────────────────────────────────────────────────────
# 4. 触达轮数 / 回复 推导
# ─────────────────────────────────────────────────────────────

def _derive_touch(customer: dict, invitation: Optional[dict], interactions: list) -> int:
    """触达轮数：邀约算 1 次；outbound interaction 按 touch_number 或计数累加。"""
    touch = 0
    if invitation is not None:
        touch = max(touch, 1)
    for it in (interactions or []):
        if not isinstance(it, dict):
            continue
        d = str(it.get("direction") or "").lower()
        if d in ("outbound", "out"):
            tn = _int(it.get("touch_number"), 0)
            touch = max(touch, tn or 1)
    # 显式 touch_number 覆盖（lead/opportunity 层已聚合好的）
    explicit = _int((customer or {}).get("touch_number"), 0)
    return max(touch, explicit)


def _has_reply(customer: dict, invitation: Optional[dict], interactions: list) -> bool:
    """是否已有真实回复/双向沟通。

    注意：邀请状态「已接受」（inviationState=4）不等于回复跟进邮件，
    不计入回复；回复只认真实入站沟通（inbound 邮件 / WA 双向 / meeting）。
    """
    if _has((customer or {}).get("has_reply")):
        return True
    for it in (interactions or []):
        if not isinstance(it, dict):
            continue
        d = str(it.get("direction") or "").lower()
        src = str(it.get("source") or "").lower()
        if d in ("inbound", "in") or src == "meeting":
            return True
        if _has(it.get("has_reply")) or _has(it.get("replied")):
            return True
        # WA 双向
        if _has(it.get("bidirectional")):
            return True
    return False


# ─────────────────────────────────────────────────────────────
# 5. 频控（从 automations 历史计数）
# ─────────────────────────────────────────────────────────────

def _count_action(automation_state: Optional[dict], action: str, opportunity_key: str) -> int:
    """同一 opportunity 下，某动作的历史执行次数（active/completed/failed 都算）。"""
    if not automation_state:
        return 0
    automations = automation_state.get("automations", []) if isinstance(automation_state, dict) else []
    n = 0
    for a in automations:
        if not isinstance(a, dict):
            continue
        if a.get("action") != action:
            continue
        if a.get("opportunity_id") != opportunity_key:
            continue
        n += 1
    return n


def _find_active(automation_state: Optional[dict], opportunity_key: str) -> Optional[dict]:
    """找同一 opportunity 的 active automation（单活跃互斥判定用）。"""
    if not automation_state:
        return None
    automations = automation_state.get("automations", []) if isinstance(automation_state, dict) else []
    for a in automations:
        if not isinstance(a, dict):
            continue
        if a.get("status") == "active" and a.get("opportunity_id") == opportunity_key:
            return a
    return None


# ─────────────────────────────────────────────────────────────
# 6. 幂等键 / 机会主键
# ─────────────────────────────────────────────────────────────

def opportunity_key_of(opportunity: dict, customer: dict, invitation: Optional[dict]) -> str:
    """机会主键：opportunity_id 优先，否则 cdp:exhibitionId。"""
    opp_id = (opportunity or {}).get("opportunity_id") or ""
    if opp_id:
        return str(opp_id)
    cdp = (customer or {}).get("companyCdpId") or (customer or {}).get("company_cdp_id") or ""
    exh = (invitation or {}).get("exhibitionId") or (invitation or {}).get("exhibition_id") or ""
    if cdp and exh:
        return f"{cdp}:{exh}"
    return str(opp_id or cdp or "")


def idempotency_key(action: str, opportunity_key: str) -> str:
    """幂等键 = action + opportunity_key（不依赖内容/代码版本，稳定可重算）。"""
    return f"{action}:{opportunity_key}"


# ─────────────────────────────────────────────────────────────
# 7. 证据引用
# ─────────────────────────────────────────────────────────────

def _evidence_refs(interactions: list, invitation: Optional[dict], source_hint: str = "") -> list:
    """收集支撑动作的证据引用（interaction_id / raw_record_ref / signal / source）。"""
    refs: list = []
    for it in (interactions or []):
        if not isinstance(it, dict):
            continue
        ref = {
            "interaction_id": it.get("interaction_id", ""),
            "raw_record_ref": it.get("raw_record_ref", ""),
            "source": it.get("source", "") or it.get("channel", "") or source_hint,
        }
        sigs = it.get("signals") or []
        if sigs:
            ref["signal"] = ",".join(str(s.get("type", "")) for s in sigs if isinstance(s, dict))
        else:
            ref["signal"] = it.get("subject", "") or ""
        refs.append(ref)
    if invitation is not None and not refs:
        refs.append({
            "interaction_id": "",
            "raw_record_ref": "",
            "source": "invitation",
            "signal": f"isCheckIn={invitation.get('isCheckIn', '')} isMeeting={invitation.get('isMeeting', '')}",
        })
    return refs


# ─────────────────────────────────────────────────────────────
# 8. due_at 计算
# ─────────────────────────────────────────────────────────────

def _due_at(action: str, now: Optional[str], cfg: dict) -> str:
    now_dt = _parse_dt(now) if now else datetime.now(timezone.utc)
    if action == NURTURE:
        days = _int(cfg.get("nurture_interval_days"), 30)
        return (now_dt + timedelta(days=days)).isoformat()
    return now_dt.isoformat()


# ─────────────────────────────────────────────────────────────
# 9. 主入口（纯函数）
# ─────────────────────────────────────────────────────────────

def evaluate_next_action(
    customer: Optional[dict] = None,
    opportunity: Optional[dict] = None,
    invitation: Optional[dict] = None,
    interactions: Optional[list] = None,
    meta: Optional[dict] = None,
    automation_state: Optional[dict] = None,
    now: Optional[str] = None,
    config: Optional[dict] = None,
) -> dict:
    """展会自动营销决策主入口（无副作用）。

    参数全部只读。返回 action / reason / excluded_reason / due_at /
    evidence_refs / requires_approval / idempotency_key / rule_version。
    """
    customer = customer or {}
    opportunity = opportunity or {}
    interactions = [it for it in (interactions or []) if isinstance(it, dict)]
    meta = meta or {}
    cfg = _resolve_config(config, meta)

    opp_key = opportunity_key_of(opportunity, customer, invitation)
    stage = (meta.get("exhibition_stage") or "").strip()

    # 1. 排除层（硬停止触达）
    excluded, excl_reason = _exclude(customer, opportunity, invitation)
    if excluded:
        return {
            "action": NONE,
            "reason": f"停止触达：{excl_reason}",
            "excluded_reason": excl_reason,
            "due_at": "",
            "evidence_refs": [],
            "requires_approval": False,
            "idempotency_key": "",
            "rule_version": RULE_VERSION,
        }

    # 2. 单活跃互斥（同一 opportunity 只能一个 active automation）
    active = _find_active(automation_state, opp_key)
    if active is not None:
        return {
            "action": NONE,
            "reason": f"已有 active automation（{active.get('action')}），等待完成",
            "excluded_reason": "",
            "due_at": "",
            "evidence_refs": [],
            "requires_approval": False,
            "idempotency_key": "",
            "rule_version": RULE_VERSION,
        }

    # 3. 主分流
    # 有邀约记录 = invitation 非 None 且至少一个关键字段非空（companyCdpId/companyName/sendTime）
    has_invitation = invitation is not None and _has(
        (invitation or {}).get("companyCdpId") or (invitation or {}).get("companyName")
        or (invitation or {}).get("sendTime") or (invitation or {}).get("exhibitionId")
    )

    checkin = _int((invitation or {}).get("isCheckIn", 0) or (invitation or {}).get("is_checkin", 0))
    touch = _derive_touch(customer, invitation if has_invitation else None, interactions)
    replied = _has_reply(customer, invitation if has_invitation else None, interactions)
    meeting_evidence = _has_meeting_evidence(invitation if has_invitation else None, interactions)

    def _result(action: str, reason: str, approval: bool, key: str) -> dict:
        return {
            "action": action,
            "reason": reason,
            "excluded_reason": "",
            "due_at": _due_at(action, now, cfg),
            "evidence_refs": _evidence_refs(interactions, invitation if has_invitation else None),
            "requires_approval": approval,
            "idempotency_key": key,
            "rule_version": RULE_VERSION,
        }

    def _no_action(reason: str) -> dict:
        return {
            "action": NONE,
            "reason": reason,
            "excluded_reason": "",
            "due_at": "",
            "evidence_refs": [],
            "requires_approval": False,
            "idempotency_key": "",
            "rule_version": RULE_VERSION,
        }

    ra = cfg.get("requires_approval", {})

    # ── 从未邀约 ──
    if not has_invitation:
        if stage in cfg.get("first_invite_stages", []):
            return _result(
                FIRST_INVITE,
                f"未邀约，阶段「{stage or '未知'}」允许首邀",
                bool(ra.get(FIRST_INVITE, True)),
                idempotency_key(FIRST_INVITE, opp_key),
            )
        return _no_action(f"未邀约，但阶段「{stage or '未知'}」不在首邀阶段")

    # ── 已邀约 ──
    # 到场
    if checkin == CHECKIN_ARRIVED:
        if meeting_evidence:
            return _result(
                ONSITE_FOLLOWUP,
                "已到场且有会议/商洽证据，匹配会议记录跟进",
                bool(ra.get(ONSITE_FOLLOWUP, True)),
                idempotency_key(ONSITE_FOLLOWUP, opp_key),
            )
        return _result(
            MISSED_MEETING_REENGAGE,
            "已到场但无会议/商洽证据，再触达约见面",
            bool(ra.get(MISSED_MEETING_REENGAGE, True)),
            idempotency_key(MISSED_MEETING_REENGAGE, opp_key),
        )

    # 未到场（2 暂未 / 3 未到 / 未知）
    # nurture：多轮无回复
    if touch >= _int(cfg.get("nurture_touch_threshold"), 3) and not replied:
        return _result(
            NURTURE,
            f"已触达 {touch} 轮无回复，转长期培育",
            bool(ra.get(NURTURE, False)),
            idempotency_key(NURTURE, opp_key),
        )

    # 二次邀约：未用尽且展中
    second_count = _count_action(automation_state, SECOND_INVITE, opp_key)
    if second_count < _int(cfg.get("second_invite_max"), 1) and stage in cfg.get("second_invite_stages", []):
        return _result(
            SECOND_INVITE,
            f"已邀约未到场（isCheckIn={checkin or '未知'}），二次邀约补发（第 {second_count + 1} 次）",
            bool(ra.get(SECOND_INVITE, False)),
            idempotency_key(SECOND_INVITE, opp_key),
        )

    # 其余：无动作
    return _no_action(
        f"已邀约未到场，但二次邀约已用尽（{second_count}/{cfg.get('second_invite_max')}）"
        f"或阶段「{stage or '未知'}」不在展中，暂不动作"
    )


# ─────────────────────────────────────────────────────────────
# 10. automations store（长期状态写 memory，轻量读写 + 单活跃互斥）
# ─────────────────────────────────────────────────────────────

AUTOMATIONS_FILENAME = "automations.json"


def _memory_dir(company_id: str, workspace_root: Optional[str] = None) -> Path:
    root = Path(workspace_root) if workspace_root else Path(__file__).resolve().parents[2]
    return root / "data" / "memory" / str(company_id)


def automations_path(company_id: str, workspace_root: Optional[str] = None) -> Path:
    return _memory_dir(company_id, workspace_root) / AUTOMATIONS_FILENAME


def load_automations(company_id: str, workspace_root: Optional[str] = None) -> dict:
    """读 automations.json，返回标准结构（不存在则返回空结构，不写文件）。"""
    p = automations_path(company_id, workspace_root)
    if not p.exists():
        return {"schema_version": 1, "company_id": str(company_id), "automations": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"schema_version": 1, "company_id": str(company_id), "automations": []}
    if not isinstance(data, dict):
        return {"schema_version": 1, "company_id": str(company_id), "automations": []}
    data.setdefault("schema_version", 1)
    data.setdefault("company_id", str(company_id))
    data.setdefault("automations", [])
    return data


def save_automations(company_id: str, data: dict, workspace_root: Optional[str] = None) -> Path:
    """原子写 automations.json（内存态，长期状态落 memory）。"""
    p = automations_path(company_id, workspace_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    data = dict(data)
    data["company_id"] = str(company_id)
    data["schema_version"] = data.get("schema_version", 1)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return p


def activate_automation(company_id: str, rec: dict, workspace_root: Optional[str] = None) -> dict:
    """激活一条 automation，强制单活跃：同 opportunity 的旧 active 置 completed。

    只写流程状态 + 引用，不写正文。返回 {"ok", "record", "path"}。
    """
    data = load_automations(company_id, workspace_root)
    opp_key = rec.get("opportunity_id", "")

    automations = data["automations"]
    for a in automations:
        if a.get("opportunity_id") == opp_key and a.get("status") == "active":
            a["status"] = "completed"
            a["updated_at"] = _now()

    rec = dict(rec)
    rec.setdefault("automation_id", "am_" + _stable_id(rec.get("idempotency_key", ""), _now()))
    rec.setdefault("status", "active")
    rec.setdefault("created_at", _now())
    rec["updated_at"] = _now()
    automations.append(rec)

    p = save_automations(company_id, data, workspace_root)
    return {"ok": True, "record": rec, "path": str(p)}


def complete_automation(company_id: str, automation_id: str, status: str = "completed",
                        execution_ref: Optional[str] = None,
                        workspace_root: Optional[str] = None) -> dict:
    """完成/取消一条 automation，记录执行引用（draft_id/resend_id/message_id）。"""
    data = load_automations(company_id, workspace_root)
    for a in data["automations"]:
        if a.get("automation_id") == automation_id:
            a["status"] = status
            a["executed_at"] = _now()
            if execution_ref:
                a["execution_ref"] = execution_ref
            a["updated_at"] = _now()
            save_automations(company_id, data, workspace_root)
            return {"ok": True, "record": a, "status": status}
    return {"ok": False, "error": "automation_not_found", "automation_id": automation_id}


# ─────────────────────────────────────────────────────────────
# CLI（调试用）
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="展会自动营销决策（纯函数，调试用）")
    ap.add_argument("--customer", default="{}", help="customer JSON")
    ap.add_argument("--opportunity", default="{}", help="opportunity JSON")
    ap.add_argument("--invitation", default="null", help="invitation JSON 或 null")
    ap.add_argument("--interactions", default="[]", help="interactions JSON 数组")
    ap.add_argument("--meta", default="{}", help="meta JSON")
    ap.add_argument("--automation-state", default="null", help="automation_state JSON 或 null")
    ap.add_argument("--now", default="", help="ISO 时间（缺省 now）")
    ap.add_argument("--config", default="{}", help="config JSON 覆盖")
    args = ap.parse_args()

    invitation = json.loads(args.invitation) if args.invitation not in ("null", "") else None
    automation_state = json.loads(args.automation_state) if args.automation_state not in ("null", "") else None

    result = evaluate_next_action(
        customer=json.loads(args.customer),
        opportunity=json.loads(args.opportunity),
        invitation=invitation,
        interactions=json.loads(args.interactions),
        meta=json.loads(args.meta),
        automation_state=automation_state,
        now=args.now or None,
        config=json.loads(args.config),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
