# Promoted Facts — 短期记忆晋升的耐久事实

> 承接原 `MEMORY.md` 的「Promoted From Short-Term Memory」区。
> MEMORY.md 只留索引指针，正文在此。每条末尾标源，便于回溯原文。
> 晋升标记（防重复晋升）保留在 `MEMORY.md` 末尾。

## 产品定位

- **planning 是通用能力，不是展会专属**（田耕郡 2026-08-27 纠正）：三样产出中「买家类型」+「沟通策略」是真正共用的底层判断；「触达」按场景措辞 —— 展会场景≈邀约方向（邀买家来展位），通用外贸≈开发信触达。展会只是多一层卡片/早晚报/计划。
  - 源：`memory/2026-08-27.md:23-26`、`memory/2026-08-27.md:29-32`
  - 待确认：① planning 是否拎出来当通用能力；②「列计划」具体指什么
- **海关数据是「决策时刻的弹药」，不是日常工具**：最值钱的两个时点 = 选市场选品前 / 展前筹备定邀约名单时。邀约头部买家取决于展商规模+产能，**以小搏大没意义**。
  - 源：`memory/2026-08-27.md:3-6`
- **推荐准则（共识 5 条）**：3-5 轮拿全 产品/产能/目标；拿不到走兜底学习（给 1-2 家现有成交买家反推定位）；产能匹配=软启发（只排序+给理由，绝不砍买家）；推荐=宽进+分层（主推/跟进）+给理由；不写 skill，记行为准则（灵活优先不硬锁）。
  - 源：`memory/2026-08-27.md:7-10`

## 数据源与接口

- **邮箱兜底链**：CDP → Apollo → AroundDeal → **Hunter**（最后一道兜底；domain_search 兜底后 email_verifier 验证）。
  - 源：`memory/2026-08-28.md:18-21`
- **Hunter 验证规则（王强2 纠偏）**：find-buyers **不得自动验证邮箱**；找邮箱/展示/准备发送都不触发验证，只有用户明确说「验证邮箱」才调 email_verifier。
  - 源：`memory/2026-08-28.md:24-25`
- **dc_hunter 接入状态**：6 端点封装（domain_search / email_finder / email_verifier / people_find / companies_find / discover），鉴权 `HUNTER_API_KEY`（.env，query param）。真实 key 已配并测通。
  - 源：`memory/2026-08-28.md:3-9`、`memory/2026-08-28.md:12-15`
- **海关数据接口**：走 CDP 同一套 `blade-agent-adapter`（base=`https://micro.tradechina.com/blade-agent-adapter`，鉴权头 `X-Feishu-Open-Id`+`X-Supplier-Id`）。`comtradeGet` **无需 subscription-key**（田耕郡确认）。`by-product-category`（查同行）**待 AppCode**（阿里云网关 `X-Ca-Key`/`APPCODE`），未通，先空着。
  - 源：`memory/2026-08-27.md:11-22`
- **dealclaw-email-bindings 类型 C**：创建 resend 代理邮箱（`account-add --provider resend --mailbox-kind dealclaw_proxy --secret-ref env:RESEND_API_KEY`）。路由：`mail.dealclaw.io`+「创建」→类型 C；+「绑定」→类型 A；真实邮箱→类型 B。`owner-open-id` = 当前用户 open_id。
  - 源：`memory/2026-08-28.md:28-30`

## 架构与待决

- **展会倒计时通知未通用化**（关键架构问题）：现为单企业硬编码脚本 + config；config 被清空后空转静默不发（不是被授权拦死）。通用化方向 = 从 CDP 按 supplier_id 拉各家展会订单 → 自动算倒计时 → 发各自绑定群，建成后授权用户配一次永久生效。**待田耕郡确认后改造**。
  - 源：`memory/2026-08-25.md:27-30`、`memory/2026-08-25.md:31-33`
- **WA 桥接现状（定稿 2026-08-29）**：
  - ✅ 已完成：桥接服务 health/phones/会话窗口全通；飞书可直接给不同用户建会话群，机器人收到回复自动拉群开始聊天；已从企业号成功发消息给买家，买家回复可落回群，两个 Agent 流畅对话。
  - ⏳ 未完成：后端需请求里**显式传 from**；后端 .env 未配 `YCLOUD_FROM` 默认号（Ycloud 企业注册服务下周交付）；私有/外部群桥接机器人自助入群可能失败（客服退群需飞书侧确认），群提醒受影响，靠 `sourceOpenId` 私聊兜底。
  - 源：`memory/2026-08-29.md:4-11`

## 工程流程

- **payload 镜像同步流程**：改动同步到 Nexus payload 镜像（`packages/dealclaw-agent/payload/`）并 push master；同步时**排除 .env（凭证）与 memory 每日流水**。提交后做凭证扫描 + py_compile + `git diff --check` + 快进 push。
  - 源：`memory/2026-08-28.md:33-36`、`memory/2026-08-28.md:37-37`

## 已清理（历史）

- **dc-knowledge-query 清理闭环**（2026-08-25 前）：`industry-search-strategy.md`（182 行）50 条表格数据行逐行比对 `industry-knowledge.md`，未命中 0 条 —— 内容已完整合并，无独有内容丢失。旧 payload 已删，全树无残留。
  - 源：`memory/2026-08-25.md:4-7`
