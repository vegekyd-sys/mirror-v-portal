#!/usr/bin/env python3
"""enterprise_ids.py — 企业身份口径统一（slug ↔ supplier_id 双向映射）

背景：email-facts / signals / memory 历史上混用两种 company_id：
  - supplier_id（数字，如 151897148668）—— 权威主键，memory 目录、日报、线索池都按它走
  - slug（如 lpskcom）—— registry 键名，早期发送路径误写入

本模块提供唯一权威的 slug↔supplier_id 映射，供发送/记录写入边界做 canonical 归一，
避免再出现「同一企业两条 company_id」的数据分裂。

注意：这是业务映射（3 家已知企业），不是通用注册表；新企业接入时在此补充。
"""

import os

from _tenant_env import load_tenant_env

load_tenant_env()


def _current_supplier_id() -> str:
    """单租户当前 supplier id（tenant-env 优先，.env 兜底）。"""
    return os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()


# slug → supplier_id（权威方向：写入 email-facts/signals 前一律归一成 supplier_id）
SLUG_TO_SUPPLIER_ID = {
    "lpskcom": "151897148668",        # 中亿丰罗普斯金材料科技股份有限公司（LPSK）
    "ingiatradecom": "152598718575",  # 杭州奕歌跨境电商有限公司
}

# supplier_id → slug（registry 查询用）
SUPPLIER_ID_TO_SLUG = {v: k for k, v in SLUG_TO_SUPPLIER_ID.items()}


def canonical_company_id(company_id: str) -> str:
    """把可能的 slug 归一成 supplier_id；空 / 测试残留（testco）归一到单租户当前 supplier id；纯数字 / 未知值原样返回。"""
    cid = (company_id or "").strip()
    if not cid or cid == "testco":
        return _current_supplier_id()
    if cid in SLUG_TO_SUPPLIER_ID:
        return SLUG_TO_SUPPLIER_ID[cid]
    return cid


def slug_for(company_id: str) -> str:
    """supplier_id → slug；未知值返回原值。"""
    return SUPPLIER_ID_TO_SLUG.get((company_id or "").strip(), (company_id or "").strip())
