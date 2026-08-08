# xiaoao-zcrm-v1-api V1.01 CLI 自动化测试报告

> 测试时间：2026-07-20 16:49 GMT+8  
> 测试对象：`xiaoao-zcrm-v1-api` V1.01 CLI 封装版  
> 测试脚本：`output/test_xiaoao_zcrm_v1_01_cli.py`  
> 测试用例文档：`output/xiaoao-zcrm-v1.01-cli-test-cases.md`  
> CLI：`skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1`  
> 安全说明：报告不包含任何密钥明文。

---

## 1. 总体结果

```text
53 passed in 76.89s (0:01:16)
```

| 项目 | 结果 |
|---|---:|
| 总用例数 | 53 |
| 通过 | 53 |
| 失败 | 0 |
| 通过率 | 100% |

结论：**V1.01 新版 CLI 封装当前可用，返回结构符合测试用例预期。**

---

## 2. 鉴权验证

已验证：

- `CRM_API_KEY` 作为运行时环境变量读取。
- CLI 去掉已有 `Bearer ` 前缀后，HTTP 只发送 `Authorization: Bearer <token>`。
- 不发送 `CRM_API_KEY` 作为 HTTP header。
- 缺少 `CRM_API_KEY` 时返回 `MISSING_ENV: CRM_API_KEY`。
- 错误 token 时返回 Unauthorized/401 类错误。
- stdout/stderr 未出现密钥明文。

结论：**鉴权链路正确。**

---

## 3. 11 个 CLI 动作验证结果

| 模块 | CLI 动作 | 对应接口 | 结果 |
|---|---|---|---|
| Accounts | `accounts search` | `/agent/v1/accounts/search` | 通过 |
| Accounts | `accounts by-names` | `/agent/v1/accounts/byNames` | 通过 |
| Accounts | `accounts by-ids` | `/agent/v1/accounts/byIds` | 通过 |
| Accounts | `accounts overview` | `/agent/v1/accounts/overview` | 通过 |
| Deals | `deals search` | `/agent/v1/deals/search` | 通过 |
| Deals | `deals by-account` | `/agent/v1/deals/byAccount` | 通过 |
| Orders | `orders search` | `/agent/v1/orders/search` | 通过 |
| Events | `events search` | `/agent/v1/events/search` | 通过 |
| Events | `events count` | `/agent/v1/events/count` | 通过 |
| Users | `users all` | `/agent/v1/users/all` | 通过 |
| Users | `users search` | `/agent/v1/users/search` | 通过 |

---

## 4. 覆盖内容

本次自动化测试覆盖：

1. CLI help 基础可用性。
2. 正确鉴权、缺失鉴权、错误鉴权。
3. Accounts：搜索、分页、批量名称、批量 ID、客户 360、无数据、参数异常。
4. Deals：条件搜索、客户 ID 查询、无数据、参数异常。
5. Orders：合同搜索、项目/阶段、日期范围、空条件分页、异常日期。
6. Events：会议搜索、客户 ID、公司名、日期范围、统计 `data.total`、异常参数。
7. Users：用户分页、按完整姓名搜索、无数据、参数缺失。
8. 停用接口：`orders fields`、`orders dictionary` 均提示已停用并退出非 0。
9. 最小冒烟集：6 条核心命令全部通过。

---

## 5. 停用接口防回归

已验证：

- `orders fields`
- `orders dictionary`

CLI 均会提示对应 `/agent/v1/orders/fields`、`/agent/v1/orders/dictionary` 已停用，并退出非 0。

结论：**停用接口不会被 Agent 当成正常能力调用。**

---

## 6. 结论

`xiaoao-zcrm-v1-api` V1.01 CLI 当前状态：

```text
可用
```

可以让 Agent 使用一条 CLI 命令调用每个接口并返回结果。

建议后续作为日常健康检查保留最小冒烟集：

```bash
pytest -q output/test_xiaoao_zcrm_v1_01_cli.py -k minimal_smoke_set
```
---

## 7. 53 个自动化测试用例明细

> 以下用例从实际执行的 pytest 脚本 `output/test_xiaoao_zcrm_v1_01_cli.py` 提取；本次执行结果均为通过。

| # | 用例 | 模块 | 对应命令/测试函数 | 结果 |
|---:|---|---|---|---|
| 1 | AUTH-001 CLI help 可用 | 鉴权/CLI | `test_auth_001_help_available` | 通过 |
| 2 | AUTH-002 正确鉴权可调用客户查询 | 鉴权/CLI | `test_auth_002_valid_auth_accounts_search` | 通过 |
| 3 | AUTH-003 缺少 CRM_API_KEY 时失败且不泄露密钥 | 鉴权/CLI | `test_auth_003_missing_env_fails_without_leak` | 通过 |
| 4 | AUTH-004 错误 token 时失败且不泄露密钥 | 鉴权/CLI | `test_auth_004_wrong_token_fails_without_leak` | 通过 |
| 5 | AUTH-005 确认 CLI 不发送 CRM_API_KEY header | 鉴权/CLI | `test_auth_005_cli_does_not_send_crm_api_key_header` | 通过 |
| 6 | ACC-SEARCH-001 按客户名称查询 | Accounts | `test_acc_search_001_by_name` | 通过 |
| 7 | ACC-SEARCH-002 按省份查询第一页 | Accounts | `test_acc_search_002_province_page1` | 通过 |
| 8 | ACC-SEARCH-003 如有下一页则验证第二页 | Accounts | `test_acc_search_003_province_page2_if_needed` | 通过 |
| 9 | ACC-SEARCH-004 三条件组合不得 500 | Accounts | `test_acc_search_004_three_conditions_no_500` | 通过 |
| 10 | ACC-SEARCH-005 超过 3 个条件应拒绝或不得 500 | Accounts | `test_acc_search_005_more_than_three_conditions_rejected_or_no_500` | 通过 |
| 11 | ACC-SEARCH-006 无匹配客户 | Accounts | `test_acc_search_006_no_match` | 通过 |
| 12 | ACC-BYNAMES-001 单公司名称命中 | Accounts | `test_acc_by_names_001_single_hit` | 通过 |
| 13 | ACC-BYNAMES-002 多公司混合命中/未命中 | Accounts | `test_acc_by_names_002_mixed` | 通过 |
| 14 | ACC-BYNAMES-003 names 为空不得 500 | Accounts | `test_acc_by_names_003_empty_no_500` | 通过 |
| 15 | ACC-BYIDS-001 单客户 ID 命中 | Accounts | `test_acc_by_ids_001_single_hit` | 通过 |
| 16 | ACC-BYIDS-002 多 ID 混合命中/未命中 | Accounts | `test_acc_by_ids_002_mixed` | 通过 |
| 17 | ACC-BYIDS-003 ids 为空不得 500 | Accounts | `test_acc_by_ids_003_empty_no_500` | 通过 |
| 18 | ACC-OVERVIEW-001 客户 360 命中 | Accounts | `test_acc_overview_001_hit` | 通过 |
| 19 | ACC-OVERVIEW-002 客户 360 无匹配 | Accounts | `test_acc_overview_002_no_match` | 通过 |
| 20 | ACC-OVERVIEW-003 缺少 name 参数失败 | Accounts | `test_acc_overview_003_missing_name_argparse_fails` | 通过 |
| 21 | DEALS-SEARCH-001 按客户名称查询商机 | Deals | `test_deals_search_001_by_account_name` | 通过 |
| 22 | DEALS-SEARCH-002 按阶段查询商机 | Deals | `test_deals_search_002_by_stage` | 通过 |
| 23 | DEALS-SEARCH-003 商机组合条件查询 | Deals | `test_deals_search_003_combo` | 通过 |
| 24 | DEALS-SEARCH-004 非法/越界 page 不得 500 | Deals | `test_deals_search_004_bad_page_no_500` | 通过 |
| 25 | DEALS-BYACCOUNT-001 已知客户 ID 查询商机 | Deals | `test_deals_by_account_001_known` | 通过 |
| 26 | DEALS-BYACCOUNT-002 不存在客户 ID 查询商机 | Deals | `test_deals_by_account_002_unknown` | 通过 |
| 27 | DEALS-BYACCOUNT-003 缺少 account-id 参数失败 | Deals | `test_deals_by_account_003_missing_id_argparse_fails` | 通过 |
| 28 | ORDERS-SEARCH-001 按客户名称查询合同 | Orders | `test_orders_search_001_by_account_name` | 通过 |
| 29 | ORDERS-SEARCH-002 按项目/阶段查询合同 | Orders | `test_orders_search_002_project_stage` | 通过 |
| 30 | ORDERS-SEARCH-003 按日期范围查询合同 | Orders | `test_orders_search_003_date_range` | 通过 |
| 31 | ORDERS-SEARCH-004 非法日期不得 500 | Orders | `test_orders_search_004_bad_date_no_500` | 通过 |
| 32 | ORDERS-SEARCH-005 无筛选条件分页查询合同 | Orders | `test_orders_search_005_no_filters_page` | 通过 |
| 33 | EVENTS-SEARCH-001 按公司名查询会议记录 | Events | `test_events_search_001_company_name` | 通过 |
| 34 | EVENTS-SEARCH-002 按客户 ID 查询会议记录 | Events | `test_events_search_002_account_id` | 通过 |
| 35 | EVENTS-SEARCH-003 按日期范围查询会议记录 | Events | `test_events_search_003_date_range` | 通过 |
| 36 | EVENTS-SEARCH-004 非法日期不得 500 | Events | `test_events_search_004_bad_date_no_500` | 通过 |
| 37 | EVENTS-COUNT-001 按客户 ID 统计会议记录 | Events | `test_events_count_001_account_id` | 通过 |
| 38 | EVENTS-COUNT-002 按日期范围统计会议记录 | Events | `test_events_count_002_date_range` | 通过 |
| 39 | EVENTS-COUNT-003 events count 不接受 page 参数 | Events | `test_events_count_003_page_argparse_fails` | 通过 |
| 40 | USERS-ALL-001 获取用户第一页 | Users | `test_users_all_001_page1` | 通过 |
| 41 | USERS-ALL-002 如有下一页则验证用户第二页 | Users | `test_users_all_002_page2_if_needed` | 通过 |
| 42 | USERS-ALL-003 越界 page 不得 500 | Users | `test_users_all_003_bad_page_no_500` | 通过 |
| 43 | USERS-SEARCH-001 用 users all 样本姓名精确搜索 | Users | `test_users_search_001_sample` | 通过 |
| 44 | USERS-SEARCH-002 不存在用户搜索 | Users | `test_users_search_002_unknown` | 通过 |
| 45 | USERS-SEARCH-003 缺少 name 参数失败 | Users | `test_users_search_003_missing_name_argparse_fails` | 通过 |
| 46 | orders fields 已停用 | 停用接口防回归 | `orders fields` | 通过 |
| 47 | orders dictionary 已停用 | 停用接口防回归 | `orders dictionary` | 通过 |
| 48 | 最小冒烟：accounts search | 最小冒烟 | `accounts search --name <KNOWN_ACCOUNT_NAME>` | 通过 |
| 49 | 最小冒烟：accounts overview | 最小冒烟 | `accounts overview --name <KNOWN_ACCOUNT_NAME>` | 通过 |
| 50 | 最小冒烟：deals by-account | 最小冒烟 | `deals by-account --account-id <KNOWN_ACCOUNT_ID>` | 通过 |
| 51 | 最小冒烟：orders search | 最小冒烟 | `orders search --account-name <KNOWN_ACCOUNT_NAME>` | 通过 |
| 52 | 最小冒烟：events count | 最小冒烟 | `events count --account-id <KNOWN_ACCOUNT_ID>` | 通过 |
| 53 | 最小冒烟：users all | 最小冒烟 | `users all --page 1` | 通过 |
---

## 8. 实际测试参数明细

> 本节列出本次自动化测试实际使用的样本值和每条用例的关键参数。所有密钥/Authorization 信息均不展示。

### 8.1 全局样本参数

| 参数名 | 实际值 | 用途 |
|---|---|---|
| `KNOWN_ACCOUNT_NAME` | `广州辉洋进出口有限公司` | 客户、商机、合同、会议记录查询样本公司 |
| `KNOWN_ACCOUNT_ID` | `185165004027994962` | 客户 ID、商机 by-account、会议 count/search 样本 ID |
| `KNOWN_PROVINCE` | `浙江省` | 客户按省份分页测试 |
| `UNKNOWN_ACCOUNT_NAME` | `不存在客户-自动化测试-000000` | 无匹配客户/客户 360 空结果测试 |
| `UNKNOWN_ACCOUNT_ID` | `000000000000000000` | 无匹配 ID 测试 |
| `用户样本` | 从 `users all --page 1` 返回中动态取第一个非空 `name` | `users search` 精确姓名搜索 |
| `日期范围` | `2026-01-01` 至 `2026-12-31` | 合同/会议日期范围查询 |
| `非法日期范围` | `2026/01/01` 至 `2026/12/31` | 日期格式异常测试 |
| `项目关键词` | `2026` | 合同项目查询 |
| `商机/合同阶段` | `赢单` | 商机、合同阶段筛选 |
| `城市` | `杭州市` | 客户三条件/超条件组合测试 |
| `客户级别` | `自拓客户` | 客户三条件/超条件组合测试 |
| `客户来源` | `展会` | 超过 3 个筛选条件测试 |
| `错误 token` | `Bearer invali…test` | 错误鉴权测试，仅为假值 |

### 8.2 每条用例的实际参数

| # | 用例 | 实际命令 / 参数 |
|---:|---|---|
| 1 | AUTH-001 CLI help 可用 | `xiaoao-zcrm-v1 --help` |
| 2 | AUTH-002 正确鉴权可调用客户查询 | `accounts search --name "广州辉洋进出口有限公司" --json` |
| 3 | AUTH-003 缺少 CRM_API_KEY | `env -u CRM_API_KEY accounts search --name "广州辉洋进出口有限公司" --json` |
| 4 | AUTH-004 错误 token | `CRM_API_KEY="Bearer invali…test" accounts search --name "广州辉洋进出口有限公司" --json` |
| 5 | AUTH-005 确认 CLI 不发送 CRM_API_KEY header | 静态检查 CLI 源码：请求 headers 只允许 `Authorization`、`Content-Type`、`Accept` |
| 6 | ACC-SEARCH-001 按客户名称查询 | `accounts search --name "广州辉洋进出口有限公司" --json` |
| 7 | ACC-SEARCH-002 按省份查询第一页 | `accounts search --province "浙江省" --page 1 --json` |
| 8 | ACC-SEARCH-003 如有下一页则验证第二页 | 先跑 `accounts search --province "浙江省" --page 1 --json`；若 `more_records=true`，再跑 `accounts search --province "浙江省" --page 2 --json` |
| 9 | ACC-SEARCH-004 三条件组合不得 500 | `accounts search --province "浙江省" --city "杭州市" --customer-level "自拓客户" --page 1 --json` |
| 10 | ACC-SEARCH-005 超过 3 个条件应拒绝或不得 500 | `accounts search --province "浙江省" --city "杭州市" --customer-level "自拓客户" --source "展会" --page 1 --json` |
| 11 | ACC-SEARCH-006 无匹配客户 | `accounts search --name "不存在客户-自动化测试-000000" --json` |
| 12 | ACC-BYNAMES-001 单公司名称命中 | `accounts by-names --name "广州辉洋进出口有限公司" --json` |
| 13 | ACC-BYNAMES-002 多公司混合命中/未命中 | `accounts by-names --names "广州辉洋进出口有限公司,不存在客户-自动化测试-000000" --json` |
| 14 | ACC-BYNAMES-003 names 为空不得 500 | `accounts by-names --json`，即不传 `--name/--names` |
| 15 | ACC-BYIDS-001 单客户 ID 命中 | `accounts by-ids --id 185165004027994962 --json` |
| 16 | ACC-BYIDS-002 多 ID 混合命中/未命中 | `accounts by-ids --ids "185165004027994962,000000000000000000" --json` |
| 17 | ACC-BYIDS-003 ids 为空不得 500 | `accounts by-ids --json`，即不传 `--id/--ids` |
| 18 | ACC-OVERVIEW-001 客户 360 命中 | `accounts overview --name "广州辉洋进出口有限公司" --json` |
| 19 | ACC-OVERVIEW-002 客户 360 无匹配 | `accounts overview --name "不存在客户-自动化测试-000000" --json` |
| 20 | ACC-OVERVIEW-003 缺少 name 参数失败 | `accounts overview --json`，即不传 `--name` |
| 21 | DEALS-SEARCH-001 按客户名称查询商机 | `deals search --account-name "广州辉洋进出口有限公司" --json` |
| 22 | DEALS-SEARCH-002 按阶段查询商机 | `deals search --stage "赢单" --page 1 --json` |
| 23 | DEALS-SEARCH-003 商机组合条件查询 | `deals search --stage "赢单" --account-name "广州辉洋进出口有限公司" --page 1 --json` |
| 24 | DEALS-SEARCH-004 非法/越界 page 不得 500 | `deals search --stage "赢单" --page 999 --json` |
| 25 | DEALS-BYACCOUNT-001 已知客户 ID 查询商机 | `deals by-account --account-id 185165004027994962 --page 1 --json` |
| 26 | DEALS-BYACCOUNT-002 不存在客户 ID 查询商机 | `deals by-account --account-id 000000000000000000 --json` |
| 27 | DEALS-BYACCOUNT-003 缺少 account-id 参数失败 | `deals by-account --json`，即不传 `--account-id` |
| 28 | ORDERS-SEARCH-001 按客户名称查询合同 | `orders search --account-name "广州辉洋进出口有限公司" --json` |
| 29 | ORDERS-SEARCH-002 按项目/阶段查询合同 | `orders search --project "2026" --stage "赢单" --page 1 --json` |
| 30 | ORDERS-SEARCH-003 按日期范围查询合同 | `orders search --from 2026-01-01 --to 2026-12-31 --json` |
| 31 | ORDERS-SEARCH-004 非法日期不得 500 | `orders search --from 2026/01/01 --to 2026/12/31 --json` |
| 32 | ORDERS-SEARCH-005 无筛选条件分页查询合同 | `orders search --page 1 --json` |
| 33 | EVENTS-SEARCH-001 按公司名查询会议记录 | `events search --company-name "广州辉洋进出口有限公司" --json` |
| 34 | EVENTS-SEARCH-002 按客户 ID 查询会议记录 | `events search --account-id 185165004027994962 --json` |
| 35 | EVENTS-SEARCH-003 按日期范围查询会议记录 | `events search --from 2026-01-01 --to 2026-12-31 --json` |
| 36 | EVENTS-SEARCH-004 非法日期不得 500 | `events search --from 2026/01/01 --to 2026/12/31 --json` |
| 37 | EVENTS-COUNT-001 按客户 ID 统计会议记录 | `events count --account-id 185165004027994962 --json` |
| 38 | EVENTS-COUNT-002 按日期范围统计会议记录 | `events count --from 2026-01-01 --to 2026-12-31 --json` |
| 39 | EVENTS-COUNT-003 events count 不接受 page 参数 | `events count --account-id 185165004027994962 --page 1 --json` |
| 40 | USERS-ALL-001 获取用户第一页 | `users all --page 1 --json` |
| 41 | USERS-ALL-002 如有下一页则验证用户第二页 | 先跑 `users all --page 1 --json`；若 `more_records=true`，再跑 `users all --page 2 --json` |
| 42 | USERS-ALL-003 越界 page 不得 500 | `users all --page 999 --json` |
| 43 | USERS-SEARCH-001 用 users all 样本姓名精确搜索 | 从 `users all --page 1 --json` 的 `data[]` 中取第一个非空 `name`，再执行 `users search --name "<样本姓名>" --json` |
| 44 | USERS-SEARCH-002 不存在用户搜索 | `users search --name "不存在用户-自动化测试-000000" --json` |
| 45 | USERS-SEARCH-003 缺少 name 参数失败 | `users search --json`，即不传 `--name` |
| 46 | DISABLED-001 orders fields 已停用 | `orders fields`，预期 stderr 包含 `/agent/v1/orders/fields` 和“已停用” |
| 47 | DISABLED-002 orders dictionary 已停用 | `orders dictionary`，预期 stderr 包含 `/agent/v1/orders/dictionary` 和“已停用” |
| 48 | 最小冒烟：accounts search | `accounts search --name "广州辉洋进出口有限公司" --json` |
| 49 | 最小冒烟：accounts overview | `accounts overview --name "广州辉洋进出口有限公司" --json` |
| 50 | 最小冒烟：deals by-account | `deals by-account --account-id 185165004027994962 --json` |
| 51 | 最小冒烟：orders search | `orders search --account-name "广州辉洋进出口有限公司" --json` |
| 52 | 最小冒烟：events count | `events count --account-id 185165004027994962 --json` |
| 53 | 最小冒烟：users all | `users all --page 1 --json` |

### 8.3 实际组合条件汇总

| 场景 | 组合条件 |
|---|---|
| 客户三条件组合 | `province=浙江省` + `city=杭州市` + `customer_level=自拓客户` + `page=1` |
| 客户超过三条件组合 | `province=浙江省` + `city=杭州市` + `customer_level=自拓客户` + `source=展会` + `page=1` |
| 商机组合条件 | `stage=赢单` + `account_name=广州辉洋进出口有限公司` + `page=1` |
| 合同项目/阶段组合 | `project=2026` + `stage=赢单` + `page=1` |
| 合同日期范围 | `from=2026-01-01` + `to=2026-12-31` |
| 会议日期范围 | `from=2026-01-01` + `to=2026-12-31` |
| 合同非法日期 | `from=2026/01/01` + `to=2026/12/31` |
| 会议非法日期 | `from=2026/01/01` + `to=2026/12/31` |
| 公司名混合命中/未命中 | `广州辉洋进出口有限公司` + `不存在客户-自动化测试-000000` |
| 客户 ID 混合命中/未命中 | `185165004027994962` + `000000000000000000` |
