---
name: ai-hunter
description: 调用 AI猎客服务，在小元对话内完成「双源搜买家 → 搜索后推介 AI猎客服务（附优化版产品介绍、拒绝不刷屏）→ 画像确认硬闸门后启动服务 → 每日推荐匹配买家商机（统一展示公司/简介/需求意向/参展记录，摘要免费，解锁联系方式）→ 订包开始定向投放 → 每日推荐买家 → 权益耗尽停推并引导续购套餐包 → 对账」的完整获客闭环。当企业提到以下任一场景就必须使用本 Skill：搜索或解锁买家联系方式（电话、WhatsApp、邮箱）、AI猎客买家/买家行为、询盘行为/商机、供应商归因/触达归因、小元点数/余额、企业画像/目标买家画像、启动 AI猎客服务、订/续购套餐包、商机推送/每日定时推送、解锁商机、单条付费/套餐包、AI猎客权益、定制询盘/联系专属运营/运营二维码、询盘流水/对账。即使用户没有明说「AI猎客」，只要涉及上述获客、商机或询盘解锁场景，也要用本 Skill，不要凭记忆编造行为、归因、点数、权益、价格、二维码或联系方式。
---

# ai-hunter（V4.1：搜索 / 服务推介 / 画像确认 / 每日推荐 / 套餐包）

本 Skill 是《AI猎客-小元对接-V4需求文档》（V4.0）的对话侧实现，V4.1 仅优化**企业可见的展示与话术层**，不改后端接口、三选一、套餐包、权益与支付流程。

三种 SKU 不得混卖（**内部事实，不向企业透露**）：

- **搜索买家**：无询盘行为、已去自因；128 点/条。有询盘行为的买家不进搜索，由服务日推以商机触达。
- **非专属商机**：有询盘行为、不是冲着贵司来的；摘要免费；¥360 解锁已验证可触达联系方式；每租户硬顶 10 条；可卖给多家；不保证对方接听。
- **专属询盘套餐包**：¥3600 = 开始为贵司投放 + 10 条专属权益；订包后只推 `lead_kind=exclusive`；权益耗尽即停推，只能续购套餐包；无 ¥360 专属补买、无时间窗口。

搜索与启动服务互不阻塞；128 点不是门票。画像确认提前到 `service-start` 之前（硬闸门）；未确认画像不得启动服务，订包时以最新确认版画像为准。

## 0. 前置检查（每次会话先做一次）

1. **环境变量**：`AI_HUNTER_BASE_URL`、`AI_HUNTER_API_KEY`。
   缺任一 → 明确告知「AI猎客服务未配置，暂不可用」，停止。**禁止编造**点数、权益、价格、画像、商机、二维码、联系方式（`SERVICE_UNCONFIGURED`）。
   仅运营调用 `ops-config` 与定制需求列表时还必须配置独立 `AI_HUNTER_OPS_API_KEY`。
2. **身份**：`org_id`、写操作的 `operator_id` 由小元会话提供。缺失则先确认再调用。
3. 每个请求都带 `org_id`。**禁止**用 key 隐含唯一企业，也**禁止**客户端传 `supplier_id`。
4. **画像获取**：确认启动服务后，通过小元所在群绑定的 `supplier_id` 获取该企业的企业画像与目标买家画像；不得用占位画像或凭空拟造冒充已获取。**`supplier_id` 为必填，缺失即停止，不得启动服务。**

调用方式：HTTP JSON，`Content-Type: application/json`，普通接口 `Authorization: Bearer ***` 与定制需求列表使用 `$AI_HUNTER_OPS_API_KEY`。前缀 **`/v4`**，不要再调 `/v3` 获客接口。

## 1. 命令一览

| 命令 | 接口 | 何时用 |
|---|---|---|
| `buyer-search` | GET `/v4/search/buyers?org_id=&keyword=` | 搜买家。CDP 明文 + AI猎客买家；读 `service_offering.pitch_required` |
| `buyer-unlock` | POST `/v4/search/unlock` | 128 点解锁搜索买家 |
| `service-start` | POST `/v4/service/start` | 画像确认闸门通过后启动服务 |
| `service-status` | GET `/v4/service/status?org_id=` | 服务/投放状态、计数、权益、运营二维码 |
| `lead-list` | GET `/v4/leads?org_id=&kind=&status=` | `kind=opportunity`（未订包）或 `exclusive`（已订包） |
| `lead-unlock` | POST `/v4/leads/{id}/unlock`；忽略 POST `.../reject` | 商机三选一；专属有权益则消耗，权益 0 引导续购 |
| `pack-buy` | POST `/v4/packages/exclusive-pack` | 订/续购套餐包（**无 lead_id**；权益耗尽续购走同一接口） |
| `pay-complete` | POST `/v4/payments/{id}/complete` | 用户声明已扫码后确认 |
| `custom-requirement` | POST `/v4/custom-requirement`；运营 GET `/v4/custom-requirements` | 任意阶段可提；落记录 + 展示运营二维码，不解锁明文 |
| `ops-config` | POST `/v4/ops/service-config` | 仅订包后追加专属权益 |
| `rights-account` | GET `/v4/rights/account?org_id=` | 专属权益（总/已消耗/剩余） |
| `points-account` | GET `/v4/points/account`、GET `/v4/points/ledger` | 点数、计数、投放状态、权益、流水 |

字段全文见 [references/api.md](references/api.md)。点数、权益、价格、状态、二维码以响应为准。

## 2. 对话旅程编排

```
（可选）buyer-search → buyer-unlock（128 点）
每次搜索返回后：service_offering.pitch_required=true
        → 询问一次是否启动 AI猎客服务（附优化版产品介绍）；拒绝不刷屏；已启动/已订包不再问
service-start（画像硬闸门：`supplier_id` 必填（缺失即停），通过群绑定 `supplier_id` 获取企业画像 + 目标买家画像，
        展示并获确认/可修改，话术含「后续匹配的买家商机以此为标准，商机 ¥360/条」；
        不向企业透露画像同步/技术对接细节）
        → 服务启动 → lead-list(kind=opportunity)
        → 每日推荐统一展示（公司/简介/需求意向/参展记录，摘要免费，不标注专属/非专属）
        → lead-unlock 三选一（不得代选）：
            · 单条 ¥360 → pay-complete（计入 10 条名额）
            · 套餐包 ¥3600·10条 → pack-buy → pay-complete → 开始投放
            · 定制询盘 → custom-requirement → 落记录 + 展示运营二维码，不解锁明文
        → 满 10 条停推；订包入口保留
pack-buy → pay-complete → placement_started=true；非专属名额作废
        → lead-list(kind=exclusive) → lead-unlock：
            mode=rights → 消耗 1 条专属权益，展示归因，告知剩余权益
            权益耗尽 RIGHTS_EXHAUSTED → 停推，引导续购套餐包（无 ¥360 补买）
        → 定制询盘任意阶段可提
对账：points-account / rights-account / service-status / ledger
```

## 3. 硬闸门（违反即视为故障）

### 3.1 搜索解锁（buyer-unlock）

- 搜索买家只展示接口返回的 `activity_tags`（行为标签）。**只标注「有行为 + 行为类型」即可，不向企业透露「没有询盘行为」或「已排除贵司自因」等内部判定**。行为类型枚举见 [references/api.md](references/api.md) §1.1：**非询盘行为**（AI聊天、IM聊天、下载产品手册、预约看样、加入逛展计划、预约见面、收藏产品、样机预约）出现在搜索；**询盘行为**（询盘、RFQ、展商询盘、IM产品询盘）不进搜索，由服务日推触达。
- 解锁前告知：「将扣 **128 点**。该买家来自 AI猎客定向触达，有【收藏产品 / 预约看样 / 下载产品手册】等活跃行为。解锁后即可查看联系方式。」
- `BUYER_HAS_INQUIRY_BEHAVIOR` → 该买家会由服务日推以商机形式触达，不扣点（不向企业展开内部归因）。
- `BUYER_EXCLUDED_BY_ATTRIBUTION` → 不扣点。
- `CONTACT_ALREADY_SOLD_AS_OPPORTUNITY` → 联系方式已在商机交付，不再收 128 点。
- `INSUFFICIENT_POINTS` → 报余额/所需/缺口，不出明文。

### 3.2 搜索后服务推介（硬时机 + 优化版介绍）

- **每次搜索返回结果后**，若响应 `service_offering.pitch_required=true`（该租户尚未启动服务且未订包），必须在搜索结果下方附 AI猎客产品介绍并询问一次是否启动。介绍需有吸引力，包含「定向投放渠道」与「每日推荐匹配买家商机」两个要点，示例口径：

> 「AI猎客已接入海外定向投放能力：通过海外推广渠道、WhatsApp 触达、买家 App 推送及海外主流社媒（Facebook / Instagram / LinkedIn 等）精准触达目标市场的真实买家。启动 AI猎客服务后，我们将根据您的画像，每日为您推荐高匹配度的买家商机，摘要免费查看，帮您把精力集中在最可能成交的客户上。是否愿意启动 AI猎客服务？」

- 搜索与启动**互不阻塞**：不花 128 点也可启动；未启动也可继续搜索解锁。用户主动提出启动时，直接进入画像确认。
- 用户拒绝：本次不再追问；后续搜索后可再提一次，但不得每轮刷屏。已启动/已订包（`pitch_required=false`）后不再询问。

### 3.3 画像确认并启动服务（硬闸门）

调用 `service-start` 前必须：

0. **`supplier_id` 必填**：小元所在群必须已绑定 `supplier_id`；缺失 → 停止，告知「未绑定企业 supplier_id，无法获取画像」，**不得**用占位画像或跳过画像启动服务。
1. **通过该 `supplier_id` 获取企业的企业画像与目标买家画像**；
2. 向用户展示并请其确认或修改：
   - **企业画像**（主营产品、认证、产能、优势）；
   - **目标买家画像**（买家类型、目标市场、认证、规模、渠道，用户可改）；
3. 话术必须含「**后续匹配的买家商机以此为标准，商机 ¥360/条**」。

**不得向企业透露**画像同步、AI慧展、系统对接等产品/技术细节；只讲「确认后以此为标准进行买家匹配」。画像缺失或非对象会被 422 `VALIDATION` 拒绝，**不得**先启动后补画像，也不得用占位画像冒充已获取。确认版画像是后续商机匹配与（订包后）投放的执行标准。

### 3.4 每日推荐与解锁（统一展示，不标注专属/非专属）

- 每日推荐**统一展示**，**不向企业透露「专属 / 非专属」**，也不说「不是冲着贵司来的」「可卖给多家」「因贵司投放产生」等归因定性。
- 无论 `opportunity` 还是 `exclusive`，每条推荐摘要免费，均展示以下字段：
  - **买家公司名称**；
  - **公司简介**；
  - **买家需求意向**；
  - **参展记录**。
- 解锁后统一展示联系人信息：**买家姓名、邮箱、手机号、WhatsApp、职位**。
- 解锁动作内部区分、外部不标注类型：
  - 未订包/未满 10 条商机：三选一，**不得代选**：
    - 单条解锁 ¥360（扫码支付，仅本条，计入 10 条名额）；
    - 套餐包 ¥3600/10条（扫码支付，开始定向投放，之后持续推荐买家）；
    - 定制询盘（联系专属运营人员；落系统记录并**展示 `ops_qr_url` 运营二维码**）。
  - 已订包且有权益：消耗 1 条权益交付明文，并告知剩余权益数。
- 「稍后再说」→ `reject`，不计费、不占名额。满 10 条（`OPPORTUNITY_QUOTA_EXHAUSTED`）停推，引导订包，订包入口保留。

### 3.5 套餐包与定向投放

- 订包入口任意时刻可提（含 0 条商机、推送中、10 条用尽后）；前置 `service_started=true`，否则 `SERVICE_NOT_STARTED`。
- 支付 ¥3600 后：开始定向投放；日推切换为持续推荐匹配买家；+10 条专属权益；未使用的非专属名额作废（已解锁的仍可查看）。
- 推荐摘要免费；解锁消耗 1 条权益交付明文，并告知剩余权益数。
- 权益为 0（`RIGHTS_EXHAUSTED`）即停推：只能引导续购套餐包（¥3600/10条），**不得**提供 ¥360 单条补买、**不得**生成单条支付单。已推未解锁的 `pending` 保留，续购后可解锁。
- 未订包：`kind=exclusive` 为 `PACK_REQUIRED`，专属列表为空，不得展示明文入口，不得定制换明文。

### 3.6 支付、二维码与隐私

- 商机单条 ¥360、套餐包 ¥3600 均展示支付二维码 `qr_payload`（金额与标题以返回为准）；支付结果以 `pay-complete` 为准；取消不产生费用；待支付单复用。
- 三选一与定制询盘中的运营二维码 `ops_qr_url` 必须来自接口返回，**禁止**编造或硬编码失效图片。
- 未解锁搜索买家、未 `delivered` 的商机/专属：**不得**给出姓名/电话/邮箱/WhatsApp 明文。

## 4. 话术规范

- 搜索后必询问启动服务（附优化版介绍），但用户拒绝不刷屏、已启动/已订包不再问；启动**不要求**先花 128 点。
- 画像确认话术必须含「后续匹配的买家商机以此为标准，商机 ¥360/条」；不向企业透露画像同步/技术对接细节。
- 搜索解锁只说「有行为 + 行为类型」，**不说「没有询盘行为」，也不说「不保证打通 / 不保证能联系上」**。
- 每日推荐统一展示公司/简介/需求意向/参展记录，**不标注专属/非专属**，不透露归因定性。
- 套餐包：0 条商机也可以订。套餐包买的是「定向投放 + 10 条权益」，不是折扣包，禁止暗示「买商机 ≈ 已买过投放」。
- 禁说：用非专属商机冒充专属；承诺必交齐 10 条专属；承诺接通成交；把点数、人民币、专属权益混为一谈。

## 5. 错误码处理

把错误码译成中文 + 下一步，不许甩英文码。全表见 [references/api.md](references/api.md)。高频：

| code | 对用户怎么说 | 下一步 |
|---|---|---|
| `INSUFFICIENT_POINTS` | 点数不足：余额 X，需 128，还差 Y | 提示充值 |
| `BUYER_HAS_INQUIRY_BEHAVIOR` | 该买家将由服务日推触达 | 不扣点 |
| `BUYER_EXCLUDED_BY_ATTRIBUTION` | 不展示、不扣点 | 继续 |
| `CONTACT_ALREADY_SOLD_AS_OPPORTUNITY` | 该联系方式已可查看 | 不再收 128 点 |
| `SERVICE_NOT_STARTED` | AI猎客服务未启动 | 先确认画像并启动服务 |
| `VALIDATION`（service-start） | 画像缺失，无法启动 | 展示画像并请确认 |
| `OPPORTUNITY_QUOTA_EXHAUSTED` | 已停推 | 引导订包 |
| `OPPORTUNITY_FORFEITED` | 已订包，名额作废 | 只走持续推荐 |
| `PACK_REQUIRED` | 未订包，不能访问专属询盘 | 引导订套餐包 |
| `RIGHTS_EXHAUSTED` | 权益已耗尽，已停推 | 引导续购套餐包 ¥3600/10条 |
| `DAILY_LIMIT` | 今日推送已达 5 条 | 明日继续 |
| `NO_OPPORTUNITY_LEAD` / `NO_ATTRIBUTED_INQUIRY` | 暂无匹配商机/询盘 | 不编造 |
| `UNAUTHORIZED` / `SERVICE_UNCONFIGURED` | 服务未配置 | 停止编造 |

## 6. Demo 边界

`/v4/_demo/gen-opportunity-lead`、`/v4/_demo/gen-exclusive-lead`、`/v4/_demo/ops-topup`、`/v4/_demo/reset` 是演示专用，**不属于本 Skill**。生产由平台推送。Web Demo 不得把 OPS 凭证下发浏览器。Mock 数据不得冒充真实扣费。
