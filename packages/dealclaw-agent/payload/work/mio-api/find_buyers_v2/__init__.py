#!/usr/bin/env python3
"""find_buyers_v2 — 影子阶段的可离线运行版本（纯函数，零副作用）。

模块：
  normalize : 归一化 / 字段检查 / 展会ID核验 / 确定性去重
  summarize : 模型输入摘要化 + fixture 脱敏
  pipeline  : legacy | shadow | v2 三模式 + 联系方式后置计划
  replay    : 固定 fixture 上的 legacy vs v2 A/B（离线可复现）
"""
from find_buyers_v2.normalize import (  # noqa: F401
    dedupe, field_issues, matches_exhibition, normalize_record, rank_for_delivery,
)
from find_buyers_v2.pipeline import (  # noqa: F401
    MODES, compare_delivery, contact_plan, flatten_pages, run_legacy, run_shadow, run_v2,
)
from find_buyers_v2.summarize import estimate_tokens, model_summary, redact_for_fixture  # noqa: F401

__all__ = [
    "MODES", "normalize_record", "field_issues", "matches_exhibition", "dedupe",
    "rank_for_delivery", "model_summary", "estimate_tokens", "redact_for_fixture",
    "flatten_pages", "run_legacy", "run_v2", "run_shadow", "compare_delivery", "contact_plan",
]
