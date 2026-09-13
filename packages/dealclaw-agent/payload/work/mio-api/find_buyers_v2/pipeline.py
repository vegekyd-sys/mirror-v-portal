#!/usr/bin/env python3
"""find_buyers_v2.pipeline — legacy / shadow / v2 三模式（纯函数，零副作用）。

约束（田耕郡 2026-09-13）：
  - shadow：**只请求一次搜索接口**，同一份响应同时喂给 legacy 与 v2；
    v2 不写线索池、不发卡、不产生任何副作用（本模块不持有任何 I/O 能力，结构上保证）。
  - v2 只做确定性前置（归一化 → 展会ID核验 → 字段检查 → 确定性去重 → 模型摘要）；
    同行 / 采购角色 / 产品关系**由模型语义判断**，禁止关键词脚本直接剔除。
  - 联系方式后置：先留 Top20 候选，再分批查联系人，直到拿到 target 家合格结果或候选耗尽；
    用户没要求联系方式时跳过 contact 阶段。
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Callable, Iterable, Optional

_HERE = Path(__file__).resolve().parent
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

from find_buyers_v2.normalize import (  # noqa: E402
    dedupe, field_issues, matches_exhibition, normalize_record, rank_for_delivery,
)
from find_buyers_v2.summarize import estimate_tokens, model_summary  # noqa: E402

MODES = ("legacy", "shadow", "v2")

# 联系方式批查默认参数（第 9 条）
CONTACT_POOL = 20
CONTACT_BATCH = 5


def flatten_pages(raw_pages: Iterable[dict]) -> list[dict]:
    """把一个或多个分页响应摊平成 (record, page, position) 列表，顺序即接口返回顺序。"""
    rows: list[dict] = []
    for p in raw_pages or []:
        page_no = p.get("page")
        for idx, rec in enumerate(p.get("records") or [], start=1):
            rows.append({"record": rec, "page": page_no, "position": idx})
    return rows


def _ident(norm: dict) -> str:
    return norm.get("key_domain") or norm.get("key_company") or norm.get("company") or ""


# ── legacy：当前链路（离线等价口径）──
def run_legacy(raw_pages, *, deliver_limit: int = 10) -> dict:
    """legacy 离线口径：按接口返回顺序取前 N（现行语义：不做确定性前置过滤）。"""
    rows = flatten_pages(raw_pages)
    delivered = [r["record"] for r in rows[:deliver_limit]]
    return {
        "mode": "legacy",
        "considered": len(rows),
        "delivered": delivered,
        "delivered_count": len(delivered),
        "excluded": [],
        "model_input": [],
    }


# ── v2：确定性前置 + 模型语义判断（注入式）──
def run_v2(raw_pages, *, deliver_limit: int = 10,
           target_exhibition_ids: Iterable[str] = (),
           semantic_judge: Optional[Callable[[list[dict]], Optional[list[bool]]]] = None,
           need_contact: bool = False,
           rank: str = "score") -> dict:
    """v2 流水线（纯函数）。

    semantic_judge: 接收模型摘要行，返回等长布尔列表（True=保留）；返回 None 表示不判、全保留。
    联系方式只出**计划**，不在这里发请求（第 9、10 条）。
    """
    norms = [normalize_record(r["record"], page=r["page"], position=r["position"])
             for r in flatten_pages(raw_pages)]
    excluded: list[dict] = []

    # 1) 展会ID核验（确定性）
    if target_exhibition_ids:
        kept = []
        for n in norms:
            if matches_exhibition(n, target_exhibition_ids):
                kept.append(n)
            else:
                excluded.append({**n, "excluded_reason": "展会ID不匹配"})
        norms = kept

    # 2) 字段检查（只标问题，不剔除）
    for n in norms:
        n["field_issues"] = field_issues(n)

    # 3) 确定性去重
    norms, dropped = dedupe(norms)
    excluded.extend(dropped)

    # 4) 模型摘要（语义判断的输入）
    model_input = model_summary(norms)

    # 5) 模型语义判断（同行 / 采购角色 / 产品关系）——禁止脚本替代
    if semantic_judge is not None:
        verdicts = semantic_judge(model_input)
        if verdicts is not None:
            kept = []
            for n, ok in zip(norms, list(verdicts) + [True] * len(norms)):
                if ok is False:
                    excluded.append({**n, "excluded_reason": "模型语义剔除"})
                else:
                    kept.append(n)
            norms = kept

    # 排序口径：score=按五维分（实测会把平台/服务商顶上来，不推荐）；
    #           api=保留接口综合序（确定性只剔重/剔展会不符，不改次序）
    if rank == "api":
        ranked = sorted(norms, key=lambda n: (n.get("page") if n.get("page") is not None else 10 ** 6,
                                              n.get("position") if n.get("position") is not None else 10 ** 6))
    else:
        ranked = rank_for_delivery(norms)
    delivered = ranked[:deliver_limit]

    return {
        "mode": "v2",
        "rank": rank,
        "considered": len(norms) + len(dropped),
        "kept": len(norms),
        "delivered": delivered,
        "delivered_count": len(delivered),
        "excluded": excluded,
        "model_input": model_input,
        "model_input_tokens": estimate_tokens(model_input),
        "field_issue_count": sum(1 for n in norms if n.get("field_issues")),
        "contact_plan": contact_plan(ranked, need_contact=need_contact),
    }


def contact_plan(ranked: list[dict], *, need_contact: bool, target: int = 10,
                 pool: int = CONTACT_POOL, batch: int = CONTACT_BATCH) -> dict:
    """联系方式后置计划（第 9、10 条）：先留 Top `pool`，再按 `batch` 分批查，够 `target` 家即停。"""
    if not need_contact:
        return {"skipped": True, "reason": "用户未要求联系方式", "batches": []}
    head = ranked[:max(int(pool), int(target))]
    batches = [head[i:i + batch] for i in range(0, len(head), batch)]
    return {
        "skipped": False,
        "target": int(target),
        "pool": len(head),
        "batch_size": int(batch),
        "batches": len(batches),
    }


def run_shadow(raw_pages, **kwargs) -> dict:
    """影子模式：同一份响应同时喂 legacy 与 v2，返回两侧结果与差异。

    **零副作用**：本模块不做任何 I/O；调用方负责「只请求一次接口」。
    """
    deliver_limit = int(kwargs.pop("deliver_limit", 10))
    legacy = run_legacy(raw_pages, deliver_limit=deliver_limit)
    v2 = run_v2(raw_pages, deliver_limit=deliver_limit, **kwargs)
    return {"mode": "shadow", "legacy": legacy, "v2": v2,
            "diff": compare_delivery(legacy, v2)}


def compare_delivery(legacy: dict, v2: dict) -> dict:
    """legacy / v2 交付集合对比（身份 = 域名优先、其次公司名）。"""
    def ids(result: dict) -> list[str]:
        out = []
        for rec in result.get("delivered") or []:
            if isinstance(rec, dict) and rec.get("key_domain") is not None:
                ident = _ident(rec)
            elif isinstance(rec, dict):
                from find_buyers_v2.normalize import normalize_record
                ident = _ident(normalize_record(rec))
            else:
                ident = ""
            out.append(ident)
        return out

    l_ids, v_ids = ids(legacy), ids(v2)
    same_order = sum(1 for a, b in zip(l_ids, v_ids) if a == b)
    return {
        "legacy_count": len(l_ids),
        "v2_count": len(v_ids),
        "common": sorted(set(l_ids) & set(v_ids)),
        "only_legacy": [x for x in l_ids if x not in set(v_ids)],
        "only_v2": [x for x in v_ids if x not in set(l_ids)],
        "same_position": same_order,
        "order_agreement": round(same_order / max(len(l_ids), 1), 3),
        # 主指标：集合重叠率（两者交付集合交集 / 较大集合）
        "overlap_ratio": round(len(set(l_ids) & set(v_ids)) / max(len(set(l_ids) | set(v_ids)), 1), 3),
    }
