#!/usr/bin/env python3
"""email_metrics — 邮件事实层 + 唯一统计口径（离线只读）。

设计：`docs/email-metrics-v1.md`

分层：
  adapter.py  旧数据 → 事实层事件（只读，不改原存储）
  facts.py    事件回放 → 消息投递投影（delivered_final / delivered_ever）
  views.py    activity_view / campaign_view / metrics_view（唯一读入口）
  config.py   口径开关 legacy|shadow|v1（按租户）+ 业务时区
  legacy.py   旧口径 Adapter（字段名兼容 + 业务时区「今日」）
  service.py  read_email_metrics：按口径返回，shadow 只记差异，缺失报 partial/unavailable
  reconcile.py 新旧口径对账报告
  pseudonym.py 稳定假名（诊断导出用）

shadow 落盘：`DC_DATA_DIR/email-metrics-shadow/<tenant>/<company>/<YYYY-MM-DD>.jsonl`
（每行含 mode / report_timezone / snapshot_hash / source watermark / legacy / v1 / delta / reasons；
落盘失败不影响主流程输出）。partial / unavailable 时消费方隐藏邮件数字，
并在 context/plan 里带结构化 `data_quality_alert`（只产出对象，不发送消息）。

不变量：
  - 事实层只存 UTC 时间，不存 business_date（日报归属由 view 按 report_timezone 现算）
  - delivery 与 engagement 事件分开；complained/unsubscribed 不覆盖送达状态
  - 无 provider id 的旧 outbound 标 legacy_unverified，不映射为 accepted、不计入 sent
  - accepted / delivered / bounced 不强制凑平，另列 pending / failed / unknown
"""
from __future__ import annotations

from . import schema  # noqa: F401
from .pseudonym import pseudonym  # noqa: F401
from .config import resolve_mode, resolve_report_timezone  # noqa: F401
from .service import (build_data_quality_alert, format_metrics_line,  # noqa: F401
                      metrics_hidden_hint, read_email_metrics)

__all__ = ["schema", "pseudonym", "read_email_metrics", "resolve_mode",
           "resolve_report_timezone", "build_data_quality_alert",
           "format_metrics_line", "metrics_hidden_hint"]
