# DealClaw — AI 外贸顾问

> 帮中国工厂出海：找买家、写开发信、自动跟进——越用越聪明。

## 项目定位

DealClaw 不是 SaaS，不是 CRM，不是搜索工具。是一个 AI 外贸顾问，用户在飞书里跟 V 对话，V 后台调度引擎完成企业画像、买家搜索、开发信生成、自动回复。

```
用户消息 → V 判断意图 → 调引擎 → 回结果
              ↑
        画像反馈 → 下次更准
```

**当前状态：** 计费已上线（8/12）· 14 个 DC Skill + 1 通用 Skill · Resend 累计发送 1000+ 封 · 买家搜索引擎已重构（CDP→blade-agent-adapter）· 多企业真实跑通

## 核心价值

传统外贸销售：1 人管 10 个买家 → DealClaw：1 人 + AI 管 50 个买家，且越做越准。

## 能力分层

| 能力 | 说明 |
|------|------|
| 懂产品 | 丢 URL/PDF 秒级出企业画像和买家画像 |
| 懂市场 | 海关数据、全球规模、区域机会、竞品分析 |
| 懂买家 | 搜→背调→标签匹配→去重→推荐 |
| 懂内容 | 多语言邮件/WhatsApp/展会邀约，本地化非翻译 |
| 讲策略 | 展前→展中→展后全链路，竞品切入策略 |
| 能执行 | Resend 真实发邮件，飞书文档生成 |

## 已上线 Skill

技能清单以 `skills/` 目录为准（每个 skill 一个目录，内含 SKILL.md 说明触发条件与执行流程）。新增/下线 skill 直接操作 skills/ 目录，README 不再手工罗列。

## 技术引擎

引擎代码以 `work/mio-api/` 目录为准（`dc_*.py` 业务模块 + `apollo_client` 等外部客户端）。README 不手工罗列引擎清单，避免与代码漂移。

## 外部接入

| 系统 | 用途 |
|------|------|
| Resend API | 邮件发送 + 入站接收 |
| 米奥 blade-agent-adapter | 买家搜索（header 鉴权，micro.tradechina.com） |
| Apollo | 联系人搜索 + 邮箱解锁（Enterprise） |
| 飞书 | 文档生成 + 多维表格 + 通知 |

## 文件索引

| 文件 | 作用 |
|------|------|
| `AGENTS.md` | Agent 行为 + 管道 + 展示规则 |
| `PERSONA.md` | 语气分寸、消息节奏 |
| `PRD-v2.md` | 产品需求文档 |
| `user-journey.md` | 完整用户旅程 + 交互设计原则 |
| `IMPLEMENTATION.md` | 引擎清单、版本号、数据源详情 |
| `pricing.md` | 定价策略 |
| `security-requirements.md` | 安全需求 |
| `historical-customer-learning.md` | 历史客户学习引擎设计 |
| `case-studies/` | 真实案例复盘 |
| `profiles/` | 企业画像（运行时生成） |
| `preferences/` | 用户偏好（按 open_id 隔离） |
| `leads/` | 线索标注 |
| `insights/` | 市场洞察产出 |
| `outreach/` | 邮件草稿产出 |
| `cards/` | 卡片设计参考 |
