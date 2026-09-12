# 对账报告 · 本机旧数据（真实存储结构，非途达租户）

# 邮件口径对账报告（旧 vs 新）

- 生成时间：2026-09-12T03:36:07.603615+00:00
- 企业：`100000834234`
- 业务时区：Asia/Shanghai · 区间：全部

## 指标差异

| 指标 | 旧口径 | 新口径 | 差异 | 原因 |
|------|-------:|-------:|-----:|------|
| sent | 1 | 1 | +0 | — |
| delivered | 0 | 0 | +0 | — |
| bounced | 0 | 0 | +0 | — |
| replied | 0 | 0 | +0 | — |

## 新口径明细（不强制凑平）

- 发送（Provider accepted）：1
- 送达（delivered_final）：0 · 历史送达过（delivered_ever）：0
- 退信：0 · 失败：0 · pending：1 · unknown：0
- legacy_unverified（不计入 sent）：0
- 回复：inbound 0 · 唯一买家 0 · 线程 0 · 商机确认 0

## 未计入原因

- legacy_unverified：0 —— 无 provider id，不能映射为 accepted，不计入 sent
- pending：1 —— provider accepted 但无终态事件，投递结果未知
- unknown：0 —— 没有任何投递事件的孤立消息

## 未归属 / 待确认（未匹配不丢弃、也不计入批次）

- unassigned：0 条
- ambiguous：0 条

## 数据完整度

```json
{
  "partial": false,
  "events_out_of_window": 0,
  "duplicate_events": 0,
  "messages_accepted": 1,
  "messages_missing_accepted": 0,
  "messages_pending": 1,
  "messages_unknown": 0,
  "inbound_unassigned": 0,
  "inbound_ambiguous": 0,
  "unknown_events": 0,
  "legacy_unverified": 0,
  "data_complete": true
}
```

## 脱敏证据（抽查用）

- sent（1）: msg_06a07e97c35c
- delivered_final（0）: —
- bounced（0）: —
- pending（1）: msg_06a07e97c35c
- inbound_messages（0）: —
