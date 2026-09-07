# 展后复盘数据契约

## 输入范围

所有记录必须能追溯到当前企业和 `exhibition_id`。历史数据可作比较或补充关系背景，但不能进入本届漏斗分子、分母或买家数量。

```json
{
  "report_mode": "close_out|conversion_review|refresh",
  "generated_at": "",
  "company": {"company_id": "", "name": "", "timezone": ""},
  "exhibition": {
    "exhibition_id": "",
    "name": "",
    "country": "",
    "timezone": "",
    "start_at": "",
    "end_at": ""
  },
  "data_sources": [],
  "funnel_events": [],
  "customers": [],
  "opportunities": [],
  "interactions": [],
  "feature_events": [],
  "benchmarks": []
}
```

## 数据源状态

```json
{
  "source": "invitation|attendance|booth_visit|scan|meeting|translation|email|whatsapp|lead_pool|feature_usage",
  "status": "ready|partial|unavailable|error",
  "synced_through": "",
  "record_count": 0,
  "coverage_note": "",
  "error_type": ""
}
```

`error`、`unavailable` 和未完成同步不得当成 0。只有来源明确完成且返回 `completed_empty` 时才可判断为 0 条。

## 漏斗口径

每一层不得按记录条数累计，应按唯一 `customer_id` 统计，并保存客户集合或可重算查询条件。

主漏斗轻量化 5 层，其余作为明细信号挂在对应层下，不单列：

| 阶段 | 最低证据 | 明细信号（不单列） |
| --- | --- | --- |
| 目标买家 | 本届候选范围 + 买家画像匹配记录 | — |
| 已邀约 | 本届 invitation sent 事件 | 确认参与（明确确认，不含仅送达/打开） |
| 到展/会面 | 当前 exhibition_id 的 check-in / booth visit / isMeeting=1 / 已确认 meeting | 本届到展 vs 到达展位/实际会面 分开计数 |
| 有效商洽 | 有双向业务沟通及原始 interaction 证据 | 需求明确（产品需求 + 数量/用途/预算/交期/规格/项目背景至少一项） |
| 商务推进 | 报价、样品、合同、付款、交期确认或二次会议 | 已执行跟进（outbound 邮件/WA）、买家回复（inbound/replied，不含 delivered/opened） |

只有分母集合包含分子集合时才计算相邻转化率。否则展示独立指标并解释不同来源。

## 结构化输出

```json
{
  "report_id": "",
  "report_mode": "close_out|conversion_review|refresh",
  "exhibition_id": "",
  "scope": {
    "current_exhibition_only": true,
    "unique_customer_count": 0,
    "deduped_record_count": 0
  },
  "executive_summary": {
    "conclusion": "",
    "wins": [],
    "main_bottleneck": "",
    "priority_action": ""
  },
  "funnel": [
    {
      "stage": "",
      "unique_customers": 0,
      "denominator_stage": "",
      "conversion_rate": null,
      "coverage": "ready|partial|unavailable",
      "evidence_refs": []
    }
  ],
  "diagnoses": [
    {
      "category": "reach|invitation|attendance|booth_engagement|qualification|followup|product_fit|data_quality",
      "observation": "",
      "interpretation": "",
      "confidence": "high|medium|low",
      "cannot_conclude": [],
      "evidence_refs": [],
      "recommended_action": "",
      "success_metric": ""
    }
  ],
  "buyer_actions": {
    "not_connected_priority": [],
    "connected_followups": [],
    "nurture": [],
    "suppressed": []
  },
  "demand_insights": [],
  "product_usage_review": [],
  "action_plan": [],
  "data_completeness": {
    "status": "complete|partial|insufficient",
    "missing_sources": [],
    "impact_on_conclusions": []
  },
  "benchmark_context": null,
  "report_version": "1.0.0"
}
```

## 买家行动项

```json
{
  "customer_id": "",
  "opportunity_id": "",
  "company": "",
  "fit_grade": "A|B|C|待确认",
  "stage": "",
  "followup_priority": "优先跟进|普通跟进|长期培育",
  "priority_reason": "",
  "evidence_refs": [],
  "next_step": {"action": "", "owner": "", "due": ""},
  "customer_record_url": "",
  "dossier_url": ""
}
```

优先买家必须提供至少两条客户特有的 `evidence_refs`。多家公司使用完全相同的 `priority_reason` 视为模板化判断，不能作为正式报告交付。

## 需求洞察

“提及次数”和“涉及客户数”必须分开，不得用多轮沟通中的重复提及夸大市场需求。

```json
{
  "topic": "",
  "unique_customers": 0,
  "mention_count": 0,
  "sample_customer_count": 0,
  "share_of_sample": null,
  "evidence_refs": [],
  "interpretation": "",
  "commercial_implication": "",
  "confidence": "high|medium|low"
}
```

## 行动计划

```json
{
  "horizon": "72h|7d|30d|next_exhibition",
  "action": "",
  "target_customer_ids": [],
  "owner": "",
  "due": "",
  "reason": "",
  "evidence_refs": [],
  "success_metric": "",
  "status": "pending|in_progress|done|blocked"
}
```

## 报告版本

`refresh` 更新同一报告时保留生成时间、数据水位、前一版本关键结论、变化项和规则版本。不要静默改写历史数字；文档可显示最新结果，结构化数据必须支持追溯。
