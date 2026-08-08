# xiaoao-zcrm-v1-api V1.01 CLI 测试用例

> 生成时间：2026-07-20 16:42 GMT+8  
> 适用 Skill：`xiaoao-zcrm-v1-api`  
> 适用版本：Agent V1.01 CLI 封装版  
> 发起人：吴合伟  
> 服务根地址：`https://zohodata.meorient.com/agent`  
> CLI：`skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1`  
> 安全说明：本文档不包含任何密钥明文。

---

## 1. 测试目标

验证新版 `xiaoao-zcrm-v1-api` CLI 是否满足：

1. Agent 可通过 CLI 一条命令调用每个明确动作路径。
2. HTTP 鉴权只发送 `Authorization: Bearer <token>`，不发送 `CRM_API_KEY` header。
3. 11 个 CLI 动作可按 V1.01 文档返回正确结构。
4. 停用接口不会被误当作正常能力调用。
5. 分页、统计、批量查询、异常参数均有覆盖。
6. 输出不泄露密钥明文。

> 注：V1.01 文档“接口汇总”列 10 个接口，但正文明确提供 `/accounts/overview`。当前 CLI 按明确动作路径包装，共 11 个可调用动作。

---

## 2. 测试前置条件

### 2.1 环境变量

```bash
export CRM_API_KEY='Bearer <真实token>'
export ZCRM_V1_BASE_URL='https://zohodata.meorient.com/agent'
```

### 2.2 测试样本

| 变量 | 默认样本 | 用途 |
|---|---|---|
| `KNOWN_ACCOUNT_NAME` | `广州辉洋进出口有限公司` | 客户/商机/合同/拜访查询 |
| `KNOWN_ACCOUNT_ID` | `185165004027994962` | by-id/by-account 查询 |
| `KNOWN_PROVINCE` | `浙江省` | 分页和大结果集测试 |
| `UNKNOWN_ACCOUNT_NAME` | `不存在客户-自动化测试-000000` | 无数据测试 |
| `UNKNOWN_ACCOUNT_ID` | `000000000000000000` | 无数据测试 |
| `SAMPLE_USER_NAME` | 从 `users all` 返回中动态取第一个非空姓名 | 用户精确搜索 |

### 2.3 通用成功断言

| 断言项 | 期望 |
|---|---|
| 命令退出码 | `0` |
| 输出格式 | `--json` 模式为合法 JSON object |
| `error` | `""` |
| 密钥明文 | stdout/stderr 均不得出现 |
| 认证头 | 只走 `Authorization: Bearer` |

### 2.4 通用失败断言

| 场景 | 期望 |
|---|---|
| 缺少 `CRM_API_KEY` | 退出非 0 或 JSON `error=MISSING_ENV: CRM_API_KEY` |
| 错误 token | HTTP 401 或 `error=Unauthorized` |
| 参数缺失 | 退出非 0 或 JSON `error` 非空 |
| 停用接口 | CLI 明确提示已停用并退出非 0 |

---

## 3. 鉴权与 CLI 基础测试

### AUTH-001 CLI help 可用

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 --help
```

预期：

- 退出码 `0`
- 输出包含 `accounts`、`deals`、`orders`、`events`、`users`

### AUTH-002 正确鉴权可调用客户查询

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --name "广州辉洋进出口有限公司" --json
```

预期：

- 退出码 `0`
- `error == ""`
- `count >= 1`
- `data` 为数组

### AUTH-003 缺少 CRM_API_KEY

```bash
env -u CRM_API_KEY skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --name "广州辉洋进出口有限公司" --json
```

预期：

- 退出码非 `0`，或 JSON 中 `error == "MISSING_ENV: CRM_API_KEY"`
- 不出现密钥明文

### AUTH-004 错误 token

```bash
CRM_API_KEY='Bearer invalid-token-for-test' skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --name "广州辉洋进出口有限公司" --json
```

预期：

- 退出码非 `0`
- HTTP 401 或 `error` 包含 `Unauthorized`
- 不出现密钥明文

### AUTH-005 确认不发送 CRM_API_KEY header

检查 CLI 源码/抓包/日志，确认请求 headers 中只有：

```http
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
```

预期：

- 不存在 `CRM_API_KEY: ...` 作为 HTTP header

---

## 4. Accounts 客户接口

## 4.1 `accounts search` → `/agent/v1/accounts/search`

### ACC-SEARCH-001 按客户名称查询

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --name "广州辉洋进出口有限公司" --json
```

预期：

- `error == ""`
- `count >= 1`
- `data[0]` 包含 `id`、`name`、`industry_custom`、`customer_level`、`owner_name`

### ACC-SEARCH-002 按省份分页查询

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --province "浙江省" --page 1 --json
```

预期：

- `error == ""`
- `page == 1`
- `data` 为数组
- 若 `more_records == true`，继续执行 ACC-SEARCH-003

### ACC-SEARCH-003 第二页分页

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --province "浙江省" --page 2 --json
```

预期：

- `error == ""`
- `page == 2`
- 第 2 页数据不应与第 1 页完全一致

### ACC-SEARCH-004 三条件内组合查询

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --province "浙江省" --city "杭州市" --customer-level "自拓客户" --page 1 --json
```

预期：

- 应返回 HTTP 200 / `error == ""`，或若服务端不支持该组合，应返回明确参数/语法错误但不得 500
- 记录服务端实际行为

### ACC-SEARCH-005 超过 3 个非空条件

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --province "浙江省" --city "杭州市" --customer-level "自拓客户" --source "展会" --page 1 --json
```

预期：

- 退出非 0 或 JSON `error` 非空
- 不应返回 500

### ACC-SEARCH-006 无匹配客户

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --name "不存在客户-自动化测试-000000" --json
```

预期：

- `error == ""`
- `count == 0` 或 `data == []`

## 4.2 `accounts by-names` → `/agent/v1/accounts/byNames`

### ACC-BYNAMES-001 单公司命中

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts by-names --name "广州辉洋进出口有限公司" --json
```

预期：

- `error == ""`
- `count >= 1`
- `data` 为数组

### ACC-BYNAMES-002 多公司混合命中/未命中

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts by-names --names "广州辉洋进出口有限公司,不存在客户-自动化测试-000000" --json
```

预期：

- `error == ""`
- 命中项返回；未命中项不导致整体失败

### ACC-BYNAMES-003 names 为空

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts by-names --json
```

预期：

- 参数缺失或服务端错误，退出非 0 / `error` 非空
- 不应 500

## 4.3 `accounts by-ids` → `/agent/v1/accounts/byIds`

### ACC-BYIDS-001 单 ID 命中

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts by-ids --id 185165004027994962 --json
```

预期：

- `error == ""`
- `count >= 1`
- `data[0]` 包含稳定客户字段

### ACC-BYIDS-002 多 ID 混合命中/未命中

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts by-ids --ids "185165004027994962,000000000000000000" --json
```

预期：

- `error == ""`
- 命中项返回；未命中项不导致整体失败

### ACC-BYIDS-003 ids 为空

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts by-ids --json
```

预期：

- 参数缺失或服务端错误，退出非 0 / `error` 非空
- 不应 500

## 4.4 `accounts overview` → `/agent/v1/accounts/overview`

### ACC-OVERVIEW-001 客户 360 命中

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts overview --name "广州辉洋进出口有限公司" --json
```

预期：

- `error == ""`
- `count >= 1`
- `data[0]` 包含 `account`、`deals`、`orders`、`events`
- 子模块失败时只在对应模块 `error` 中体现，不应导致整体 500

### ACC-OVERVIEW-002 客户不存在

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts overview --name "不存在客户-自动化测试-000000" --json
```

预期：

- `error == ""`
- `count == 0` 或 `data == []`

### ACC-OVERVIEW-003 name 缺失

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts overview --json
```

预期：

- argparse 参数校验失败，退出非 `0`

---

## 5. Deals 商机接口

## 5.1 `deals search` → `/agent/v1/deals/search`

### DEALS-SEARCH-001 按客户名称查询商机

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 deals search --account-name "广州辉洋进出口有限公司" --json
```

预期：

- `error == ""`
- `data` 为数组
- 记录如存在，应包含 `id`、`account_name`、`project_name`、`stage`、`zone_name`、`sales`

### DEALS-SEARCH-002 按阶段查询

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 deals search --stage "赢单" --page 1 --json
```

预期：

- `error == ""`
- `page == 1`
- `data` 为数组

### DEALS-SEARCH-003 三条件组合

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 deals search --stage "赢单" --account-name "广州辉洋进出口有限公司" --page 1 --json
```

预期：

- `error == ""`
- 返回结果满足条件或为空

### DEALS-SEARCH-004 非法 page

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 deals search --stage "赢单" --page 999 --json
```

预期：

- page 超出有效范围时应返回参数错误或空结果；不得 500

## 5.2 `deals by-account` → `/agent/v1/deals/byAccount`

### DEALS-BYACCOUNT-001 已知客户 ID

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 deals by-account --account-id 185165004027994962 --page 1 --json
```

预期：

- `error == ""`
- `data` 为数组

### DEALS-BYACCOUNT-002 不存在客户 ID

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 deals by-account --account-id 000000000000000000 --json
```

预期：

- `error == ""`
- `count == 0` 或 `data == []`

### DEALS-BYACCOUNT-003 account-id 缺失

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 deals by-account --json
```

预期：

- argparse 参数校验失败，退出非 `0`

---

## 6. Orders 合同接口

## 6.1 `orders search` → `/agent/v1/orders/search`

### ORDERS-SEARCH-001 按客户名称查询合同

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders search --account-name "广州辉洋进出口有限公司" --json
```

预期：

- `error == ""`
- `data` 为数组
- 记录如存在，应包含 `id`、`account_name`、`contract_stage`、`project_name`、`exhibition_zone`、`sales`、`amount`

### ORDERS-SEARCH-002 按项目/阶段查询

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders search --project "2026" --stage "赢单" --page 1 --json
```

预期：

- `error == ""`
- `data` 为数组

### ORDERS-SEARCH-003 日期范围查询

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders search --from 2026-01-01 --to 2026-12-31 --json
```

预期：

- `error == ""`
- `data` 为数组

### ORDERS-SEARCH-004 非法日期格式

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders search --from 2026/01/01 --to 2026/12/31 --json
```

预期：

- 返回参数错误或明确错误；不得 500

### ORDERS-SEARCH-005 不传筛选条件分页查询

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders search --page 1 --json
```

预期：

- V1.01 文档允许不传筛选条件分页查询合同
- `error == ""`
- `page == 1`

---

## 7. Events 会议/拜访接口

## 7.1 `events search` → `/agent/v1/events/search`

### EVENTS-SEARCH-001 按公司名查询会议记录

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 events search --company-name "广州辉洋进出口有限公司" --json
```

预期：

- `error == ""`
- `data` 为数组
- 记录如存在，应包含 `id`、`account_name`、`start_time`、`end_time`、`meeting_url`、`sales`

### EVENTS-SEARCH-002 按客户 ID 查询

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 events search --account-id 185165004027994962 --json
```

预期：

- `error == ""`
- `data` 为数组

### EVENTS-SEARCH-003 日期范围查询

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 events search --from 2026-01-01 --to 2026-12-31 --json
```

预期：

- `error == ""`
- `data` 为数组

### EVENTS-SEARCH-004 非法日期格式

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 events search --from 2026/01/01 --to 2026/12/31 --json
```

预期：

- 返回参数错误或明确错误；不得 500

## 7.2 `events count` → `/agent/v1/events/count`

### EVENTS-COUNT-001 按客户 ID 统计

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 events count --account-id 185165004027994962 --json
```

预期：

- `error == ""`
- `count == 1`
- `data` 为 object
- `data.total` 为 integer 且 `>= 0`

### EVENTS-COUNT-002 按日期范围统计

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 events count --from 2026-01-01 --to 2026-12-31 --json
```

预期：

- `error == ""`
- `data.total >= 0`

### EVENTS-COUNT-003 不传 page

确认 CLI 没有 `events count --page` 参数。

预期：

- 传入 `--page` 时 argparse 失败，退出非 `0`

---

## 8. Users 用户接口

## 8.1 `users all` → `/agent/v1/users/all`

### USERS-ALL-001 第一页用户列表

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 users all --page 1 --json
```

预期：

- `error == ""`
- `page == 1`
- `data` 为数组
- 记录如存在，应包含 `second_department`、`first_department`、`name`、`email`

### USERS-ALL-002 分页第二页

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 users all --page 2 --json
```

预期：

- 若第一页 `more_records == true`，第二页应 `error == ""`
- 第 2 页数据不应与第 1 页完全一致

### USERS-ALL-003 非法 page

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 users all --page 999 --json
```

预期：

- 超出范围时返回参数错误或空结果；不得 500

## 8.2 `users search` → `/agent/v1/users/search`

### USERS-SEARCH-001 使用 users all 返回样本姓名精确搜索

步骤：

1. 运行 `users all --page 1 --json`
2. 从 `data[]` 中取第一个非空 `name`
3. 执行：

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 users search --name "<样本姓名>" --json
```

预期：

- `error == ""`
- `count >= 1`
- 返回用户姓名与样本姓名一致

### USERS-SEARCH-002 不存在用户

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 users search --name "不存在用户-自动化测试-000000" --json
```

预期：

- `error == ""`
- `count == 0` 或 `data == []`

### USERS-SEARCH-003 name 缺失

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 users search --json
```

预期：

- argparse 参数校验失败，退出非 `0`

---

## 9. 停用接口防回归

### DISABLED-001 orders fields

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders fields
```

预期：

- 退出非 `0`
- stderr 提示 `/agent/v1/orders/fields` 已停用

### DISABLED-002 orders dictionary

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders dictionary
```

预期：

- 退出非 `0`
- stderr 提示 `/agent/v1/orders/dictionary` 已停用

---

## 10. Schema 校验建议

### 10.1 列表分页接口 Schema

适用：

- `accounts search`
- `deals search`
- `deals by-account`
- `orders search`
- `events search`
- `users all`

```json
{
  "type": "object",
  "required": ["count", "data", "error", "page", "more_records"],
  "properties": {
    "count": {"type": "integer"},
    "data": {"type": "array"},
    "error": {"type": "string"},
    "page": {"type": "integer"},
    "more_records": {"type": "boolean"}
  }
}
```

### 10.2 非分页列表接口 Schema

适用：

- `accounts by-names`
- `accounts by-ids`
- `accounts overview`
- `users search`

```json
{
  "type": "object",
  "required": ["count", "data", "error"],
  "properties": {
    "count": {"type": "integer"},
    "data": {"type": "array"},
    "error": {"type": "string"}
  }
}
```

### 10.3 统计接口 Schema

适用：`events count`

```json
{
  "type": "object",
  "required": ["count", "data", "error"],
  "properties": {
    "count": {"type": "integer"},
    "data": {
      "type": "object",
      "required": ["total"],
      "properties": {
        "total": {"type": "integer"}
      }
    },
    "error": {"type": "string"}
  }
}
```

---

## 11. 性能/稳定性测试

### PERF-001 11 个动作响应时间

对每个 happy path 执行一次，记录耗时。

预期：

- HTTP 成功类命令退出码 `0`
- 单接口建议 `< 5s`，CRM/Zoho 波动时单独记录

### PERF-002 小并发冒烟

范围：

- `accounts search`
- `deals by-account`
- `orders search`
- `events search`
- `users all`

并发：3 并发，各 3 次。

预期：

- 不出现大面积 401
- 不出现 5xx
- 错误率为 0 或有明确服务端错误

### PERF-003 分页连续拉取

范围：

- `accounts search --province 浙江省`
- `users all`

策略：最多连续拉 3 页。

预期：

- 每页 `error == ""`
- 若 `more_records == false`，停止
- 不重复请求同一页

---

## 12. 最小冒烟测试集

日常快速确认建议跑 6 条：

1. `accounts search --name 广州辉洋进出口有限公司 --json`
2. `accounts overview --name 广州辉洋进出口有限公司 --json`
3. `deals by-account --account-id 185165004027994962 --json`
4. `orders search --account-name 广州辉洋进出口有限公司 --json`
5. `events count --account-id 185165004027994962 --json`
6. `users all --page 1 --json`

全部通过即可认为核心链路可用。

---

## 13. 覆盖矩阵

| 模块 | CLI 动作数 | Happy Path | Error Path | 分页 | Schema | 鉴权 |
|---|---:|---:|---:|---|---|---|
| Auth | - | 1 | 3 | - | - | ✅ |
| Accounts | 4 | 7 | 5 | ✅ | ✅ | ✅ |
| Deals | 2 | 4 | 3 | ✅ | ✅ | ✅ |
| Orders | 1 | 5 | 1 | ✅ | ✅ | ✅ |
| Events | 2 | 6 | 2 | ✅ | ✅ | ✅ |
| Users | 2 | 4 | 3 | ✅ | ✅ | ✅ |
| Disabled | 2 | - | 2 | - | - | ✅ |

---

## 14. 注意事项

1. 这些测试均为只读查询，不修改 CRM 数据。
2. 不要把 `CRM_API_KEY` 明文写入脚本、日志、报告或 CI 输出。
3. `users search` 是严格等值匹配，样本姓名建议从 `users all` 动态获取。
4. `events count` 的总数位置是 `data.total`，不是顶层 `total`。
5. V1.01 不再提供 `orders/byAccount`，合同按客户查询应使用 `orders search --account-name`。
6. `/orders/fields`、`/orders/dictionary` 已停用，只做防回归。
