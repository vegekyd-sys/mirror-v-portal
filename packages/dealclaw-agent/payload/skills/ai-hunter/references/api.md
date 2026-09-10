> 说明：本文件是后端接口契约（内部事实源），其中「无询盘行为」「专属/非专属」「归因」等为**内部判定字段**。
> 企业可见的展示与话术规则见 SKILL.md 第 3/4 节：不向企业透露「无询盘行为」、不标注「专属/非专属」、统一展示公司/简介/需求意向/参展记录。

# ai-hunter Skill · V4.0 接口契约参考

> 与《AI猎客-小元对接-V4需求文档》（V4.0）§10–§11 同步；字段变更须两边一起改。
> Base：`$AI_HUNTER_BASE_URL`；普通接口鉴权：`Authorization: Bearer $AI_HUNTER_API_KEY`；运营配置与定制需求列表使用独立 `$AI_HUNTER_OPS_API_KEY`；`Content-Type: application/json`。
> 前缀 **`/v4`**。`/v1`～`/v3` 仍是旧契约，本 Skill 不要调用。

## 目录

1. buyer-search — 双源搜索（含 service_offering）
2. buyer-unlock — 点数解锁（不保证打通）
3. service-start — 画像确认并启动服务
4. service-status — 服务 / 投放状态
5. lead-list — 非专属商机 / 专属询盘
6. lead-unlock / reject — 三选一与权益消耗
7. pack-buy — 订/续购套餐包
8. pay-complete
9. custom-requirement / ops-config
10. 账户与流水
11. 错误码全表
12. 规则速查
13. Demo 专用（不进 Skill）

---

## 1. buyer-search `GET /v4/search/buyers?org_id={org_id}&keyword={kw}`

返回 CDP（`source:"cdp"`，明文）与 AI猎客（`source:"ai_hunter"`，`sku:"search_behavior"`）。`hunter` 中每条：无询盘行为；已排除当前供应商归因行为；`contact:null`；`unlock_points:128`；`reachability:"unguaranteed"`；`activity_tags` 仅非询盘类型。

响应另含 `service_offering`：`{"service_started":bool,"placement_started":bool,"pitch_required":bool}`——`pitch_required=true` 表示本次搜索后必须向用户发起一次启动询问（附简介）。

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
 "service_offering":{"service_started":false,"placement_started":false,"pitch_required":true}}
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

**询盘行为（有询盘，不进搜索，由服务日推以商机触达）：**
- 询盘
- RFQ
- 展商询盘
- IM产品询盘

> 规则：搜索买家只展示「非询盘行为」类型；命中「询盘行为」类型的买家不属于搜索解锁范围，由服务日推触达。

## 2. buyer-unlock `POST /v4/search/unlock`

请求：`{"org_id","operator_id","buyer_id"}`

- 200 扣点：`{"mode":"points","sku":"search_behavior","reachability":"unguaranteed","buyer":{...含明文},"points_spent":128,"points_balance":N}`
- 200 已解锁：`{"already_unlocked":true,...}` 不重复扣
- 422 `BUYER_HAS_INQUIRY_BEHAVIOR` / `BUYER_EXCLUDED_BY_ATTRIBUTION` / `CONTACT_ALREADY_SOLD_AS_OPPORTUNITY` / `INSUFFICIENT_POINTS`

## 3. service-start `POST /v4/service/start`

请求（画像为必填对象，任一缺失或非对象 → 422 `VALIDATION`，不得先启动后补画像）：

```json
{"org_id":"...","operator_id":"...",
 "enterprise_profile":{"name":"...","products":"...","certs":["..."],"capacity":"...","advantages":"..."},
 "buyer_profile":{"buyerTypes":["..."],"markets":["..."],"certs":["..."],"scale":"...","channels":["..."]}}
```

201：画像字段 + `"profile_synced":true` + `"service_started":true` + `"service_started_at"` + `"daily_push_limit":5` + `"opportunity_price_cny":360` + `"opportunity_unlocks_limit":10`。

幂等：已启动再调视为画像更新（重新同步画像、记 `profile_sync`），不重复记 `service_start`。

## 4. service-status `GET /v4/service/status?org_id=`

```json
{"org_id":"...","supplier_id":"...","service_started":true,"service_started_at":"...",
 "opportunity_unlocks_used":2,"opportunity_unlocks_limit":10,"opportunity_push_active":true,
 "opportunity_price_cny":360,
 "placement_started":false,"placement_started_at":null,"exclusive_push_active":false,
 "daily_push_limit":5,"pushes_today":1,
 "push_scope":"opportunity_inquiry_behavior",
 "rights_total":0,"rights_consumed":0,"rights_remaining":0,
 "pack_price_cny":3600,"pack_qty":10,
 "ops_qr_url":"https://.../ops-qr.png"}
```

订包后：`placement_started=true`，`opportunity_push_active=false`，`push_scope="current_supplier_attributed_only"`，返回权益视图；权益耗尽后 `exclusive_push_active=false`。

## 5. lead-list `GET /v4/leads?org_id=&kind=opportunity|exclusive&status=`

未订包只能 `opportunity`；已订包只能 `exclusive`。查询 `kind=exclusive` 且未订包 → 422 `PACK_REQUIRED`（不得当成「今天没有询盘」）。

每条含 `lead_id`、`lead_kind`、`org_id`、`status`（`pending/delivered/rejected`）、`teaser`、`pushed_at`。

- `opportunity`：无 `attribution.supplier_id` 指向当前企业；可含询盘行为摘要；`delivered` 后 `reachability:"verified_reachable"` 并附明文。
- `exclusive`：必须 `attribution.supplier_id = 当前 supplier_id`；含归因（`trigger` / `channel` / `campaign_id` / `buyer_action`）。

## 6. lead-unlock `POST /v4/leads/{lead_id}/unlock`

请求：`{"org_id","operator_id","pay_method"?: "single"}`

| 条件 | 状态码 | mode | 内容 |
|---|---|---|---|
| opportunity 且 used<10 且未订包，未指定 pay_method | 200 | `choice` | 三选一 `options`：`single`(¥360) / `pack`(¥3600·10条) / `custom`（联系运营，含 `ops_qr_url`）；附 `opportunity_unlocks_remaining` |
| opportunity 且 `pay_method="single"` | 201 | `payg` | 商机单条支付单（¥360，含 `qr_payload`） |
| opportunity 且 used≥10 | 422 | — | `OPPORTUNITY_QUOTA_EXHAUSTED`，引导订包 |
| opportunity 且已订包 | 422 | — | `OPPORTUNITY_FORFEITED` |
| exclusive 且未订包 | 422 | — | `PACK_REQUIRED` |
| exclusive 且有权益 | 200 | `rights` | 消耗 1 条交付明文，返回 `rights`（含 `rights_remaining`） |
| exclusive 且权益=0 | 422 | — | `RIGHTS_EXHAUSTED`，引导续购套餐包；**不得**生成单条支付单 |

未订包时，商机解锁的支付单**只有单条 ¥360**；套餐包是另一 SKU，走 `POST /v4/packages/exclusive-pack`，不得把商机打包进专属权益。

忽略：`POST /v4/leads/{id}/reject`；商机忽略不占 10 条名额。

## 7. pack-buy `POST /v4/packages/exclusive-pack`

请求：`{"org_id","operator_id"}`（**无 lead_id**）。前置 `service_started=true`，否则 422 `SERVICE_NOT_STARTED`。

201：`{"mode":"pay","payment":{...¥3600,"type":"exclusive_pack"...},"pack":{"qty":10,"price_cny":3600,"starts_placement":true,"push_until_rights_exhausted":true}}`

待支付单复用；权益耗尽后续购走同一接口，不限制续购次数。

## 8. pay-complete `POST /v4/payments/{payment_id}/complete`

请求：`{"org_id","operator_id"}`

| type | 完成动作 |
|---|---|
| `opportunity_single` | 交付该商机；`opportunity_unlocks_used+=1`；满 10 则 `opportunity_push_active=false` |
| `exclusive_pack` | 首次：`placement_started=true`、作废非专属剩余名额、停商机推送；每次均 `rights_total+=10`、`exclusive_push_active=true`，日推 scope 切为仅专属 |
| 重复回调 | `already_paid`，不重复入账 |

## 9. custom-requirement / ops-config

`POST /v4/custom-requirement`：`{"org_id","operator_id","lead_id"?,"note"?}`；`lead_id` 可选，若带则必须是当前租户可见且 `pending` 的线索/询盘。任意阶段可调用（订包前/后均允许）；**不解锁任何明文**。

201：`{"custom_requirement":{"custom_id","supplier_id","lead_id","note","status":"待运营处理","created_at"},"ops_contact":"AI猎客专属运营","ops_qr_url":"https://.../ops-qr.png","message":"已记录你的定制需求，请扫码联系专属运营人员"}`

`GET /v4/custom-requirements?org_id=` 必须使用 OPS Key。

`POST /v4/ops/service-config`：`{"org_id","operator_id":"ops","rights_total"?,"reset_consumed"?}` → 201 权益视图。仅订包后追加**专属**权益；不得追加非专属名额、不得改 `supplier_id`、不得在未订包时凭空开启专属推送。追加后 `rights_remaining>0`，若因权益耗尽停推则恢复 `exclusive_push_active=true`。

## 10. 账户与流水

`GET /v4/rights/account?org_id=`：`rights_total / rights_consumed / rights_remaining / exclusive_push_active`；未订包全 0。

`GET /v4/points/account?org_id=`：点数 + 画像 + 服务/投放状态 + 非专属计数 + 专属权益 汇总视图。

`GET /v4/points/ledger?org_id=`：`type` = `search_unlock` / `profile_sync` / `service_start` / `opportunity_single` / `exclusive_pack` / `exclusive_rights_consume` / `ops_config` / `custom_requirement`。

对账：`9800 = points_balance + search_unlock_points_spent`；`opportunity_unlocks_used ≤ 10`（已作废名额不再累加）；`rights_total = rights_consumed + rights_remaining`。

## 11. 错误码全表

| code | HTTP | 对企业的说法 + 下一步 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 检查 API_KEY |
| `VALIDATION` | 422 | 按提示修正；画像缺失不得启动 |
| `BUYER_NOT_FOUND` | 404 | 回到搜索 |
| `INSUFFICIENT_POINTS` | 422 | 报余额/所需/缺口，提示充值 |
| `BUYER_HAS_INQUIRY_BEHAVIOR` | 422 | 由服务日推以商机触达，不扣点 |
| `BUYER_EXCLUDED_BY_ATTRIBUTION` | 422 | 不展示、不扣点 |
| `CONTACT_ALREADY_SOLD_AS_OPPORTUNITY` | 422 | 不重复收 128 点 |
| `SERVICE_NOT_STARTED` | 422 | 先确认画像并启动服务 |
| `OPPORTUNITY_QUOTA_EXHAUSTED` | 422 | 引导订包；AI猎客已停推商机 |
| `OPPORTUNITY_FORFEITED` | 422 | 只走专属询盘 |
| `PACK_REQUIRED` | 422 | 先订专属询盘套餐包 |
| `RIGHTS_EXHAUSTED` | 422 | 引导续购套餐包 ¥3600/10条 |
| `DAILY_LIMIT` | 422 | 明日继续 |
| `NO_OPPORTUNITY_LEAD` | 422 | 如实说明，不编 |
| `NO_ATTRIBUTED_INQUIRY` | 422 | 投放已开始、有了就推，不编 |
| `INQUIRY_ATTRIBUTION_MISMATCH` | 403 | 停止展示/解锁并检查归因配置 |
| `SUPPLIER_ID_IMMUTABLE` | 422 | 移除 supplier_id，由服务端解析 |
| `LEAD_NOT_FOUND` | 404 | 刷新列表 |
| `LEAD_ALREADY_RESOLVED` | 409 | 查列表 |
| `PAYMENT_NOT_FOUND` | 404 | 重新发起 |
| `UNKNOWN_PAYMENT_TYPE` | 422 | 停止操作，报平台排查 |
| `FORBIDDEN` | 403 | 检查 org_id |
| `SERVICE_UNCONFIGURED` | Skill 本地 | 明确告知不可用，禁止编造 |

## 12. 规则速查

- 有询盘行为 → 不进搜索，由服务日推以商机触达；无询盘行为 → 搜索 128 点，不保证打通。
- 同一联系方式已作商机交付，搜索不得再收 128 点；商机可卖给多家企业。
- 未订包：专属列表为空、无专属解锁/支付；订包买的是「投放启动 + 10 条专属权益」，不是商机折扣包，也不绑定某条 `lead_id`。
- 商机解锁必须三选一同时呈现、不代选；未订包时支付单只有单条 ¥360，套餐包走独立接口。
- 权益耗尽即停推，只能续购套餐包或运营追加；无 ¥360 专属补买、无时间窗口、不承诺必交齐 10 条、不假归因补单。

## 13. Demo 专用（不进 Skill）

`POST /v4/_demo/gen-opportunity-lead`（服务已启动、未订包、未满 10 条时模拟推送一条非专属商机）；`POST /v4/_demo/gen-exclusive-lead`（已订包且权益未耗尽时模拟推送一条专属）；`POST /v4/_demo/ops-topup`（前端演示运营追加权益）；`POST /v4/_demo/reset`。所有 `_demo` 端点生产环境必须禁用，**不属于本 Skill**。
