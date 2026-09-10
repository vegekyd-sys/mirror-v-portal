#!/usr/bin/env python3
"""enterprise_ids.py — 单租户企业身份统一。

唯一权威主键是当前租户的 supplier_id（MIO_CDP_SUPPLIER_ID）。历史版本曾把
lpskcom / ingiatradecom / xuetelang 等 slug 写死映射到具体企业，导致 payload
无法通用于新租户，也造成同一 supplier_id/slug 数据分裂。

本模块只保留通用规则：
- 空值 / testco / 历史 slug → 当前租户 supplier_id（有配置时）；
- 明确数字 supplier_id 原样返回；
- 未配置当前租户时，未知值原样返回，避免猜测。
"""

import os

from _tenant_env import load_tenant_env

load_tenant_env()


def _current_supplier_id() -> str:
    """当前单租户 supplier_id（tenant-env 优先，.env 兜底）。"""
    return os.environ.get("MIO_CDP_SUPPLIER_ID", "").strip()


def canonical_company_id(company_id: str) -> str:
    """把历史 company_id/slug 归一为当前租户 supplier_id，不包含企业硬编码。"""
    cid = (company_id or "").strip()
    current = _current_supplier_id()
    if not cid or cid == "testco":
        return current
    if cid.isdigit():
        return cid
    # 单租户运行时出现 slug，统一归到当前租户；未配置时保留原值供上层报错/补配置。
    return current or cid


def slug_for(company_id: str) -> str:
    """历史兼容入口：通用版不再维护 slug 映射，返回规范 company_id。"""
    return canonical_company_id(company_id)
