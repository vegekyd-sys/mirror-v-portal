#!/usr/bin/env python3
# -- coding: UTF-8 --
"""dc_after_exhibition_recommend.py — 展后买家推荐

核心规则：**本届展会名单决定「谁能进入」，线索池只决定「进入后如何判断和跟进」。**

只处理本届展会线索清单（candidate.exhibition_id == target_exhibition_id）中的买家，
线索池仅用于主体去重、补充历史沟通、判断建联状态、避免重复冷启动，不扩充候选。

本次用 mock 字段开发，接口 adapter 与业务判断分离，9/8 真实数据回来只校准 adapter 字段映射，
不重写推荐逻辑。

展后四组：
  uncontacted_recommendations   未触达的理想买家（到展但无邀约/扫码/沟通）
  contacted_but_not_connected   已触达但未建联成功（最高优先跟进组）
  connected_followups           已建联待推进（不进入「新买家推荐」，独立跟进任务）
  suppressed                    不再推荐（拒绝/身份不匹配/取消/黑名单/人工排除）
"""

from __future__ import annotations

from typing import Any, Optional

# 买家类型 companyAttributes 枚举
ATTR_LABEL = {1: "生产商", 2: "分销商", 3: "零售商", 4: "品牌", 5: "商超"}

# 建联成功信号字段（5 条件任一即算）
CONNECTED_FIELDS = (
    "isMeeting",                 # 邀约记录 isMeeting=1（实际商洽）
    "has_meeting_interaction",   # 有已完成且有实际沟通内容的 meeting interaction
    "email_replied",             # 邮件 inbound/replied
    "wa_bidirectional",          # WA 买家回复/双向
    "manual_confirmed_connected",# 用户人工确认已实际沟通
    "historical_connected",      # 线索池历史已有双向沟通
)

# 触达信号字段（有触达但未建联成功）
TOUCH_FIELDS = (
    "has_invitation",            # 有邀约
    "has_scan",                  # 有扫码
    "has_email_out",             # 有单向邮件
    "has_wa_out",                # 有单向 WA
    "historical_contacted",      # 线索池历史单向触达
)

# 不再推荐信号字段
SUPPRESSED_FIELDS = (
    "denied",                    # 明确拒绝
    "identity_mismatch",         # 身份不匹配
    "cancelled",                 # 项目取消
    "blacklisted",               # 黑名单
    "historical_suppressed",     # 线索池历史拒绝/黑名单
    "manual_excluded",           # 人工排除
)


def _has(v) -> bool:
    if v is None:
        return False
    if isinstance(v, bool):
        return v is True
    if isinstance(v, (int, float)):
        return v == 1
    return str(v).strip() in ("1", "true", "True", "yes")


def _domain(website: str) -> str:
    """从官网 URL 提取域名（去重用）。"""
    s = (website or "").strip().lower()
    s = s.replace("http://", "").replace("https://", "").split("/")[0]
    s = s.split(":")[0]
    return s


# ─────────────────────────────────────────────────────────────
# 1. 候选范围门禁
# ─────────────────────────────────────────────────────────────

def is_in_scope(buyer: dict, target_exhibition_id: str) -> bool:
    """候选门禁：必须归属本届展会（exhibition_id == target），且至少一条本届来源证据。"""
    if not target_exhibition_id:
        return False
    if str(buyer.get("exhibition_id") or "") != str(target_exhibition_id):
        return False
    # 至少一条本届来源证据
    return bool(buyer.get("source"))


# ─────────────────────────────────────────────────────────────
# 2. 企业级去重
# ─────────────────────────────────────────────────────────────

def _merge_into(target: dict, incoming: dict) -> None:
    """合并：保留 target，追加 incoming 的来源/互动，不覆盖历史。"""
    # exhibition_id 冲突检测（来源记录归属矛盾 → 标 conflicted，不自动纳入）
    if str(target.get("exhibition_id") or "") != str(incoming.get("exhibition_id") or ""):
        target["exhibition_conflict"] = True
        incoming["exhibition_conflict"] = True
    target["sources"] = list(dict.fromkeys(target.get("sources", []) + incoming.get("sources", [])))
    # 信号字段取「或」（任一来源命中即保留）
    for f in CONNECTED_FIELDS + TOUCH_FIELDS + SUPPRESSED_FIELDS:
        if _has(incoming.get(f)) and not _has(target.get(f)):
            target[f] = incoming.get(f)


def dedupe(buyers: list) -> list:
    """去重：companyCdpId 相同 → 合并；域名相同 → 合并；公司名+国家相同 → 标待确认（不自动合并）。"""
    by_cdp: dict[str, dict] = {}
    by_domain: dict[str, dict] = {}
    out: list = []
    for b in buyers:
        cdp = str(b.get("companyCdpId") or "").strip()
        domain = _domain(b.get("website", ""))
        if cdp and cdp in by_cdp:
            _merge_into(by_cdp[cdp], b)
            continue
        if domain and domain in by_domain:
            _merge_into(by_domain[domain], b)
            continue
        # 公司名+国家 soft-match：相同则标「待确认」，不自动合并（保留两条，标记）
        for prev in out:
            if prev.get("companyName") == b.get("companyName") and prev.get("country") == b.get("country") \
                    and prev.get("companyName"):
                b["dedupe_pending"] = True
                prev["dedupe_pending"] = True
                break
        if cdp:
            by_cdp[cdp] = b
        if domain:
            by_domain[domain] = b
        out.append(b)
    return out


# ─────────────────────────────────────────────────────────────
# 3. 线索池补充历史（不扩充候选）
# ─────────────────────────────────────────────────────────────

def enrich(candidates: list, historical_pool: Optional[list]) -> tuple[list, int]:
    """从线索池补充历史信息（主体去重匹配），返回 (enriched, enriched_count)。"""
    pool = [h for h in (historical_pool or []) if isinstance(h, dict)]
    by_cdp = {str(h.get("companyCdpId") or ""): h for h in pool if h.get("companyCdpId")}
    by_domain = {_domain(h.get("website", "")): h for h in pool if _domain(h.get("website", ""))}

    enriched_count = 0
    for c in candidates:
        cdp = str(c.get("companyCdpId") or "")
        domain = _domain(c.get("website", ""))
        h = by_cdp.get(cdp) or by_domain.get(domain)
        if not h:
            continue
        enriched_count += 1
        c["lead_pool_enriched"] = True
        # 历史沟通状态影响建联/触达/排除判断
        if _has(h.get("has_reply")) or _has(h.get("bidirectional")):
            c["historical_connected"] = True
        elif _has(h.get("has_outbound")):
            c["historical_contacted"] = True
        if _has(h.get("denied")) or _has(h.get("blacklisted")):
            c["historical_suppressed"] = True
        # 补充联系人/跟进状态（只读，不写回）
        c["historical"] = {k: h.get(k) for k in ("contact", "followup_status", "last_touch") if k in h}
    return candidates, enriched_count


# ─────────────────────────────────────────────────────────────
# 4. 建联状态判断
# ─────────────────────────────────────────────────────────────

def is_connected(buyer: dict) -> bool:
    """建联成功判定：5 条件任一即算（会面 / 会议 / 邮件回复 / WA 双向 / 人工确认 / 历史双向）。"""
    return any(_has(buyer.get(f)) for f in CONNECTED_FIELDS)


def has_touch(buyer: dict) -> bool:
    """是否有触达动作（邀约/扫码/单向邮件/单向 WA/历史单向），未建联成功。"""
    return any(_has(buyer.get(f)) for f in TOUCH_FIELDS)


def is_suppressed(buyer: dict) -> bool:
    """是否不再推荐（拒绝/身份不匹配/取消/黑名单/人工排除/历史拒绝）。"""
    return any(_has(buyer.get(f)) for f in SUPPRESSED_FIELDS)


# ─────────────────────────────────────────────────────────────
# 5. 理想画像匹配
# ─────────────────────────────────────────────────────────────

def matches_ideal(buyer: dict, ideal_profile: Optional[dict]) -> bool:
    """是否匹配理想买家画像（产品/采购标签有交集）。"""
    if not ideal_profile:
        return True
    ideal_products = {str(x).strip().lower() for x in ideal_profile.get("products", []) if str(x).strip()}
    if not ideal_products:
        return True
    tags = {str(x).strip().lower() for x in buyer.get("product_tags", []) if str(x).strip()}
    return bool(tags & ideal_products)


# ─────────────────────────────────────────────────────────────
# 6. 排序 + 理由
# ─────────────────────────────────────────────────────────────

def _sort_key(buyer: dict, ideal_profile: Optional[dict]) -> tuple:
    """排序键（不暴露内部评分，只用于内部排序）。"""
    ideal_products = {str(x).strip().lower() for x in (ideal_profile or {}).get("products", []) if str(x).strip()}
    tags = {str(x).strip().lower() for x in buyer.get("product_tags", []) if str(x).strip()}
    tag_match = len(tags & ideal_products)
    confirmed_onsite = 1 if _has(buyer.get("confirmed_onsite")) else 0
    has_contact = 1 if _has(buyer.get("has_contact")) else 0
    channel = 1 if buyer.get("channel") else 0
    return (-tag_match, -confirmed_onsite, -channel, -has_contact)


def build_reason(buyer: dict) -> str:
    """生成具体推荐理由（证据化，不输出不可解释评分）。"""
    reasons: list = []
    if _has(buyer.get("confirmed_onsite")):
        reasons.append("本届确认到展")
    tags = buyer.get("product_tags") or []
    if tags:
        reasons.append(f"采购标签含 {', '.join(str(t) for t in tags[:3])}")
    if buyer.get("channel"):
        reasons.append(f"属{buyer['channel']}渠道")
    if _has(buyer.get("has_contact")):
        reasons.append("有效联系方式可用")
    if not is_connected(buyer):
        reasons.append("未发现实际会面或买家回复，建议展后优先补联")
    return "；".join(reasons)


def rank(buyers: list, ideal_profile: Optional[dict]) -> list:
    """排序（画像匹配 > 确认到展 > 渠道 > 联系方式），每条附理由。"""
    for b in buyers:
        b["reason"] = build_reason(b)
    return sorted(buyers, key=lambda b: _sort_key(b, ideal_profile))


# ─────────────────────────────────────────────────────────────
# 7. 主入口（7 步固定顺序）
# ─────────────────────────────────────────────────────────────

def recommend(
    target_exhibition_id: str,
    candidates: Optional[list] = None,
    historical_pool: Optional[list] = None,
    ideal_profile: Optional[dict] = None,
    exhibition_name: str = "",
    manual_connected: Optional[set] = None,
) -> dict:
    """展后买家推荐主入口。

    顺序固定：
      1. 按 target_exhibition_id 圈定本届候选
      2. 企业级去重
      3. 线索池补充历史
      4. 判断建联状态
      5. 匹配理想画像
      6. 排序 + 理由
      7. 输出统计
    """
    if not target_exhibition_id:
        return {"ok": False, "error": "missing_target_exhibition_id",
                "detail": "缺少 target_exhibition_id，不执行"}

    candidates = [c for c in (candidates or []) if isinstance(c, dict)]
    manual_connected = manual_connected or set()

    # 1. 候选门禁
    in_scope = [c for c in candidates if is_in_scope(c, target_exhibition_id)]
    out_of_scope = len(candidates) - len(in_scope)

    # 2. 企业级去重
    deduped = dedupe(in_scope)

    # 3. 线索池补充历史
    enriched, enriched_count = enrich(deduped, historical_pool)

    # 人工确认建联（覆盖）
    for b in enriched:
        if str(b.get("companyCdpId") or "") in manual_connected:
            b["manual_confirmed_connected"] = True

    # 4+5+6. 分流 + 画像匹配 + 排序理由
    uncontacted, contacted_not_connected, connected_followups, suppressed, conflicted = [], [], [], [], []

    for b in enriched:
        if _has(b.get("exhibition_conflict")):
            conflicted.append(b)
            continue
        if is_suppressed(b):
            suppressed.append(b)
            continue
        if is_connected(b):
            b["followup_kind"] = _followup_kind(b)
            connected_followups.append(b)
            continue
        if not matches_ideal(b, ideal_profile):
            continue  # 不匹配理想画像，不进推荐
        if has_touch(b):
            contacted_not_connected.append(b)
        else:
            uncontacted.append(b)

    uncontacted = rank(uncontacted, ideal_profile)
    contacted_not_connected = rank(contacted_not_connected, ideal_profile)
    connected_followups = rank(connected_followups, ideal_profile)

    # 7. 统计
    attended = len(enriched)
    ideal = sum(1 for b in enriched if matches_ideal(b, ideal_profile))
    connected = len(connected_followups)
    not_connected = len(uncontacted) + len(contacted_not_connected)

    return {
        "ok": True,
        "uncontacted_recommendations": uncontacted,
        "contacted_but_not_connected": contacted_not_connected,
        "connected_followups": connected_followups,
        "suppressed": suppressed,
        "conflicted": conflicted,
        "statistics": {
            "attended_buyers": attended,
            "ideal_buyers": ideal,
            "not_connected": not_connected,
            "connected": connected,
        },
        "scope": {
            "exhibition_id": target_exhibition_id,
            "exhibition_name": exhibition_name,
            "candidate_source": "current_exhibition_only",
            "current_exhibition_candidates": len(in_scope),
            "lead_pool_enriched": enriched_count,
            "out_of_scope_excluded": out_of_scope,
        },
    }


def _followup_kind(buyer: dict) -> str:
    """已建联买家的跟进任务类型（待报价/待寄样/待资料/待会议/已超时）。"""
    for k in ("待报价", "待寄样", "待资料", "待二次会议"):
        if _has(buyer.get(k)) or buyer.get("followup_kind") == k:
            return k
    if _has(buyer.get("overdue")):
        return "跟进已超时"
    return "待推进"


def to_lead_pool(buyer: dict, exhibition_name: str = "") -> dict:
    """展后买家 → 线索池字段映射（来源=展会线索，报名参展展会=具体展会名）。

    所有进入推荐/建联的买家都写线索池（suppressed 不落库，遵循线索池「排除不落」铁律）。
    """
    attrs = buyer.get("companyAttributes") or []
    attr_label = "/".join(ATTR_LABEL.get(int(a), str(a)) for a in attrs if str(a).isdigit()) if attrs else ""
    return {
        "公司名": buyer.get("companyName", ""),
        "官网": buyer.get("website", ""),
        "公司CDPID": buyer.get("companyCdpId", ""),
        "国家": buyer.get("country", ""),
        "买家类型": attr_label,
        "推荐理由": buyer.get("reason", ""),
        "阶段": "跟进中" if is_connected(buyer) else "待触达",
        "来源": "展会线索",
        "报名参展展会": exhibition_name,
    }


def to_lead_pool_batch(result: dict, exhibition_name: str = "") -> list:
    """把推荐结果里「应落线索池」的买家（除 suppressed/conflicted）批量映射为线索池字段。"""
    groups = (
        result.get("uncontacted_recommendations", [])
        + result.get("contacted_but_not_connected", [])
        + result.get("connected_followups", [])
    )
    return [to_lead_pool(b, exhibition_name) for b in groups]


# ─────────────────────────────────────────────────────────────
# 接口 adapter（mock，9/8 校准字段）
# ─────────────────────────────────────────────────────────────

def fetch_after_exhibition(exhibition_id: str, **kwargs) -> list:
    """adapter：after-exhibition-recommend 响应 → 标准买家列表（mock）。

    9/8 接 xiaoyuan company after-exhibition-recommend --exhibition-id <id>，
    只改这里的字段映射，不动业务判断。
    """
    return []  # mock 返回空，真实数据 9/8 接入


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(description="小元-展后买家推荐")
    ap.add_argument("--exhibition-id", required=True, help="目标展会 ID")
    ap.add_argument("--candidates", default="[]", help="本届候选买家 JSON 数组")
    ap.add_argument("--historical-pool", default="[]", help="线索池历史 JSON 数组")
    ap.add_argument("--ideal-profile", default="{}", help="理想画像 JSON")
    args = ap.parse_args()

    result = recommend(
        target_exhibition_id=args.exhibition_id,
        candidates=json.loads(args.candidates),
        historical_pool=json.loads(args.historical_pool),
        ideal_profile=json.loads(args.ideal_profile),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
