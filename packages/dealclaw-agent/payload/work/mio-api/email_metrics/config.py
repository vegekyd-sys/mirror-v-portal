#!/usr/bin/env python3
"""email_metrics.config — 统计口径开关（legacy | shadow | v1）+ 业务时区。

设计依据：`docs/email-metrics-v1.md`。

**默认必须是 `legacy`**：开关读不到、写错、环境变量不存在时，线上行为一律不变。
口径开关的失败模式只能是「不变」，绝不能是「换口径」——所以非法值一律回退 legacy
并记一条告警，不抛异常。

按租户覆盖（从具体到全局，先命中先用）：

  1. `DC_EMAIL_METRICS_MODE_<TENANT>`    租户 slug，如 `DC_EMAIL_METRICS_MODE_MEORIENT`
  2. `DC_EMAIL_METRICS_MODE_<COMPANY>`   企业 id，如 `DC_EMAIL_METRICS_MODE_152600996207`
  3. `DC_EMAIL_METRICS_MODE`             全局默认
  4. 缺省 → `legacy`

`tenant-env.json`（见 `_tenant_env.load_tenant_env`）的键会被塞进 `os.environ`，
所以「按租户」既可以走部署环境变量，也可以写进租户可写配置，二者等价。

期间口径同理：`DC_REPORT_TIMEZONE_<TENANT>` > `DC_REPORT_TIMEZONE` > `Asia/Shanghai`。
"""
from __future__ import annotations

import logging
import os
import re

logger = logging.getLogger(__name__)

# ── 口径取值 ─────────────────────────────────────────────
MODE_LEGACY = "legacy"   # 旧口径（兼容修复后），线上默认
MODE_SHADOW = "shadow"   # 双读：用户可见 = 旧口径；v1 只算不展示，只记差异
MODE_V1 = "v1"           # 用户可见 = 统一口径 metrics_view
MODES = (MODE_LEGACY, MODE_SHADOW, MODE_V1)
DEFAULT_MODE = MODE_LEGACY

MODE_ENV = "DC_EMAIL_METRICS_MODE"
TZ_ENV = "DC_REPORT_TIMEZONE"
SHADOW_DIR_ENV = "DC_EMAIL_METRICS_SHADOW_DIR"

DEFAULT_REPORT_TZ = "Asia/Shanghai"

_NON_KEY = re.compile(r"[^A-Z0-9]+")


def env_key(base: str, name: str | None) -> str:
    """`DC_EMAIL_METRICS_MODE` + `meorient` → `DC_EMAIL_METRICS_MODE_MEORIENT`。

    企业 id 是纯数字时保留（`..._152600996207`）；
    其它字符统一转 `_`，空名返回空串。
    """
    n = _NON_KEY.sub("_", str(name or "").strip().upper()).strip("_")
    return f"{base}_{n}" if n else ""


def normalize_mode(value: str | None, *, source: str = "") -> str:
    """把任意输入归一成三种口径之一；非法/空 → legacy（并告警）。"""
    v = str(value or "").strip().lower()
    if v in MODES:
        return v
    if v:
        logger.warning("[email_metrics.config] 非法口径 %r（来源 %s）→ 回退 %s",
                       value, source or "unknown", DEFAULT_MODE)
    return DEFAULT_MODE


def mode_env_names(tenant: str | None = None, company_id: str | None = None) -> tuple[str, ...]:
    """按优先级返回候选环境变量名（可能含空串位置，已过滤）。"""
    names = [env_key(MODE_ENV, tenant), env_key(MODE_ENV, company_id), MODE_ENV]
    return tuple(n for n in names if n)


def resolve_mode(tenant: str | None = None, company_id: str | None = None) -> str:
    """解析当前生效口径。读不到 → legacy。"""
    for name in mode_env_names(tenant, company_id):
        if name in os.environ:
            return normalize_mode(os.environ.get(name), source=name)
    return DEFAULT_MODE


def tz_env_names(tenant: str | None = None) -> tuple[str, ...]:
    names = [env_key(TZ_ENV, tenant), TZ_ENV]
    return tuple(n for n in names if n)


def resolve_report_timezone(tenant: str | None = None) -> str:
    """企业业务时区（日报归属日期用它现算）。默认 Asia/Shanghai。"""
    for name in tz_env_names(tenant):
        v = (os.environ.get(name) or "").strip()
        if v:
            return v
    return DEFAULT_REPORT_TZ


def describe(tenant: str | None = None, company_id: str | None = None) -> dict:
    """诊断用：当前口径、由哪个键决定、候选键与业务时区。"""
    names = mode_env_names(tenant, company_id)
    hit = next((n for n in names if n in os.environ), "")
    return {
        "mode": resolve_mode(tenant, company_id),
        "decided_by": hit or "(default)",
        "candidates": list(names),
        "report_timezone": resolve_report_timezone(tenant),
        "modes": list(MODES),
    }
