# 企业飞书标准格式（所有企业通用）

> 定稿 2026-08-23。每个企业（company_id）在飞书 Base 里固定一套格式：
> 线索池表 + 邮件跟进表 + 邮件营销漏斗表 + 七信号仪表盘（漏斗图）。

## 一、标准结构

| # | 资源 | 表名/名称 | 数据来源 | 同步入口 |
|---|------|-----------|----------|----------|
| 1 | 线索池表 | `线索池` | 米奥 CDP / find-buyers / leads push | find-buyers / dc_memory_data sync-leads |
| 2 | 邮件跟进表 | `邮件跟进` | `email_followup.json`（线索池 + 邮件 + 信号聚合） | `dc_feishu_standard.py sync-email-followup` |
| 3 | 邮件营销漏斗表 | `邮件营销漏斗` | `build_funnel()`（email-facts + 七信号实时聚合） | `dc_funnel_feishu.py sync` |
| 4 | 七信号仪表盘 | `七信号仪表盘` | 漏斗图读「邮件营销漏斗」表 | `dc_funnel_feishu.py sync` |

统一入口：`python3 dc_feishu_standard.py sync-all <company_id> <base_token>`

## 二、各表字段

### 邮件跟进表（12 列）
公司名 / 官网(url) / 国家 / 买家类型 / 联系人名 / 联系人信息 / 跟进状态 /
已发邮件数(number) / 买家回复数(number) / 已跟进轮次(number) / 最近联系时间 / 邮件全部内容

### 邮件营销漏斗表（2 列）
漏斗层级(text) / 数量(number)
5 行：发送 → 送达 → 回复 → 有效询盘 → 会议意向

### 七信号仪表盘（漏斗图）
type=funnel，series=数量 SUM，group_by=漏斗层级（value desc）

## 三、数据口径（邮件营销漏斗 = build_funnel）

| 层级 | 来源 |
|------|------|
| 发送 | EmailStore outbound 数 |
| 送达 | outbound provider_status=delivered |
| 回复 | 有 quote/sample/meeting/missing 信号的回复 message_id 去重 |
| 有效询盘 | quote_request / sample_request 信号 |
| 会议意向 | meeting_interest 信号 |

不手填。信号由七信号引擎（dc_email_signals）从 Resend poller / webhook 产生。

## 四、数据链路（七信号引擎）

```
发送(直发脚本) → dc_send_record.record_resend_send 写 EmailStore outbound
  → poll_status_once 拉 Resend last_event → delivered/bounced 信号
  → poll_received_once 拉收件回复 → analyze_reply + process_reply → quote/sample/meeting/missing 信号
  → dc_memory_data sync-emails/signals → emails.json / signals.json
  → build_funnel 聚合 → 邮件营销漏斗表 → 漏斗图
```

## 五、registry 记录（company_registry.json 每企业）

- `email_followup_table_id` / `email_followup_url`
- `funnel_table_id` / `funnel_table_url`
- `seven_signal_dashboard_id`
