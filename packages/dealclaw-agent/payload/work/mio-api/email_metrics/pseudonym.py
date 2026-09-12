#!/usr/bin/env python3
"""email_metrics.pseudonym — 稳定假名（只读诊断导出专用）。

要求：导出包**不含**正文 / 附件 / PII / 配置，但导出后仍要能保持
「消息 ↔ 线程 ↔ 买家」的关联关系。

做法：`HMAC-SHA256(salt, f"{kind}:{value}")` 取前 12 位十六进制 + 角色前缀。

盐来自 `DC_DIAGNOSTIC_SALT`；缺省用固定常量 `dealclaw-diag-v1`。
固定盐只保证**稳定性**（同值同假名、可跨次导出对齐），
不保证抗暴力枚举——所以导出包本身仍按「不可外发」对待。
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re

DEFAULT_SALT = "dealclaw-diag-v1"
_LEN = 12


def _salt() -> bytes:
    return (os.environ.get("DC_DIAGNOSTIC_SALT") or DEFAULT_SALT).encode("utf-8")


def pseudonym(kind: str, value: str) -> str:
    """稳定假名：`<kind>_<12hex>`。空值返回空串，不返回 'None'。"""
    if value is None:
        return ""
    v = str(value).strip()
    if not v:
        return ""
    digest = hmac.new(_salt(), f"{kind}:{v}".encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{kind}_{digest[:_LEN]}"


def buyer_key(value: str) -> str:
    return pseudonym("buyer", value)


def message_key(value: str) -> str:
    return pseudonym("msg", value)


def thread_key(value: str) -> str:
    return pseudonym("thread", value)


def event_key(value: str) -> str:
    return pseudonym("ev", value)


def normalize_email(value: str) -> str:
    """归一化邮箱（去空白 + 小写），仅用于去重键，不用于展示。"""
    if not value:
        return ""
    return str(value).strip().lower()


def looks_like_email(value: str) -> bool:
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", (value or "").strip()))
