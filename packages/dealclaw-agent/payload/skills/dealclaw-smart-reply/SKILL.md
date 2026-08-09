---
name: "dealclaw-smart-reply"
description: "询盘处理引擎。企业画像动态读取→资料充足才自动回复；资料不足/会议/拒绝/低置信度→飞书断点通知。来源：田耕郡@格格"
version: 2.1.0
date: "2026-07-19"
---
> 作者/发起人: 蔡天懿 | 实现: 田耕郡@格格

# DC-IQ: 询盘处理引擎

> DealClaw Skill | 入站询盘处理
> 版本: v2.1 | 数据源: Resend 入站 webhook / WABA/YCloud webhook
> 触发: 买家回复邮件/WA → 接管 → 企业画像动态读取 → 状态迁移 → 回复/断点通知

## 一、职责

DC-IQ 处理所有 outbound 营销产生的买家回复：FD 邮件回复、GS 邮件回复、WA 消息回复。

目标：自动识别意图 → 自动推进状态 → AI 动态回复 → 推到 Stage4 预约会议时交还用户。

## 二、买家状态机

```text
Stage0  未建联 — 系统已发信，买家尚未回复
Stage1  已回复 — 买家有回应但未表达采购兴趣
Stage2  已表达兴趣 — 买家有「我需要/我在找/感兴趣」等信号
Stage3  已索要资料 — 买家明确要 catalog/price/cert/spec
Stage4  已预约会议 — 买家提出或同意 call/meeting
Stage5  销售跟进 — 人工接管，DC-IQ 退出
```

## 三、入口

| 渠道 | 来源 | 格式 |
|---|---|---|
| FD 邮件回复 | Resend 入站 MX / IMAP → webhook/poller | 纯文本 |
| GS 邮件回复 | Resend 入站 MX → receiving webhook | 纯文本 |
| WA 回复 | WABA/YCloud webhook | 文本 |

## 四、意图识别与通知过滤

拿到买家回复后，先过滤再通知：

**静默丢弃（不通知用户）：**
| 类型 | 特征 | 处理 |
|------|------|------|
| 🤖 自动回复 | out of office / vacation / OOO | 静默丢弃，不通知 |
| 📧 退信 | mailbox full / address not found | 静默记录发送失败 |

**通知用户：**
| 意图 | 特征 | 动作 |
|------|------|------|
| 🙋 一般回复 | thanks / got it / will check | 通知 + Stage0→Stage1 |
| 🎯 表达兴趣 | interesting / looking for / need | 通知 + Stage1→Stage2 |
| 📂 索要资料 | catalog / price / spec / send me | 通知 + Stage2→Stage3 |
| 📅 预约会议 | call / meeting / schedule / visit | 通知 + Stage3→Stage4 |
| ❌ 退订/拒绝 | not interested / stop / unsubscribe | 通知 + 记录退订事件 + 线索标「停止触达」 |

## 五、退订追踪

退订/拒绝发生时：
1. 记录退订事件（时间/买家/渠道/原文摘要）
2. 线索池阶段列更新为「停止触达」
3. 退订数计入当日统计，早晚报中展示：「🚫 退订：X 家」

## 五、自动回复原则

**不写死模板。回复必须从企业画像动态读取外部线英文原文。**

必读字段：

- `enterprise_external`：外部线英文公司名
- `product`：外部线英文产品名/产品线
- `usp`：外部线英文价值主张/资质/规模/代理背书
- `materials`：DC-KB/资料库中的 catalog、price、spec、certificate、sample 等可发送材料

生成要求：

- 呼应买家原文中的具体产品、问题或语气。
- 简洁、自然、外贸真人口吻，不套模板腔；默认 2 行、≤120 词。
- 目标是推进状态，而不是完成一次漂亮回复。
- 不直接报价；买家索要价格时必须检查是否已有价格资料/报价规则，否则断点。
- 禁止用中文内部线字段拼外贸邮件；英文外部线不足时断点补资料。
- Stage4 预约会议、企业画像字段缺失、资料缺失、意图不确定、拒绝/投诉都必须暂停并飞书气泡通知。

| 当前状态 → 目标 | 回复方向 |
|---|---|
| Stage0 → Stage1 | 简短确认收到，问一句引导他补充需求。 |
| Stage1 → Stage2 | 顺着兴趣点展开，确认应用场景/产品范围。 |
| Stage2 → Stage3 | 先检查 DC-KB/materials 是否有买家要的 catalog/price/spec/cert/sample；有才发送，缺就断点。 |
| Stage3 → Stage4 | 不自动发会议确认；生成草稿并交给用户确认。 |

回复渠道：邮件走 Resend/SMTP，WA 走 WABA/YCloud API。

## 六、人工断点 → 飞书气泡

`dc_iq_engine.py` 默认只返回 `feishu_notice` payload；生产环境设置 `DC_IQ_SEND_FEISHU=1` 后才真实发送飞书通知，避免测试误打扰用户。

| 断点 | 气泡示例 |
|---|---|
| 企业画像字段缺失 | 📌 企业画像不足，IQ暂停自动回复：缺 enterprise_external/product/usp，请补充英文外部线。 |
| KB/资料缺失 | 📂 买家索要 catalog/price/spec/cert/sample，但资料不足，补上我继续帮你跟。 |
| 预约会议 | 📅 Osculati 想约会议：「Would next Tuesday work for you?」帮你草拟了回复 → 请确认发送/修改。 |
| 意图不确定 | 💬 Osculati 回了，我没太看懂 → 展示原文 + 让用户选择含义。 |
| 拒绝/投诉 | ❌ Osculati 说没兴趣，已暂停该买家所有自动营销。 |

## 七、状态写入

每次状态迁移写入买家状态模块。买家状态模块负责「谁在什么阶段」，漏斗看板直接读取。

线索池阶段/冷热列更新前，调 `get_lead_pool` 获取 bitable 信息：

```bash
cd work/mio-api
python3 dc_company_registry.py show "<company_id>"
# 返回 {"app_token": "...", "table_id": "tbl...", "field_map": {...}}
```

然后按 `field_map` 定位「阶段」「冷热」列的 field_id，调飞书 Bitable API `PATCH /records/{record_id}` 更新字段值。

```json
{
  "buyer": "Osculati",
  "stage": 2,
  "last_contact": "2026-07-17",
  "channel": "GS",
  "round": 1,
  "intent": "表达兴趣",
  "next_action": "wait_reply",
  "history": [
    {"stage": 0, "at": "2026-07-10", "event": "首封发出"},
    {"stage": 1, "at": "2026-07-17", "event": "买家回复"}
  ]
}
```

## 八、Stage5 退出

Stage5 销售跟进时，DC-IQ 完全退出。后续回复由用户自己处理；仅在用户明确说「你帮我回一下」时重新介入。

## 九、版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v2.1 | 2026-07-19 | 回复改为 CBIE 动态读取；英文外部线/资料不足时飞书断点通知；资料充足才自动发送。来源：田耕郡@格格 |
| v2.0 | 2026-07-19 | 脱proposal，dc_iq_engine.py实现。意图识别+状态迁移+自动回复+dc_ls_store持久化。来源：田耕郡@格格 |
| v1.0 | 2026-07-17 | 初始proposal。蔡天懿 |
