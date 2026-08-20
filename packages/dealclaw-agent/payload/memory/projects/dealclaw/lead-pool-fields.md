# 线索池字段定义与填充规则（唯一真相源）

> 目标：统一线索池字段口径，明确每个字段「含义 / 类型 / 数据来源 / 填充规则 / 落库条件」。
> 状态：2026-08-19 定稿。替代分散在 dc_company_registry.py（v4）与 buyer-leads-push base-schema.md（v15）里的两份口径。

## 零、总规则（简化版，一切以此为准）

> **适用范围：find-buyers 等通用线索落库。** leads push（buyer-leads-push）例外——它保持自己原规则，见下方「leads push 例外」。

1. **基础信息全落**：所有线索（用户没排除、没说「不是我的买家」的）都落线索库，基础信息直接写——公司名、官网、公司简介、国家、买家类型、匹配产品、推荐理由。
2. **只有联系人需要解锁**：用户确认要营销（解锁）→ 写联系人；没确认 → 不写联系人。其他字段一律直接落，不用解锁。
3. **排除不落**：用户明确说「排除 / 不是我的买家」的线索，不落库。

> ⚠️ **leads push 例外（别混）**：leads push 走 `sync_buyerleads_to_pool`（`_buyerleads_fields`），规则不同——**联系人不落库**（只写「是否解锁=未解锁」状态，解锁后联系方式单独推群卡片），推荐理由用 recentTrend/公司简介原文。它的规则在 buyer-leads-push skill 的 base-schema.md / message-template.md / contact_unlock_guard.py 里，不要动。

## 一、唯一 registry

线索池 Base 的映射统一存**一份** `work/mio-api/data/company_registry.json`，键 = `company_id`，值为 `{app_token, table_id, field_map, company_name, bitable_url}`。

所有建池/读写（find-buyers 的 `sync_leads_to_pool`、buyer-leads-push 的 `ensure_pool`、daily push）都调 `dc_company_registry.ensure_company_lead_pool` 读这一份。不再有多份 registry、不再有重复 Base。

## 二、字段清单与填充规则

分四类。字段名、类型、来源、填充规则如下。

### 1. 接口事实字段（只存清洗后的接口值，不推理）

| 字段 | 类型 | 来源 | 填充规则 |
|---|---|---|---|
| 线索ID | text（主键） | `id` | 非空才允许写；空则拒绝该条 |
| 买家CDPID | text | `companyCdpId` | 有则填，无则空 |
| 买家公司名称 | text | `buyerCompany` | 清洗高亮标签 |
| 买家公司简介 | long text | `companyProfile` | 清洗高亮标签 |
| 买家国家 | text | `buyerCountry` | 原样 |
| 产品类别T1/T2 | text | `t1`/`t2` | 原样 |
| 需求意向 | long text | `recentTrend` | 原样 |
| 关注产品 | long text | `productList`（格式化） | 买家自己关注的采购产品，**不是**匹配产品 |
| 买家类型 | text | `buyerType` | **只用接口 buyerType，禁止从其他字段推导** |
| 买家特征 | text | `buyerTag` | 原样 |
| 报名参展展会 | text | `exhibitionName` | 原样 |
| 需求时间 | text | `lastConsolidatedTime` | 原样 |

### 2. AI 评分字段（由确定性 matcher 产出，禁止生成式 narrative 替代）

| 字段 | 类型 | 来源 | 填充规则 |
|---|---|---|---|
| AI匹配分 | number | `AI匹配分` | 0-100 |
| AI原始分 | number | `AI原始分` | 0-100 |
| 反馈扣分 | number | `反馈扣分` | |
| AI匹配等级 | select 高/中/低 | `AI匹配等级` | |
| 核心匹配通过 | checkbox | `核心匹配通过` | 仅产品名+产品类别+目标国家三门硬闸，买家类型是加分项不改此框 |
| **AI匹配理由** | long text | 由 `评分明细` 生成 | ⭐ 见下方「推荐理由」专项 |
| 评分明细 | long text/JSON | `评分明细`（九维） | 必须保留九维逐维得分+证据，不允许 narrative 覆盖 |
| 线索明确MOQ | text | `线索明确MOQ` | |
| 评分权重版本 | text | `v10-32-24-18-10-6-4-2-2-2` | 固定 |
| 企业画像版本 | text | state profile hash | |
| 企业画像群ID | text | `chat_id` | 必须等于记录 `飞书群ID` 和绑定 chat_id |
| 画像企业名称 | text | binding.company_name | 与「买家公司名称」是两回事，禁止混 |
| 运行上下文ID | text | tenant_run_guard | |
| AI处理时间 | datetime | run_at | |

### 3. 用户反馈字段（用户手工维护，系统永不覆盖）

| 字段 | 类型 | 填充规则 |
|---|---|---|
| 是否匹配 | select 待确认/✅匹配/❌不匹配 | 默认待确认 |
| 不匹配原因 | multi-select | |
| 反馈说明 | long text | |
| 反馈人 | person | |
| 反馈时间 | datetime | |
| 跟进状态 | select | |
| 跟进备注 | long text | |
| 是否解锁 | select 未解锁/已解锁 | 创建默认「未解锁」 |

> 系统 upsert 时**只写接口事实字段 + AI 字段**，用户反馈字段（是否匹配/不匹配原因/跟进状态/是否解锁…）一律保留不覆盖。

### 4. 系统字段

| 字段 | 类型 | 填充规则 |
|---|---|---|
| 唯一去重键 | text | `chat_id + ":" + 线索ID`，按此 upsert，禁止同键重复建 |
| 飞书群ID | text | 当前 chat_id |
| 首次入池时间 / 最近更新时间 | datetime | |
| 首次推送时间 / 最近推送时间 / 推送次数 / 最近推送批次ID / 推送消息ID | | 推送时写 |

## 三、⭐ 三个关键字段的专项规则

### 1. 匹配产品（=「关注产品」≠ 匹配的产品，别混）

- **关注产品**：买家自己声明采购的产品（接口 `productList`），是事实字段，直接落库。
- **匹配产品**：画像产品线与买家关注产品的**交集**（命中了哪些），从 `评分明细` 的「产品名称 / 产品类别」维度提取。
- 填充：**有评分时填命中的产品**（画像依据 vs 线索依据都命中的那几个）；无评分（find-buyers 直搜）时，用买家采购标签作为近似，标「待匹配」。

### 2. 推荐理由（=「AI匹配理由」）

- **禁止**直接填买家公司简介、buyerIntroduce 原文（公司简介是基础信息，落「公司简介」字段，不混进推荐理由）。
- 从 `评分明细` 九维逐条生成，格式：「{维度}匹配（画像：{画像依据}；线索：{线索依据}），+{得分}分」，按得分降序拼接。
- 例：`产品名称匹配（画像：bag fabric；线索：箱包面料），+32分；产品类别匹配…+24分；买家国家匹配…+18分`。
- 无评分（find-buyers）时，推荐理由留空或填「接口来源：<来源>」，不编造匹配解释。

### 3. 联系人（⭐ 唯一需要解锁的字段）

- **只有联系人解锁才写**，其他字段全直接落。
- 用户确认要营销（解锁）→ 写联系人；没确认 → 不写（初始为空）。
- **确认动作无按钮**：靠意图识别（用户表达要联系这个买家/要营销/「解锁线索 X」），不确定时反问确认。

## 四、硬约束

- 接口事实与 AI 评分分离，接口值不改写。
- `企业画像群ID` 必须 = `飞书群ID` = 绑定 chat_id，跨群拒绝写。
- 拒绝 `线索ID` 空的记录。
- 用户反馈字段保留，upsert 不覆盖。
- 跨群记录拒绝读/写/反馈。
