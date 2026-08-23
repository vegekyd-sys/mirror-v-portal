# 米奥 CDP 接口契约（blade-agent-adapter）

> 用途：DealClaw 初始化流程中，按 supplier id 拉取企业档案 + 展会订购信息的接口契约。
> ⚠️ 产品权益（privilegeList / gradeType）结构与旧版不同，后续可能变更，改动以本文件为准。

## 鉴权与请求方式

- Base URL：`https://micro.tradechina.com/blade-agent-adapter`
- 鉴权靠 **请求头**，不是 body：
  - `X-Supplier-Id`：当前企业（supplier id）
  - `X-Feishu-Open-Id`：当前操作人
- **supplier id 必须走 `X-Supplier-Id` 头**。接口 body 里传 `companyId` 会被忽略（实测传 `--company-id` 无效，返回的还是 Header 里的企业）。

## 1. 企业基本信息 getBasicInfo

`POST /agent/company/getBasicInfo.json`

请求 body 可为空 `{}`（靠 `X-Supplier-Id` 头识别企业）。

### 顶级结构

```
{ code, success, data, msg }
data = 企业档案对象（含 orderRecords 展会订购数组）
```

### data 字段（企业基础档案，21 字段）

| 字段 | 类型 | 含义 | 实测样例 |
|------|------|------|---------|
| companyName | string | 中文名 | "家居生活有限公司" |
| companyNameEn | string | 英文名 | "Homelife" |
| website | string | 官网 | "https://www.homelife.com" |
| phone | string | 电话 | "86-400-882-1116" |
| whatsapp | string | WhatsApp | "13588169211" |
| address | string | 地址 | 常空 |
| yearFounded | int | 成立年份 | 2001 |
| employees | string | 员工规模（区间） | "201,300" |
| businessModel | string | 商业模式 | "TradingCompany" |
| productTags | string | 产品标签 | 常空 |
| advantage | string | 企业优势 | 常空 |
| briefInfo | string | 简介 | 常空 |
| logo | string | logo | 常空 |
| linkedIn | string | LinkedIn | 常空 |
| faceBook | string | Facebook | 常空 |
| approveState | int | 审核状态 | 2 |
| reasonInfo | string | 备注原因 | 常空 |
| orderRecords | array | **展会订购记录** | 见下 |

> ⚠️ `orderRecords` 可能为空 `[]`。空 ≠ 接口不含该字段，是「该企业暂无/数据未就位」。判「新用户」不能只看 orderRecords 空，要结合 companyName 是否默认占位等。

## 2. orderRecords（展会订购记录数组）⭐ 核心

`data.orderRecords` 是数组，**每条 = 一条展会订购记录**。这是「用户买了哪些展会」的权威来源。

### 每条记录字段

| 字段 | 类型 | 含义 | 关键度 |
|------|------|------|--------|
| id | string | 订购记录 ID | |
| supplierId | string | 供应商 ID | |
| websiteId | string | 站点 ID | |
| **sourceId** | string | **展会 ID**（去 selectAllExhibition 对账、去 searchAIV2 传 preExhibitionIds） | ⭐ 关键 |
| year | string | 展会年份 | ⭐ |
| gradeId | string | 套餐等级 ID | |
| gradeType | int | 套餐类型编码 | ⭐ |
| gradeTypeName | string | 套餐类型名（如「出海精灵月度版」「试用会员」「O2O版」） | ⭐ 权益相关，会变 |
| validStart | string | 权益生效起（yyyy-MM-dd HH:mm:ss） | |
| validEnd | string | 权益生效止 | |
| validRange | string | 权益有效期区间 | |
| **state** | int | 状态。**3 = 当前/有效；1 = 历史/已结束**（需再确认完整枚举） | ⭐ 区分本届 vs 历届 |
| exhibitionName | string | 展会名称（英文，历史订单） | |
| supplierShowName | string | 展会名称（中文，当前订单） | ⭐ |
| websiteCountry | string | 举办国家 | ⭐ |
| **preshowStartDate** | string | 展前开始日期（yyyymmdd） | ⭐ 倒计时锚点 |
| **aftershowEndDate** | string | 展后结束日期（yyyymmdd） | ⭐ |
| promoteIndustry | string | 推广行业 | 常空 |
| privilegeList | array | 权益列表 | ⭐ 会变 |

### privilegeList（权益列表，每条订单带）⚠️ 会变

| 字段 | 含义 | 实测样例 |
|------|------|---------|
| privilegeName | 权益名 | "买家搜索解锁" / "自选邀约买家（自选+自提）" / "APP买家扫一扫" |
| privilegeCount | 总数 | 40 / 0 / 9999 |
| privilegeCost | 消耗 | 0 |
| privilegeBalance | 剩余额度 | 40 / 0 / 9999 |
| whiteCountry | 白名单国家 | "阿拉伯联合酋长国" 等 |

> ⚠️ 田耕郡提示：**产品权益结构与旧版不同，后续可能改**。此处字段/枚举以新版本实测为准，遇到变更更新本文件。

## 3. 判断「当前/即将参加」vs「历届」的规则

- `state = 3` → 当前有效订单（含即将参加的展会）
- `state = 1` → 历史/已结束订单
- 用 `sourceId`（展会 ID）按需去 `selectAllExhibition` 对账展会名称/日期/倒计时。
- 倒计时：`selectAllExhibition` 返回的 `countdownDays` 是**占位值**（实测全 100，不可用），真值由 agent push 已算好，或用 `preshowStartDate`/`aftershowEndDate` 自行计算。

## 4. 相关接口（同体系）

- `POST /agent/company/getInvitationByPage.json` — **邀约记录**（= 历届展会自己获取/邀约过的买家名录，存量，不触发新搜索）。见下方「5. 邀约记录」专节。
- `POST /agent/buyer/selectAllExhibition.json` — 全量展会目录（无 supplier 维度，`countdownDays` 为占位）
- `POST /agent/buyer/searchAIV2.json` — 多条件搜买家；`preExhibitionIds=[sourceId]` + `features` 含 21（报名/预注册）可搜某展会报名买家
- `POST /agent/buyer/getCdpDetails.json` — 按 CDP ID 查买家详情
- `POST /agent/buyer/aiSearchGetCdpContact.json` — 按 CDP ID 查联系人
- `POST /agent/buyer/onsiteBuyerSearch.json` — 现场买家搜索

## 5. 邀约记录 getInvitationByPage（历届展会买家名录）⭐

`POST /agent/company/getInvitationByPage.json`

这是「展商在（历届）展会上自己邀约/获取过的买家名录」——**存量资产**，直接按 supplier id 取回，不是重新搜索。初始化时落线索池用这个，来源标「历届展会」，**不含本届报名买家**。

请求体（BaseRequest 包装）：`{appVersion, time, data, lang}`，`data` 里 `pageNum`/`pageSize` 必填。

筛选入参（语义，来自 `company_info.py`）：

| 参数 | 含义 |
|---|---|
| exhibitionId | 按展会过滤（历届 = 历届展会 ID） |
| createUser | 发起人 |
| inviationType | 1展会报名搜索 2全域买家搜索 3自提买家 4展商自邀 5问答式搜索 6搜索交易情报 7RFQ |
| inviationState | 1联系中 2联系不上 3已拒绝 4已接受 5已联系 |
| isCheckIn | 到展：1到展 2暂未到展 3未到展 |
| isConnect | 对接：1已对接 2暂未 3未对接 |
| isMeeting | 商洽：1商洽 2暂未 3未商洽 |

返回分页对象：`{records, total, size, current, pages}`。



实际值见 2026-08-18 会话，已为「家居生活有限公司」：
- 当前 state=3 订单 3 场：阿联酋（Dubai，20260815）、沙特（20260820）、印尼（20260725），套餐均「出海精灵月度版」。
- 历史 state=1 订单 11 场（2017）：伊朗/迪拜/印度/哈萨克斯坦/巴西/约旦/南非/埃及/波兰/墨西哥/土耳其。
