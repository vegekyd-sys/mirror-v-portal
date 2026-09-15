---
name: "dealclaw-email-founder-direct"
description: "Founder Direct 一对一邮件：SMTP发送、个性化内容、日量控制。来源：田耕郡@格格"
author: ""
version: 2.0.0
date: "2026-07-29"
---

# DC-Email Founder Direct: 一对一触达

> DealClaw Skill | 高价值买家、老板对老板、展后跟进

## 何时用

- 用户看中某个高价值买家，想一对一发邮件
- GS 自动序列中买家回复了，转人工深度跟进
- 展会见面后跟进

## 执行流程

```
1. 生成邮件内容 → V 根据买家背景+企业优势自主撰写
2. 发送时区窗口路由 → 统一入口带 `--country` 自动处理：窗口内当场发，窗口外自动落待发队列由 cron 到点自动发（当地下一个工作日 8:00），并向用户说明预计发送时间。
3. 发送前确认 → 展示收件人、内容、检查项给用户
4. 用户确认 → 发送（`dc_email_send.py send --channel FD ...`）
5. 回写线索池 → 立刻更新该买家记录：阶段→已触达、最近触达→发送时间、触达渠道→邮件。不可跳过

## 收件人选择

- 只发 1+2：采购经理（Purchasing/Procurement/Sourcing/Buyer）+ 总经理（CEO/Owner/Director）。
- 不发 3（产品经理/R&D/Engineering）、4（其他）。
```

## 邮件内容原则

**口吻（用户明确要求 2026-09-15）**：以**专业外贸顾问**的身份写，不是客服、不是模板机器人——
先给判断与价值（数字 / 事实 / 行业观察），再谈动作；不吹、不承诺交期或价格，不用空话套话。

**CTA 铁律**：**每一封跟进邮件必须有且只有一个明确 CTA**（具体、轻量、容易回答的下一步）。
禁止「有需要随时联系」「期待您的回复」这类空 CTA。按买家意图选：

| 买家意图 | 该给的 CTA |
|---|---|
| 询价 | 请他确认**数量 + 目的港**，你按这两个参数给具体报价 |
| 索样 | 请他给**寄样地址 + 收件人 + 电话**，并说明样品费/运费归属 |
| 约会议 | 给**两个具体时段**（按时区换算好）让他二选一 |
| 无意向 / 模糊 | 给一个低压力钩子（新品 / 展会 / 目录），或明确收尾不再打扰 |

**不编造 / 不空承诺（用户长期要求，最高优先）**：不编造任何事实数据（价格 / MOQ / 交期 / 认证 / 产能）；
需要这些参数时**主动向用户索取**，不替用户对外承诺；**不承诺答复时间**（不写「24 小时内回」），只承诺动作本身。

**用户偏好优先复用（2026-09-15）**：用户给过模板、或对草稿提过改进意见，就**按他的偏好写（写进记忆，不搞脚本/配置文件）**；
写之前先想一遍该租户的结构/口吻/CTA/署名/忌讳偏好，同一类意见被重复提 = 说明没记住。

V 自主生成，核心约束：

- 纯文本，80-100 词
- 一句话破冰（引用具体证据：产品/展会/新闻）
- 一个观察 + 一个问题
- 只签名字，不挂公司全称
- 无追踪像素、无退订链接、无附件
- 首封不直接约会（不问 "let's schedule a call"）

## 日量控制

- 硬上限：30 封/天
- 超限 → 提示明天继续

## 回复处理

买家回复 → V 收到通知后：
1. 更新线索池 → 阶段→已回复
2. 通知用户 → 展示摘要
3. 触发 smart-reply → 出建议回复内容
4. 用户确认后发送 → 更新阶段→已回复（如走邮件再次触达）
5. 进入跟进周期（等待下次触达时机）

## 发送脚本（统一入口）

```bash
python3 work/mio-api/dc_email_send.py send \
  --channel FD \
  --from user@company.com \
  --to buyer@example.com \
  --subject 'Quick question — [主题]' \
  --text '...' \
  --country BR \
  --enterprise <企业key> \
  --receipt-target ou_<当前私聊open_id>
```

- `--channel FD`：代理邮箱（@mail.dealclaw.io）走 Resend 无需密码；企业邮箱走 SMTP 直发。
- `--country` 带则自动判窗口：窗口内当场发，窗口外落待发队列由 cron 到点自动发；不带则跳过窗口检查直接发。
- **`--enterprise` 必带**：填当前企业 key。不传则 `dc_email_send.py` 里 `if enterprise:` 跳过落库，发送日志不落 send_log、早报的「发送/送达/回复/退信」查不到、阶段也不回填。
- `--receipt-target` 必带，填当前会话 id：私聊用 `ou_` open_id，群聊用 `oc_` chat_id。发送结果以机器人身份推一条回执回这个会话。
- ⚠️ SMTP 直发（企业邮箱需现场输入密码）无法定时自动发：密码只在发送时刻输入，窗口外落队列后到点无法补密码。这类用 Resend 代理邮箱，或到点后改人工发。

## 脚本路径锚点（避免执行失败 + 禁止裸发）

- **发送一律走统一入口 `dc_email_send.py send`，禁止直接 `node scripts/founder-direct/send-direct.mjs` 裸发**。`send-direct.mjs` 是底层发信脚本，只调 SMTP/Resend 发信、不落 send_log、不回填阶段——直接裸发会导致早报查不到发送记录。
- 统一入口 `dc_email_send.py` 内部会去调 `send-direct.mjs`（FD），并负责落 send_log + 批次回执 + 窗口路由，agent 不要绕过它。
- 从工作区根执行，用相对路径调用 `python3 work/mio-api/dc_email_send.py ...`。
- 不要拼 `/data/workspace` 等绝对路径前缀，也不要 `ls`/list 脚本目录来「确认脚本存在」——租户环境挂载根可能与预期不符；且 `accounts/`、`email-registry.json`、`sent-log.jsonl` 等运行时文件不在镜像里（`.gitignore` 排除），列目录必失败。
- 脚本内部用 `__dirname` 自动定位同目录的 `accounts/`、`email-registry.json`，无需手动指定。

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v2.1 | 2026-09-08 | 发送改走统一入口 dc_email_send.py：窗口路由 + 批次回执（机器人推回发起会话）+ 定时发送闭环。来源：田耕郡@格格 |
| v2.0 | 2026-07-29 | 吸收 dc-copy 内容生成，删 DC-OS/DC-Copy 死链。邮箱绑定引导移出 skill（V 被问到自然会引导）。来源：田耕郡@格格 |
| v1.0 | 2026-07-14 | 初始 |

## 计费记录（Shadow Mode — 测试期仅记录不扣费）

每次完成本技能操作并交付结果后，必须异步记录一条计费事件：

```bash
# 计费埋点（正式链路）：tenantId = 当前租户（按 open_id/群 chat_id 从 scripts/billing-config.json 解析；解析不到自动 shadow 记录）
bash scripts/dealclaw-billing-record.sh <tenantId> dealclaw-email-founder-direct 1 &
```

- 后台异步，不阻塞回复；失败静默
