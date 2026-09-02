# MEMORY.md — 出海精灵小元 Hot Index

出海精灵小元是独立的 AI 外贸顾问 Agent，核心边界：B2B 获客、企业与客户分析、买家发现、市场洞察、外联草拟/确认后发送、询盘推进、展会线索与知识沉淀。只沉淀出海精灵小元业务记忆，不吸收 Makaron 创意生产、V 私人陪伴或其他 Agent 的无关记忆。

## Canonical memory（是什么 → 在哪 → 什么时候读）

- 产品与运行规则 → `memory/projects/dealclaw/README.md`（涉及 dealclaw 规则/流程时读）
- 技术实现 → `memory/projects/dealclaw/IMPLEMENTATION.md`（改代码/排查实现前读）
- 记忆架构 → `memory/projects/dealclaw/memory-architecture.md`（设计记忆结构/ID 映射/写入方时读）
- 决策历史 → `memory/projects/dealclaw/decision-history.md`（判断「之前怎么定的」时读）
- 企业画像/知识库 → `data/memory/<企业>/kb.json`（给某企业推买家/分析前读，唯一权威）
- 企业物料/营销素材 → `data/memory/<企业>/materials.json`（展会物料/发营销内容前读）
- 买家线索与外联 → 飞书线索池 Base + `data/memory/<企业>/`（查线索/写外联前读）
- 晋升日志 → `memory/projects/dealclaw/promotion-log.md`（追溯「什么内容被晋升过」时读）
- 安全边界 → `REDLINES.md`（每次会话必读）
- 角色语气 → `SOUL.md`（每次会话必读）

## 检索规则

- 涉及 prior 决策/状态/偏好/人/TODO → 先 `memory_search`，再 `memory_get` 取那一段。
- 本文件只存索引指针，正文下沉到上述文件，用到时再读。
- 硬上限 80 行，超了就把最旧/最不热的条目下沉。

## Promoted From Short-Term Memory (2026-08-30)

<!-- openclaw-memory-promotion:memory:memory/2026-08-25.md:27:30 -->
- 展会倒计时通知排查（01:09，已答复田耕郡）: 田耕郡问「为什么别的卡片能正常推 9 点展会通知不能，且都要 Tianyi 授权」。; **结论：不是被授权拦死，是架构差异 + config 被清空。**; 展会倒计时 = 单企业硬编码脚本 `scripts/exhibition-countdown.py` + `exhibition-countdown-config.json`（奕歌跨境群 oc_2bb3078036c462b74b62c2776ffc4320）。crontab `0 9 * * *` 仍每天触发，但 config 现在 `exhibitions: []`、`company: ""`、`supplier_id: ""`，注释「公司信息已清空，待绑定新企业」→ for 循环空转，静默不发。日志 `/tmp/yige-countdown.log` 最后 4 条全是奕歌巴西展 success，清空后再无新行，佐证空转。; 别的卡片（perception-card / survey-alert / buyer-leads-push）是通用 runner，一个脚本自动枚举所有绑定群，新增企业自动覆盖，无需逐家填 config。 [score=0.818 recalls=0 avg=0.620 source=memory/2026-08-25.md:27-30]
<!-- openclaw-memory-promotion:memory:memory/2026-08-25.md:4:7 -->
- dc-knowledge-query 清理闭环（00:58 前完成）: 单数 workspace 的 `trash/deprecated-skills-20260824/payload-dc-knowledge-query` 已删除。; 删除前安全校验：`industry-search-strategy.md`（182 行）50 条表格数据行逐行对比 `industry-knowledge.md`，未命中 0 条——内容已完整合并，无独有内容丢失。; 删后单数 workspace 全树搜 dc-knowledge 无残留。该线彻底闭环（活跃 skills 无、全 workspace 无 SKILL.md、旧 payload 已清）。; 未动：trash 目录里还躺着 `payload-buyer-match-query`（8-24 00:50，另一 skill 备份），已提示用户是否一并清掉，未获确认。 [score=0.818 recalls=0 avg=0.620 source=memory/2026-08-25.md:4-7]

## Promoted From Short-Term Memory (2026-09-01)

<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:11:14 -->
- 展会场景流程深化（20-22点，田耕郡）: 海关数据接口（7 个）验证进度：; ✅ comtradeGet（blade-adapter，鉴权头同 CDP）：能拿墨西哥 2024 进口 6907 分供应国（中国4377万/西班牙1.27亿/意大利7155万/印度0——⚠️印度 Comtrade 缺失，口径≠提单表，不能当唯一真相）; ✅ getTagCollectionAli（datathink 类目标签，免鉴权）：keyword=瓷砖→tagId=03464; ❌ by-product-category（查同行）：400，真相是**要鉴权**（阿里云网关，X-Ca-Error-Message 要求 X-Ca-Key/APPCODE），非参数错。AppCode 未给，**先空着** [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-27.md:11-14]
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:15:16 -->
- 展会场景流程深化（20-22点，田耕郡）: 未测：WITS worldbank（SDMX 免key）、WTO ePing/QRS/TFAD; 已改 AGENTS.md：profiling 加「摸规模/产能锚」+ 新增「输入采集(3-5轮+兜底)」「推荐准则(宽进+分层+给理由)」两小节。 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-27.md:15-16]
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:19:22 -->
- 海关数据接口机制 + 产品定位（22点后，田耕郡）: **接口调用机制**：海关数据接口走 CDP 同一套 `blade-agent-adapter`（base=`https://micro.tradechina.com/blade-agent-adapter`，鉴权头 `X-Feishu-Open-Id`+`X-Supplier-Id`，凭证从 work/mio-api/.env 读）。comtradeGet **无需 subscription-key**（田耕郡确认，改掉了之前"需 subscription-key"的说法）。; **by-product-category 待办**：等 AppCode（阿里云网关，`X-Ca-Key` 或 `Authorization: APPCODE <AppCode>`），拿到才调得通，**先空着**。; **接口接入价值判断（诚实结论）**：赚的是「准 + 快 + 能下钻」，不是整体翻倍。快的是「查同行」那一步（从多轮 web 搜索+人工筛 → 一次接口调用秒出），其余步骤（comtrade/搜买家/生成方案）不变。核心收益是「数据库直给 vs web 半猜」。; **产品定位（田耕郡，重要 durable）**：planning 产出（买家类型/邀约方向/沟通策略）服务两个方向： [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-27.md:19-22]
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:23:26 -->
- 海关数据接口机制 + 产品定位（22点后，田耕郡）: **选市场选品**（通用外贸场景，非展会）—— 目前走 dealclaw-market-report; **展前筹备**（展会场景）—— 每天通知卡片 + 早晚报 push + 列计划; **我发现的结构问题（待田耕郡拍板）**：planning 三样产出（买家类型/邀约方向/沟通策略）被锁在展会场景段，但它其实是**通用能力**，两个方向都该用；建议从「展会专属」升级成「通用能力」，展会只是多一层卡片/早晚报/计划的触达。; **待确认两件事**：①planning 是否拎出来当通用能力；②「列计划」具体指什么（早晚报 Todo / 展前物料清单 / 行动计划）。 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-27.md:23-26]
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:29:32 -->
- planning 产出结构修正（22:50，田耕郡纠正）: **触达是抽象概念，分场景措辞**：; 展会场景 → 邀约方向（邀买家来展位）; 通用外贸 → 开发信触达（主动写开发信）; 真正共用的底层判断 = 「买家类型」+「沟通策略」；触达方式按场景措辞，不强行统一成一个词。 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-27.md:29-32]
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:3:6 -->
- 展会场景流程深化（20-22点，田耕郡）: 讨论「海关数据买家画像报告」的接入时点：不是日常工具，是「决策时刻的弹药」——选市场前/展前筹备(planning)/定邀约名单时最值钱。; 田耕郡补充关键判断：**邀约头部买家取决于展商规模+产能，以小搏大没意义** → planning 加「规模/产能锚」。; 共识 5 条（已落 AGENTS.md 展会场景段）：; 不写 skill，记行为准则（灵活优先不硬锁） [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-27.md:3-6]
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:7:10 -->
- 展会场景流程深化（20-22点，田耕郡）: 3-5 轮拿全 产品/产能/目标，给判断勾着问; 拿不到→兜底学习：给 1-2 家现有成交买家，反推买家级别定位; 产能匹配=软启发（只排序+给理由，绝不砍买家）; 推荐=宽进+分层(主推/跟进)+给理由 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-27.md:7-10]

## Promoted From Short-Term Memory (2026-09-02)

<!-- openclaw-memory-promotion:memory:memory/2026-08-25.md:31:33 -->
- 展会倒计时通知排查（01:09，已答复田耕郡）: **根子在架构**：展会通知还是「奕歌 demo 脚本」不是通用能力；给新企业配就得改 config（加 webhook+展会数据）→ 落进「配置变更 Tianyi-only」→ 每次卡授权。; **正道/建议方向**：把展会倒计时通用化——从 CDP 按 supplier_id 拉每家展会订单 → 自动算倒计时 → 发各自绑定群；建成后即「合规内容定时推送」，授权用户配一次永久生效，无需 Tianyi 逐个批（与 REDLINES 十二「内容定时推送例外」同一解法）。; 已向田耕郡提议：是否由我动手改造成多企业通用版，先出方案（数据来源/群绑定方式/失败兜底）过目再写。待其确认。 [score=0.806 recalls=0 avg=0.620 source=memory/2026-08-25.md:31-33]
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:12:15 -->
- HUNTER_API_KEY 配置 + dc_hunter 测通（11:4x，王强2）: HUNTER_API_KEY 已就位（work/mio-api/.env，值由王强2 提供；.env 在 .gitignore 内不进 git）。; 真实 key 测通 4 端点：domain-search（stripe.com 真实邮箱 aylin@stripe.com 等）、people_find（matt@hunter.io→Matthew Tharp/Hunter CEO）、companies_find（Stripe）、discover（自然语言返回 100 家欧洲科技公司 Nokia/Ericsson/Orange）。; dc_hunter 完全可用。; 备注：王强2 之前私发 key 到 bot DM 没路由到 dealclaw agent（bot 列不出 p2p 私聊），最终贴群里解决。HunterClient 与 arounddeal_client 同机制（_load_env 读 .env + os.environ 动态读）。 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-28.md:12-15]
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:18:21 -->
- find-buyers 增加 Hunter 邮箱兜底（11:4x，王强2）: skills/dealclaw-find-buyers/SKILL.md 两处加 Hunter 兜底：; 数据源路由：加「Hunter 兜底邮箱」段（domain_search/email_finder/email_verifier 调用方式 + HUNTER_API_KEY）; 联系人和邮箱数据源：加兜底链「CDP → Apollo → AroundDeal → Hunter」，前三者都没邮箱时用 Hunter domain_search 兜底，发前 email_verifier 验证; Hunter 定位为最后一道邮箱兜底。 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-28.md:18-21]
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:24:25 -->
- Hunter 邮箱验证规则纠偏（11:50，王强2）: find-buyers 不得自动验证邮箱；找到邮箱、展示邮箱或准备发送均不触发验证。; 只有用户明确提出“验证邮箱”时，才可调用 Hunter email_verifier。 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-28.md:24-25]
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:28:30 -->
- dealclaw-email-bindings 增加类型 C（13:1x，王强2）: skills/dealclaw-email-bindings/SKILL.md 新增「类型 C：创建 resend 代理邮箱」段（account-add --provider resend --mailbox-kind dealclaw_proxy --secret-ref env:RESEND_API_KEY）; 路由判断更新：mail.dealclaw.io + 「创建/建/新增」→ 类型 C；mail.dealclaw.io + 「绑定/绑」→ 类型 A；真实邮箱 → 类型 B; 参数口径：owner-open-id = 当前用户 open_id（非机器人/mention_open_id）；enterprise 自动读 MIO_CDP_SUPPLIER_ID；创建后主动说明回信通知另走类型 A 绑群 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-28.md:28-30]
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:3:6 -->
- dc_hunter 接入 Hunter.io（09:3x，王强2）: 参考 dc_arounddeal 接入方式，新建 work/mio-api/dc_hunter/（8 文件）。; 结构：hunter_client.py（HunterClient 核心客户端，base=https://api.hunter.io/v2/）+ _hunter.py（公共层 emit/fail/client/run）+ 6 个功能脚本。; 封装 6 端点：domain_search（域名搜邮箱）/ email_finder（邮箱查找）/ email_verifier（邮箱验证）/ people_find（人富化）/ companies_find（公司富化）/ discover（搜公司）。; 鉴权：HUNTER_API_KEY（query param api_key，从 .env 读，支持 --api-key 覆盖）。 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-28.md:3-6]
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:33:36 -->
- payload 镜像同步（13:2x，王强2）: 今天的改动同步到 Nexus payload 镜像（packages/dealclaw-agent/payload/）并 push master。; commit d3c207e「新增 dc_hunter 邮箱兜底 + email-bindings 类型C」，10 文件 +419 行。; 同步内容：dc_hunter 8 个 .py（排除 __pycache__）、find-buyers SKILL.md、email-bindings SKILL.md。; 排除：.env（HUNTER_API_KEY 凭证）、memory 每日流水。 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-28.md:33-36]
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:37:37 -->
- payload 镜像同步（13:2x，王强2）: 验证：凭证扫描干净、py_compile 通过（临时目录）、diff --check 通过、快进 push（3ddba9f..d3c207e）。 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-28.md:37-37]
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:7:9 -->
- dc_hunter 接入 Hunter.io（09:3x，王强2）: 响应统一 {success, data, error}，与 dc_arounddeal 一致。; 验证：py_compile 全过；test-api-key 测通 domain-search/email-finder/email-verifier 三免费端点（返回 dummy 数据，结构正确）。; 待办：.env 里还没配 HUNTER_API_KEY，真实 key 配了才能正式用；people_find/companies_find/discover 需真实 key 测。 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-28.md:7-9]
<!-- openclaw-memory-promotion:memory:memory/2026-08-29.md:10:11 -->
- WA 功能现状定稿（00:11，田耕郡补充）: 桥接后端需请求里显式传 from；后端 .env 未配 YCLOUD_FROM 默认号（Ycloud 企业注册服务下周交付）; 私有/外部群桥接机器人自助入群可能失败（客服退群需飞书侧确认），群提醒受影响，靠 sourceOpenId 私聊兜底 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-29.md:10-11]
