# 初始化数据落位映射（supplier id 信息 → 存储位置）

> 目标：把 supplier id（`getBasicInfo`）能拉到的信息，分别落到「企业知识库」和「线索池」的正确位置。
> 状态：设计稿 + 预留结构（2026-08-19）。字段来源见 `cdp-api-contract.md`。
> 初始化时点：企业初始化（Nexus onboarding）时一次性执行，supplier id 来自数字人实例配置（安装时注入），非用户输入。

## 数据源回顾（supplier id 能拿到什么）

见 `memory/projects/dealclaw/cdp-api-contract.md`。要点：
- 企业档案（`data` 顶层 21 字段）：companyId / companyName(中/英) / website / email / phone / whatsapp / address / yearFounded / employees / businessModel / productTags / advantage / briefInfo / logo / linkedIn / faceBook / approveState / reasonInfo / orderRecords
- 展会订购 `orderRecords[]`：id / supplierId / websiteId / **sourceId(展会ID)** / year / gradeType / gradeTypeName / validStart·End·Range / **state(3=当前,1=历史)** / exhibitionName / supplierShowName / websiteCountry / preshowStartDate / aftershowEndDate / promoteIndustry / privilegeList[]

## 一、企业知识库（company-profile / 企业知识库文档）

落位到 `company-profile-document.md` 定义的结构。映射：

| supplier id 字段 | 企业知识库位置 | 说明 |
|---|---|---|
| companyName | 一、企业快照 → 公司全称 | |
| yearFounded | 一、企业快照 → 成立年份 | |
| businessModel | 一、企业快照 → 业务模式 | TradingCompany 等；可直接落「贸易/工厂/工贸」对应 |
| employees | 一、企业快照 → 工厂规模 | 需澄清是员工规模≈规模，标注为员工数 |
| website | 一、企业快照 → 店铺/官网链接 | |
| address | 一、企业快照 → 办公地址 | 常空，空则「待确认」 |
| email/phone/whatsapp | ⚠️ **不落文档** | 联系信息不进群可见文档（company-profile 规则） |
| orderRecords[].supplierShowName | 四、市场分布 → 参展计划 | state=3 为当前参展计划；state=1 为历史参展 |
| orderRecords[].websiteCountry | 四、市场分布 → 参展计划（国家） | |
| orderRecords[].year | 四、市场分布 → 参展计划（年份） | |
| orderRecords[].preshowStartDate/aftershowEndDate | 四、市场分布 → 参展计划（日期） | 开展日需经 selectAllExhibition 对账 `inshowStartDate` |
| productTags / briefInfo / advantage | 一、企业快照 → 主营产品 / 产品类别 | 常空；空则「待确认」，靠聊天补 |

**企业知识库本身不做联系人存储**：email/phone/whatsapp 是敏感联系信息，不进群可见文档，不落知识库。

## 二、线索池（Bitable，`dc_company_registry.py` 定义）

线索池字段：公司名 / 官网 / 国家 / 买家类型 / 匹配产品 / 推荐理由 / 联系人 / 来源 / 冷热 / 阶段。

**线索池存的是「买家线索」（下游客户），不是企业自身档案。** supplier id 的企业档案信息不进线索池；进池的是「历届展会邀约记录里的买家」。

### 数据源：邀约记录接口（历届展会自己获取过的买家名录）

**正确数据源 = `POST /agent/company/getInvitationByPage.json`**（`company_info.py --action invitation`），不是 `searchAIV2`。

- 这就是「展商在历届展会上自己邀约/获取过的买家名录」——存量资产，直接按 supplier id 取回，不触发新的买家搜索。
- **不包含本届报名买家**；本届报名买家根本不是这个数据源，不混入。

入参语义（来自 `company_info.py`）：
- `exhibitionId`：按展会过滤（历届展会用历届展会 ID）
- `inviationType` 邀约类型：1展会报名搜索 2全域买家搜索 3自提买家 **4展商自邀** 5问答式搜索 6搜索交易情报 7RFQ
- `inviationState` 状态：1联系中 2联系不上 3已拒绝 4已接受 5已联系
- `isCheckIn` 到展：1到展 2暂未到展 3未到展
- `isConnect` 对接：1已对接 2暂未 3未对接
- `isMeeting` 商洽：1商洽 2暂未 3未商洽

### 来源新增标签：`历届展会`

在 `dc_company_registry.py` 的 `LEAD_POOL_FIELDS_JSON` → 「来源」options 里**新增**（已落地 4 个副本）：

```
{"name": "历届展会"}
```

现有来源值（7 个）：引擎搜索、星擎线索、猎采线索、米奥数据库、Apollo数据库、展会线索、用户导入。
新增后（8 个）：+ `历届展会`。

### 邀约记录买家 → 线索池映射（预留结构，待真实样例回填）

> **本表为预留结构**：字段名/含义按 `company_info.py` 入参反推 + 线索池字段反推，真实返回字段拿到后回填覆盖，不改映射逻辑。

#### 预留 records 单条结构（占位，待样例校准）

```json
{
  "buyerCompanyName": "",   // 买家公司名 → 公司名
  "buyerWebsite": "",       // 买家官网 → 官网
  "buyerCdpId": "",         // 买家 CDP ID → 公司CDPID（幂等键）
  "buyerCountry": "",       // 买家国家 → 国家
  "buyerType": "",          // 买家类型 → 买家类型（有则填，无则不推断）
  "product": "",            // 邀约关联产品 → 匹配产品
  "exhibitionId": "",       // 展会 ID（溯源，不进池）
  "exhibitionName": "",     // 展会名（溯源，可并入推荐理由）
  "invitationType": 0,      // 邀约类型 1-7（溯源）
  "invitationState": 0,     // 状态 1-5 → 推荐理由（如「已接受邀约」）
  "isCheckIn": 0,           // 到展 1-3（溯源）
  "isConnect": 0,           // 对接 1-3（溯源）
  "isMeeting": 0,           // 商洽 1-3（溯源）
  "createUser": ""          // 发起人（溯源）
}
```

#### 线索池落位映射

| 线索池字段 | 来源（预留结构字段） |
|---|---|
| 公司名 | buyerCompanyName |
| 官网 | buyerWebsite |
| 公司CDPID | buyerCdpId |
| 国家 | buyerCountry |
| 买家类型 | buyerType（有则填，无则留空不推断） |
| 匹配产品 | product |
| 推荐理由 | invitationState 语义（如「已接受邀约」）+ exhibitionName |
| 联系人 | **空**（解锁时才单独推，不进池） |
| 来源 | **`历届展会`** |
| 冷热 | ❄️冷（默认） |
| 阶段 | 待触达（默认） |

## 三、⚠️ 关键边界

### 初始化时点（Nexus onboarding）

- **执行时机**：企业初始化时一次性跑完，不在运行时反复调接口。
- **supplier id 来源**：数字人实例配置（Nexus tenant 安装时注入），非用户输入、非运行时 open_id 反查。
- **执行顺序**：
  1. `getBasicInfo` → 企业档案 → 企业知识库 + 建 Campaign（当前展会倒计时）
  2. `getInvitationByPage` → 历届邀约买家 → 线索池（来源=历届展会）
  3. 两条路都有 orderRecords 判断：有 → 展会场景引导；空 → 通用场景引导
- **Nexus 接入**：初始化编排挂在 Nexus onboarding（Provisioning 之后），supplier id 由 tenant 配置注入。

- **企业档案 ≠ 线索**。supplier id 的企业信息进「企业知识库」；买家线索只来自「邀约记录」（历届展会自己获取过的买家），来源标 `历届展会`。
- **不触发新搜索**。历届展会买家靠 `getInvitationByPage` 直接取存量，不调 `searchAIV2`。
- **不含本届报名买家**。本届报名买家不在这个数据源里，不混入。
- 联系人字段永远不进线索池（解锁时才单独推群），这是已有铁律，本次不破。
- `countdownDays` 是占位值，倒计时用 campaign 的 `days_remaining`（开展日锚点）。
- 权益（privilegeList/gradeTypeName）不进知识库也不进线索池，仅内部用于判断可解锁额度。

---

## 四、2026-09-15 新增：展中推荐独立池与两个新标签

现场推荐（`dc_onsite_recommend.py`）从「只推不落池」改为**落池**，口径：

### 新增选项（`work/mio-api/dc_company_registry.py` → `LEAD_POOL_FIELDS_JSON`）

- 「来源」options 新增 **`展中推荐`**（与展后推荐的 `展会线索` 区分）
- 「阶段」options 新增 **`现场对接中`**

> select 字段的选项之外的值写不进飞书：新建池自带这两个选项；
> 老池/按标题找回的池会在写记录前用 `+field-get` → `+field-update` 自动补选项（缺才写）。

### 展中推荐池布局（每届展会一个独立池）

| 项 | 值 |
|---|---|
| 注册表键 | `<company_id>::exhibition::<exhibition_id>`（绕过 `canonical_company_id` 折叠，否则会与企业主池撞键） |
| Base 标题 | `<展会名>｜展中推荐线索池`（`ensure_exhibition_lead_pool`） |
| 表结构 | 与企业线索池同一套 v4 字段（`_create_bitable` 同一入口） |
| 与企业主池关系 | **分开**：企业主池仍只收 引擎搜索/邀约/展会线索 等；展中推荐只进本展会池 |
| 幂等 | 池：注册表命中复用 → 按标题回查恢复；记录：公司CDPID > 官网域名 去重，同批重复只落第一条 |
| 排除不落 | `denied` / `blacklisted` / `manual_excluded` / `identity_mismatch` / `cancelled` / 邀约状态 `inviationState=3`（已拒绝）→ 不推也不落 |

> 注：本文第二节「现有来源值（7 个）」是 2026-09-08 的快照，早与代码不一致；以代码 `LEAD_POOL_FIELDS_JSON` 为准。
> `skills/dealclaw-find-buyers/scripts/dc_company_registry.py` 是另一份旧副本（仍带已退役的冷热字段），本次未动，待后续收敛。
