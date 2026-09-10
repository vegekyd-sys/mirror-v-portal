# dealclaw-ai-hunter Skill · V4.2 接口契约参考

> 与《AI猎客-小元对接-V4需求文档》同步；V4.2 简化：移除套餐包/权益/三选一，统一「询盘买家数据 + 360 点/条解锁」。
> Base：`$AI_HUNTER_BASE_URL`；普通接口鉴权：`Authorization: Bearer ***`；定制需求列表用 `$AI_HUNTER_OPS_API_KEY`；`Content-Type: application/json`。
> 前缀 **`/v4`**。`/v1`～`/v3` 仍是旧契约，本 Skill 不要调用。

## 目录

1. buyer-search — 双源搜索（含 service_offering）
2. buyer-unlock — 128 点解锁搜索买家
3. service-start — 画像确认并启动服务
4. service-status — 服务 / 投放状态
5. lead-list — 统一询盘买家数据
6. lead-unlock — 360 点解锁询盘
7. custom-requirement
8. 账户与流水
9. 错误码全表
10. 规则速查

---

## 1. buyer-search `GET /v4/search/buyers?org_id={org_id}&keyword={kw}`

返回 CDP（`source:"cdp"`，明文）与 AI猎客（`source:"ai_hunter"`，`sku:"search_behavior"`）。`hunter` 中每条：无询盘行为；已排除当前供应商归因行为；`contact:null`；`unlock_points:128`；`reachability:"unguaranteed"`；`activity_tags` 仅非询盘类型。

响应另含 `service_offering`：`{"service_started":bool,"pitch_required":bool}`——`pitch_required=true` 表示本次搜索后必须向用户发起一次启动询问（附简介）。

```json
{"keyword":"照明 / lighting","supplier_id":"org_demo_001",
 "cdp":[{"buyer_id":"cdp_uk_01","source":"cdp","locked":false,"contact":{}}],
 "hunter":[{"buyer_id":"hunt_de_01","source":"ai_hunter","sku":"search_behavior",
            "activity_tags":[{"type":"interest","label":"..."}],
            "behavior_scope":"exclude_current_supplier_attributed",
            "locked":true,"unlock_points":128,"reachability":"unguaranteed","contact":null}],
 "search_meta":{"attribution_filter":"exclude_current_supplier_attributed",
   "hunter_excluded_inquiry_behavior_count":2,"hunter_excluded_count":1,
   "behavior_excluded_count":2,"hunter_returned_count":2},
 "service_offering":{"service_started":false,"pitch_required":true}}
```

### 1.1 买家行为类型枚举

`activity_tags` 的行为类型（label）枚举：

**非询盘行为（互动类，出现在搜索买家的 `activity_tags`）：**
- AI聊天
- IM聊天
- 下载产品手册
- 预约看样
- 加入逛展计划
- 预约见面
- 收藏产品
- 样机预约

**询盘行为（有询盘，不进搜索，由服务推送以询盘触达）：**
- 询盘
- RFQ
- 展商询盘
- IM产品询盘

> 规则：搜索买家只展示「非询盘行为」类型；命中「询盘行为」类型的买家不属于搜索解锁范围，由服务推送触达。

## 2. buyer-unlock `POST /v4/search/unlock`

请求：`{"org_id","operator_id","buyer_id"}`

- 200 扣点：`{"mode":"points","sku":"search_behavior","reachability":"unguaranteed","buyer":{...含明文},"points_spent":128,"points_balance":N}`
- 200 已解锁：`{"already_unlocked":true,...}` 不重复扣
- 422 `BUYER_HAS_INQUIRY_BEHAVIOR` / `BUYER_EXCLUDED_BY_ATTRIBUTION` / `CONTACT_ALREADY_SOLD` / `INSUFFICIENT_POINTS`

## 3. service-start `POST /v4/service/start`

请求（画像为必填对象，任一缺失或非对象 → 422 `VALIDATION`，不得先启动后补画像）：

```json
{"org_id":"...","operator_id":"...",
 "enterprise_profile":{"name":"...","products":"...","certs":["..."],"capacity":"...","advantages":"..."},
 "buyer_profile":{"buyerTypes":["..."],"markets":["..."],"certs":["..."],"scale":"...","channels":["..."]}}
```

201：画像字段 + `"profile_synced":true` + `"service_started":true` + `"service_started_at"` + `"daily_push_limit":5` + `"lead_unlock_points":360`。

幂等：已启动再调视为画像更新，不重复记 `service_start`。

## 4. service-status `GET /v4/service/status?org_id=`

```json
{"org_id":"...","supplier_id":"...","service_started":true,"service_started_at":"...",
 "daily_push_limit":5,"pushes_today":1,
 "lead_unlock_points":360,
 "ops_qr_url":"https://.../ops-qr.png"}
```

## 5. lead-list `GET /v4/leads?org_id=&status=`

统一返回询盘买家数据（**不再区分 `kind=opportunity|exclusive`**）。每条含 `lead_id`、`org_id`、`status`（`pending/delivered/rejected`）、`pushed_at`。

每条含**询盘行为**（专属与非专属统一，对外不区分），并返回完整买家字段（用于九维打分、卡片渲染与线索池落库）：

- **接口事实字段**：`线索ID`、`买家公司名称`、`买家公司简介`、`买家国家`、`产品类别T1/T2`、`需求意向`、`关注产品`、`买家类型`、`买家特征`、`报名参展展会`、`需求时间`。
- **AI 评分字段**：`AI匹配分`、`AI原始分`、`反馈扣分`、`AI匹配等级`、`核心匹配通过`、`AI匹配理由`、`评分明细`（九维逐项）、`线索明确MOQ`、`评分权重版本`。

摘要免费；`delivered` 后附联系人明文（姓名/邮箱/手机/WhatsApp/职位）。

## 6. lead-unlock `POST /v4/leads/{lead_id}/unlock`

请求：`{"org_id","operator_id"}`

- 200 扣点：`{"mode":"points","points_spent":360,"points_balance":N,"buyer":{...含明文（姓名/邮箱/手机/WhatsApp/职位）}}`
- 200 已解锁：`{"already_unlocked":true,...}` 不重复扣
- 422 `INSUFFICIENT_POINTS` / `LEAD_NOT_FOUND` / `LEAD_ALREADY_RESOLVED` / `SERVICE_NOT_STARTED` / `DAILY_LIMIT` / `NO_LEAD` / `NO_ATTRIBUTED_INQUIRY`

解锁**直接扣 360 点**，无支付单、无套餐包、无三选一、无权益。定制询盘走独立接口，不解锁明文。

扣点成功后，对话侧需将解锁状态写回「企业线索池」Base：`是否解锁=已解锁` + `解锁人/解锁时间/解锁方式（=AI猎客扣点）/解锁推送消息ID`；联系人明文**不落库**。

## 7. custom-requirement

`POST /v4/custom-requirement`：`{"org_id","operator_id","lead_id"?,"note"?}`；`lead_id` 可选，若带则必须是当前租户可见且 `pending` 的线索/询盘。任意阶段可调用；**不解锁任何明文**。

201：`{"custom_requirement":{...},"ops_contact":"AI猎客专属运营","ops_qr_url":"https://.../ops-qr.png","message":"已记录你的定制需求，请扫码联系专属运营人员"}`

`GET /v4/custom-requirements?org_id=` 必须使用 OPS Key。

## 8. 账户与流水

`GET /v4/points/account?org_id=`：点数余额 + 画像 + 服务状态 + 汇总视图。

`GET /v4/points/ledger?org_id=`：`type` = `search_unlock`（128 点）/ `lead_unlock`（360 点）/ `profile_sync` / `service_start` / `custom_requirement`。

对账：`初始点数 = points_balance + search_unlock_points_spent + lead_unlock_points_spent`。

## 9. 错误码全表

| code | HTTP | 对企业的说法 + 下一步 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 检查 API_KEY |
| `VALIDATION` | 422 | 按提示修正；画像缺失不得启动 |
| `BUYER_NOT_FOUND` | 404 | 回到搜索 |
| `INSUFFICIENT_POINTS` | 422 | 报余额/所需/缺口，提示充值 |
| `BUYER_HAS_INQUIRY_BEHAVIOR` | 422 | 由服务推送以询盘触达，不扣点 |
| `BUYER_EXCLUDED_BY_ATTRIBUTION` | 422 | 不展示、不扣点 |
| `CONTACT_ALREADY_SOLD` | 422 | 不重复扣点 |
| `SERVICE_NOT_STARTED` | 422 | 先确认画像并启动服务 |
| `LEAD_NOT_FOUND` | 404 | 刷新列表 |
| `LEAD_ALREADY_RESOLVED` | 409 | 查列表 |
| `DAILY_LIMIT` | 422 | 明日继续 |
| `NO_LEAD` | 422 | 如实说明，不编 |
| `NO_ATTRIBUTED_INQUIRY` | 422 | 投放已开始、有了就推，不编 |
| `FORBIDDEN` | 403 | 检查 org_id |
| `SERVICE_UNCONFIGURED` | Skill 本地 | 明确告知不可用，禁止编造 |

## 10. 规则速查

- 有询盘行为 → 不进搜索，由服务推送以询盘触达；无询盘行为 → 搜索 128 点解锁。
- 询盘买家数据统一推送（专属/非专属不对外区分），解锁统一扣 360 点。
- 匹配采用九维打分（见 `matching.md`），核心闸门 = 产品名 + 产品类目 + 目标国家。
- 同一联系方式已交付，不得重复扣点。
- 定制询盘任意阶段可提，不解锁明文。
