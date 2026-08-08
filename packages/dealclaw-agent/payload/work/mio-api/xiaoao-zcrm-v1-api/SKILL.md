---
name: "xiaoao-zcrm-v1-api"
description: "小奥专用 CRM Agent V1.01 CLI 技能，token 存 CRM_API_KEY，HTTP 鉴权使用 Authorization: Bearer。"
title: "小奥 CRM Agent V1.01 CLI 查询"
summary: "小奥专用：用 CLI 调用 https://zohodata.meorient.com/agent/v1 的 CRM Agent V1.01 接口，一条命令出结果。"
read_when:
  - 用户问 CRM 客户、商机、合同、拜访/会议记录、用户查询
  - 用户要求通过 xiaoao-zcrm-v1-api 或 CRM Agent V1.01 API 查询数据
  - 用户提到 zohodata.meorient.com/agent 或 Agent V1.01 HTTP 接口
---
> 作者/发起人: 吴合伟  
> 当前版本依据: `Agent-V1.01-HTTP接口文档.md`，2026-07-20 吴合伟提供

# 小奥 CRM Agent V1.01 CLI 查询 Skill

这是 **小奥专用 Skill**，与 Hanlin/Harlin 的 CRM Skill 区分开。用户明确指定 `xiaoao-zcrm-v1-api`、`Agent V1.01`、或当前私聊要求时，使用本 Skill。

## 1. 执行 Checklist

每次调用前必须按顺序执行：

1. 确认用户查询意图属于客户 / 商机 / 合同 / 会议拜访 / 用户之一。
2. 选择下方 CLI 命令，不要手写 HTTP 请求，除非是在排错 CLI 本身。
3. 不输出 `CRM_API_KEY`、token 明文、Authorization 完整值。
4. 明细默认展示前 20 条；如用户要求全部且接口 `more_records=true`，按页继续拉取。
5. 错误时返回脱敏错误、HTTP 状态/接口名/参数摘要。
6. 调用后按 CRM 查询主动记录规则写入 CRM 查询监控表；若表格 400，回复中如实说明记录失败。

## 2. 服务与鉴权

- 服务根地址：`https://zohodata.meorient.com/agent`
- API 前缀：`/v1`，完整业务路径形如 `/agent/v1/accounts/search`
- 所有接口均为 `POST` + `application/json`
- 单次返回上限：1000 条
- 分页接口只接收 `page`，范围 `1..500`

### 鉴权方式

`CRM_API_KEY` 是运行时环境变量/密钥名，值可为完整 `Bearer ...` 或纯 token。

CLI 固定处理为：

```text
从 CRM_API_KEY 读取 → 去掉已有 Bearer 前缀 → HTTP 发送 Authorization: Bearer <token>
```

严禁：

```http
CRM_API_KEY: <token>
```

## 3. CLI 入口

CLI 文件：

```bash
/root/makaron-openclaw/.openclaw-local/workspace/skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1
```

推荐在 workspace 根目录调用：

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 --help
```

通用选项：

- `--json`：输出完整 JSON，适合进一步处理
- `--limit N`：表格模式最多展示 N 条，默认 20
- `--page N`：分页接口页码

## 4. 可用 CLI 命令

> V1.01 文档“接口汇总”列出 10 个接口，但正文也明确提供 `/accounts/overview`。本 Skill 按明确动作路径包装，共 **11 个可调用 CLI 动作**。停用接口不作为正常动作使用。

### 4.1 Accounts 客户

#### 4.1.1 客户搜索 `/agent/v1/accounts/search`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --name "广州辉洋进出口有限公司"
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --province "浙江省" --page 1
```

支持参数：

```text
--name
--customer-level
--data-type
--industry-tags
--product-tags
--registered-area
--registered-district
--province
--city
--source
--owner-id
--recent-touch-time
--recent-contact-time
--page
```

规则：至少一个非空条件；非空筛选条件最多 3 个；`name` 包含匹配。

#### 4.1.2 按公司名称批量获取 `/agent/v1/accounts/byNames`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts by-names --name "广州辉洋进出口有限公司"
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts by-names --names "公司A,公司B"
```

参数：`--name` 可重复，或 `--names` 逗号分隔；最多 1000 个，自动去空、去重。

#### 4.1.3 按客户 ID 批量获取 `/agent/v1/accounts/byIds`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts by-ids --id 185165004027994962
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts by-ids --ids "185165004027994962,185165000006016630"
```

参数：`--id` 可重复，或 `--ids` 逗号分隔；最多 1000 个。

#### 4.1.4 客户 360 `/agent/v1/accounts/overview`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts overview --name "广州辉洋进出口有限公司"
```

要求完整客户名称。返回 account、deals、orders、events 概览；某个子模块失败时，其余模块仍可返回。

### 4.2 Deals 商机

#### 4.2.1 商机条件搜索 `/agent/v1/deals/search`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 deals search --account-name "广州辉洋进出口有限公司"
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 deals search --stage "赢单" --sales "张三" --page 1
```

支持参数：

```text
--stage
--sales
--account-name
--project
--first-department
--first-exhibition
--zone
--second-exhibition
--page
```

规则：非空筛选条件最多 3 个；不传筛选条件时也可分页查询商机。

#### 4.2.2 按客户 ID 查询关联商机 `/agent/v1/deals/byAccount`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 deals by-account --account-id 185165004027994962 --page 1
```

### 4.3 Orders 合同

#### 4.3.1 搜索合同 `/agent/v1/orders/search`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders search --account-name "广州辉洋进出口有限公司"
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders search --project "2026" --stage "赢单" --from 2026-01-01 --page 1
```

支持参数：

```text
--zone
--project
--stage
--sales
--account-name
--special-zone
--first-department
--contract-code
--customer-product
--second-exhibition
--from
--to
--page
```

规则：非空筛选条件最多 3 个；日期格式 `YYYY-MM-DD`；不传筛选条件时也可分页查询合同。

#### 4.3.2 已停用接口

以下接口 V1.01 文档标记已停用，不要作为正常能力调用：

```text
/agent/v1/orders/fields
/agent/v1/orders/dictionary
```

CLI 中保留 `orders fields` / `orders dictionary` 仅用于提示停用，会退出失败。

### 4.4 Events 会议/拜访记录

#### 4.4.1 搜索会议记录 `/agent/v1/events/search`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 events search --company-name "广州辉洋进出口有限公司"
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 events search --account-id 185165004027994962 --from 2026-01-01 --to 2026-12-31
```

支持参数：

```text
--account-id
--from
--to
--sales
--first-department
--company-name
--page
```

规则：非空筛选条件最多 3 个；日期格式 `YYYY-MM-DD`；不传筛选条件时也可分页查询记录。

#### 4.4.2 统计会议记录数量 `/agent/v1/events/count`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 events count --account-id 185165004027994962
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 events count --from 2026-01-01 --to 2026-12-31
```

支持参数：`--account-id`、`--from`、`--to`。不接收 `page`。返回值读取 `data.total`。

### 4.5 Users 用户

#### 4.5.1 获取所有用户 `/agent/v1/users/all`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 users all --page 1
```

分页接口，每页最多 1000 条。

#### 4.5.2 按完整姓名搜索用户 `/agent/v1/users/search`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 users search --name "测试用户"
```

严格等值匹配，不支持模糊搜索。若不知道完整姓名，先 `users all --page 1` 找样本。

## 5. 输出规范

CLI 表格模式会按模块展示关键字段：

- Accounts：ID、客户名称、行业、客户级别、负责人
- Deals：ID、客户、项目、阶段、展区、销售
- Orders：ID、客户、合同阶段、项目、展区、销售、金额
- Events：ID、客户、开始、结束、销售、妙记
- Users：姓名、邮箱、一级部门、二级部门

Agent 回复时：

1. 先说明接口、条件、count、more_records/page。
2. 明细类默认展示前 20 条。
3. `more_records=true` 且用户问“全部/所有”时，循环请求下一页，最多 page 500；若数据量很大，先提示可能较慢。
4. 统计类直接输出 `data.total`。
5. 无数据明确说“未查到”。
6. 错误展示脱敏错误，不输出 token 或完整 Authorization。

## 6. 已验证 Smoke Test

2026-07-20 已用 V1.01 CLI 对以下动作做 smoke test，均返回 `error=""`：

| CLI 动作 | 结果摘要 |
|---|---|
| `accounts search --name 广州辉洋进出口有限公司` | count=1 |
| `accounts by-names --name 广州辉洋进出口有限公司` | count=1 |
| `accounts by-ids --id 185165004027994962` | count=1 |
| `accounts overview --name 广州辉洋进出口有限公司` | count=1 |
| `deals search --account-name 广州辉洋进出口有限公司` | count=3 |
| `deals by-account --account-id 185165004027994962` | count=1 |
| `orders search --account-name 广州辉洋进出口有限公司` | count=3 |
| `events search --company-name 广州辉洋进出口有限公司` | count=2 |
| `events count --account-id 185165004027994962` | data.total=0 |
| `users all --page 1` | count=200, more_records=true |
| `users search --name <users/all返回样本>` | count=1 |

## 7. 排错

- `MISSING_ENV: CRM_API_KEY`：运行时缺少环境变量。
- `Unauthorized` / 401：token 无效或服务端鉴权失败。
- `HTTP 404`：路径未部署；先核对 V1.01 文档明确动作路径。
- `SYNTAX_ERROR`：多条件组合可能触发服务端 COQL 拼接问题；减少条件或反馈服务端修复。

## 8. 版本记录

- 2026-07-20：依据吴合伟提供的 `Agent-V1.01-HTTP接口文档.md` 升级为 CLI 封装版。
- `orders/byAccount` 已从正常能力中移除，因为 V1.01 文档不再列为可用接口。
- 新增 Users：`users/all`、`users/search`。
- `events/count` 按 V1.01 文档修正为读取 `data.total`。
