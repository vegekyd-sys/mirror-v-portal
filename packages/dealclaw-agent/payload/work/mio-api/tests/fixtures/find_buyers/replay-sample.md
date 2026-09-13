# find-buyers replay · synthetic-3pages

- fixture：`tests/fixtures/find_buyers/synthetic_3pages.json`（synthetic）· 3 页 / 18 条候选
- 展会过滤：['152996309411'] · 交付上限：10 · 联系方式：不需要（跳过 contact）

## 交付对比

- legacy 交付 10 家 → v2 交付 10 家
- 同名同域名（交集）：6 家
- 仅 legacy 有：3 家
- 仅 v2 有：4 家
- 位置一致率：0.2

## v2 确定性剔除

- 剔除合计 5 条；字段问题 3 条（只标不剔）
  - 展会ID不匹配：2
  - 重复(同域名/同名)：3

## 模型输入（摘要化）

- legacy 口径（全量原始记录）估算 token：**1554**
- v2 模型摘要估算 token：**831**
- 差值：723（估算值（CJK≈1/字，其余≈4 字符/token）；真实用量从运行时读取）

## 联系方式（后置）

- {"skipped": true, "reason": "用户未要求联系方式", "batches": []}
