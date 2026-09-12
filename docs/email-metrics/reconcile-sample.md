# 对账报告 · 合成样本

> 数据源：**合成样本**（生成器：`tests/make_synthetic_fixture.py`），不含任何真实租户信息。
> 用途：验证 Adapter → 回放 → 对账链路；真实对账待途达只读包到位后执行。

# 邮件口径对账报告（旧 vs 新）

- 生成时间：2026-09-12T03:36:07.602488+00:00
- 企业：`152600996207`
- 业务时区：Asia/Shanghai · 区间：全部

## 指标差异

| 指标 | 旧口径 | 新口径 | 差异 | 原因 |
|------|-------:|-------:|-----:|------|
| sent | 80 | 75 | -5 | 新口径 = Provider accepted；无 provider id 的 legacy_unverified 不计入 |
| delivered | 73 | 68 | -5 | 旧口径是全量 provider_status；新口径按终态投影 delivered_final |
| bounced | 1 | 2 | +1 | 旧口径是全量 provider_status；新口径按终态投影（延迟退信归位） |
| replied | 11 | 8 | -3 | 旧口径只数带商机意图的 signal；新口径把 inbound/唯一买家/线程/商机分开报 |

## 新口径明细（不强制凑平）

- 发送（Provider accepted）：75
- 送达（delivered_final）：68 · 历史送达过（delivered_ever）：68
- 退信：2 · 失败：0 · pending：5 · unknown：0
- legacy_unverified（不计入 sent）：5
- 回复：inbound 9 · 唯一买家 8 · 线程 8 · 商机确认 0

## 未计入原因

- legacy_unverified：5 —— 无 provider id，不能映射为 accepted，不计入 sent
- pending：5 —— provider accepted 但无终态事件，投递结果未知
- unknown：0 —— 没有任何投递事件的孤立消息

## 未归属 / 待确认（未匹配不丢弃、也不计入批次）

- unassigned：2 条
- ambiguous：1 条

## 数据完整度

```json
{
  "partial": false,
  "events_out_of_window": 0,
  "duplicate_events": 0,
  "messages_accepted": 75,
  "messages_missing_accepted": 0,
  "messages_pending": 5,
  "messages_unknown": 0,
  "inbound_unassigned": 2,
  "inbound_ambiguous": 1,
  "unknown_events": 0,
  "legacy_unverified": 5,
  "data_complete": true
}
```

## 脱敏证据（抽查用）

- sent（50）: msg_1bc6ae726ca8, msg_38a76f24b1cc, msg_253246f6d8a8, msg_423b5f31131e, msg_33e671dc6af3, msg_98e9789488b0, msg_ee894c9525da, msg_4b8909d5aa73, msg_09f26909deab, msg_76bb289b04a9 …
- delivered_final（50）: msg_1bc6ae726ca8, msg_38a76f24b1cc, msg_253246f6d8a8, msg_423b5f31131e, msg_33e671dc6af3, msg_98e9789488b0, msg_ee894c9525da, msg_4b8909d5aa73, msg_09f26909deab, msg_76bb289b04a9 …
- bounced（2）: msg_becd0fbbb2d6, msg_c30ccfc48a50
- pending（5）: msg_34c9d2c91637, msg_cd0aff47ebad, msg_fd4b928773b4, msg_287f68ef8a04, msg_6e90f9acd8d4
- inbound_messages（9）: ev_019ec07f9f7e, ev_4d46f950777e, ev_ae0ac3b6ba2f, ev_94a9e752d160, ev_9d10089b57ff, ev_378725884b6a, ev_642c3c5d10e1, ev_a6fecb6619b8, ev_3cc8b4bad433

### 未归属明细

- msg_365cac01b7ee · ev_ebccc7e527f1 · legacy_no_reference · 未计入
- msg_ea30c71db8af · ev_948caefd8f8b · legacy_no_reference · 未计入
- msg_21c759625ee1 · ev_2b2450294cff · legacy_weak_reference · 未计入
