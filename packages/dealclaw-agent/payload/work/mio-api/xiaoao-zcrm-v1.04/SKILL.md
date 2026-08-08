---
name: "zcrm"
description: "ZCRM Agent V1.04 全接口 CLI 查询"
title: "ZCRM Agent V1.04 CLI 查询"
summary: "用 CLI 包装 /agent/v1 的 CRM 与 BI 查询接口，一条命令出结果。"
read_when:
  - 用户问 CRM 客户、商机、合同、拜访/会议记录、用户查询
  - 用户输入 zcrm、zcrm --help、zcrm help、zcrm 加任意子命令或参数
  - 用户要求通过 zcrm、xiaoao-zcrm-v1-api 或 CRM Agent V1.04 API 查询数据
  - 用户提到 zohodata.meorient.com/agent 或 Agent V1.04 HTTP 接口
---

> 作者/发起人: 吴合伟  
> 更新发起人: 吴合伟（2026-07-22，要求将 `zcrm` 固化为 `xiaoao-zcrm-v1-api` 的唤醒别名，并将 `zcrm --help` 映射到实际 CLI 入口）  
> 当前版本依据: `Agent-V1.04-HTTP接口文档.md`，2026-07-24 吴合伟提供/要求升级

# ZCRM Agent V1.04 CLI 查询 Skill

这是 **ZCRM 查询 Skill**（原 `xiaoao-zcrm-v1-api`），与 Hanlin/Harlin 的 CRM Skill 区分开。用户明确指定 `zcrm`、`xiaoao-zcrm-v1-api`、`Agent V1.04`、或当前私聊要求时，使用本 Skill。

## 0. 别名与触发铁律

- `zcrm` 是本 Skill 的对外唤醒名，等价于旧名称 `xiaoao-zcrm-v1-api`。
- 用户输入裸 `zcrm`、`zcrm --help`、`zcrm help`、或 `zcrm <任意子命令/参数>` 时，必须理解为调用本 Skill，而不是要求执行系统 PATH 中的 `zcrm` shell 命令。
- **硬规则**：不要直接执行 `zcrm --help`，因为系统 PATH 里可能没有 `zcrm`，会返回 `zcrm: not found`。
- 如果需要运行 CLI，使用本 Skill 记录的实际可执行文件：

```bash
/root/makaron-openclaw/.openclaw-local/workspace/skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1
```

- 例如用户输入 `zcrm --help`，必须执行：

```bash
/root/makaron-openclaw/.openclaw-local/workspace/skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 --help
```

- 在 workspace 根目录也可以执行相对路径：

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 --help
```

- 用户输入 `zcrm <任意子命令/参数>` 时，将 `zcrm` 替换为实际入口后执行，例如：

```bash
# 用户输入
zcrm accounts search --name "广州辉洋进出口有限公司"

# 实际执行
/root/makaron-openclaw/.openclaw-local/workspace/skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --name "广州辉洋进出口有限公司"
```

- 不再要求用户改说 `xiaoao-zcrm` 或 `xiaoao-zcrm-v1-api`。

## 1. 执行 Checklist

每次调用前必须按顺序执行：

1. 确认用户查询意图属于客户 / 商机 / 合同 / 会议拜访 / 用户之一；若用户只是输入 `zcrm --help` 或 `zcrm help`，直接展示 CLI 帮助。
2. 选择下方 CLI 命令，不要手写 HTTP 请求，除非是在排错 CLI 本身。
3. 不输出 `CRM_API_KEY`、token 明文、Authorization 完整值。
4. 明细默认展示前 20 条；如用户要求全部且接口 `more_records=true`，按页继续拉取。
5. 错误时返回脱敏错误、HTTP 状态/接口名/参数摘要。
6. 调用后按 CRM 查询主动记录规则写入 CRM 查询监控表；若表格 400，回复中如实说明记录失败。

## 2. 服务与鉴权

- 服务根地址：`https://zohodata.meorient.com/agent`
- CLI 环境变量 `ZCRM_V1_BASE_URL` 可覆盖服务根地址；若传入值已以 `/v1` 结尾则不重复拼接
- API 前缀：`/v1`，完整业务路径形如 `/agent/v1/accounts/search`
- 所有接口均为 `POST` + `application/json`
- 单次返回上限：常规查询接口 1000 条；结算单及合同实收确收查询 2000 条
- 分页接口只接收 `page`，范围 `1..500`
- V1.04 统一用 `code/msg` 判断业务状态：`code=0` 成功，非 0 失败；兼容旧字段 `error` 和 `orders receipts` 示例 `code="OK"`

### 鉴权方式

`CRM_API_KEY` 是运行时环境变量/密钥名，值可为完整 `Bearer ...` 或纯 token。

CLI 固定处理为：

```text
从 CRM_API_KEY 读取 → 去掉已有 Bearer 前缀 → HTTP 发送 Authorization: Bearer <token>
```

严禁：

```http
CRM_API_KEY: ***
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

> V1.04 文档“接口汇总”列出 12 个接口，正文也明确提供 `/accounts/overview`。本 Skill 按明确动作路径包装，共 **13 个可调用 CLI 动作**。停用接口不作为正常能力使用。

### 4.1 Accounts 客户

#### 4.1.1 客户搜索 `/agent/v1/accounts/search`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --name "广州辉洋进出口有限公司"
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --province "浙江省" --page 1
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 accounts search --owner-name "张丽娜" --page 1
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
--owner-name
--owner-id  # 历史兼容，不推荐；V1.04 推荐 owner_name
--recent-touch-time
--recent-contact-time
--page
```

规则：至少一个非空条件；非空筛选条件最多 3 个；`name` 包含匹配；V1.04 起客户负责人查询使用 `--owner-name`。

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
--exhibition-type
--is-rollover
--sales
--account-name
--special-zone
--first-department
--contract-code
--first-exhibition
--customer-product
--second-exhibition
--from
--to
--performance-from
--performance-to
--page
```

规则：非空筛选条件最多 3 个；`--exhibition-type` 未传/空值时服务端默认按 `自办展` 查询并计入 1 个条件；`--is-rollover` 按 Zoho 原始值精确匹配（如 `是`/`否`）；日期格式 `YYYY-MM-DD`；`--from/--to` 按展会举办开始日期 `Start_Date`；`--performance-from/--performance-to` 按业绩提交日期 `Up_Orders_Day`；每个日期范围按一个逻辑条件计数。


#### 4.3.2 查询合同实收确收 `/agent/v1/orders/receipts`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders receipts --contract-id 185165004027994962
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 orders receipts --from 2026-07-01 --to 2026-07-31 --page 1
```

支持参数：

```text
--contract-id
--from
--to
--sales
--first-department
--account-name
--first-exhibition
--second-exhibition
--contract-stage
--page
```

规则：按合同汇总审批通过的实收与确收金额；`--from/--to` 是结算单业绩提交日期，传入日期时只返回范围内有审批通过结算单的合同；每页最多 2000 个合同。返回 `total_received` 总实收（审批通过的水单金额汇总）和 `total_confirmed` 总确收（审批通过的核销金额汇总）。

#### 4.3.3 已停用接口

以下接口 V1.04 文档标记已停用，不要作为正常能力调用：

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

严格等值匹配，不支持模糊搜索。V1.04 起返回 Zoho 用户 `id`；CLI 默认表格已直接展示 `Zoho ID`，适合“按姓名拉 Zoho ID”场景。客户负责人查询优先直接用 `accounts search --owner-name`。若不知道完整姓名，先 `users all --page 1` 找样本。

### 4.6 Settlements 结算单

#### 4.6.1 搜索结算单 `/agent/v1/settlements/search`

```bash
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 settlements search --order-id 185165004027994962
skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 settlements search --from 2026-07-01 --to 2026-07-31 --page 1
```

支持参数：

```text
--order-id
--from
--to
--sales
--first-department
--account-name
--first-exhibition
--second-exhibition
--page
```

规则：按条件查询结算单记录；每页最多 2000 条；`payment_amount` 是水单金额，`write_amount` 是核销金额，`approval_status` 是审批状态。


## 5. 业务口径规则

### 5.1 “参加过 / 复购”口径

吴合伟 2026-07-22 确认：在 CRM 展会/客户复购类查询里，用户说“参加过”“有几家参加过上一年”“复购”等话术时，默认含义是：

- **参加过 = 实际参展 = 合同阶段为 `赢单`**
- **复购 = 当期客户中，也在对比期有 `赢单` 合同的客户**
- 非赢单阶段（如丢单、提案/报价、商务谈判、合同签约、已退展、已转展等）不计入“参加过”或“复购”

执行要求：

1. 先按展会/年份/国家/品类等条件筛出合同。
2. 判断“参加过/复购”时必须额外筛 `contract_stage == 赢单`。
3. 输出时明确口径：仅统计赢单/实际参展客户。
4. 如果用户明确要求“所有相关合同/所有阶段”，才包含非赢单。

## 6. 输出规范

CLI 表格模式会按模块展示关键字段：

- Accounts：ID、客户名称、行业、客户级别、负责人
- Deals：ID、客户、项目、阶段、展区、销售
- Orders search：ID、合同编码、客户、合同阶段、项目、一级展会、展会类型、转展、销售、金额、总实收、总确收、业绩提交日
- Orders receipts：合同ID、合同编码、客户、销售、合同阶段、总实收、总确收
- Events：ID、客户、开始、结束、销售、妙记
- Users：Zoho ID、姓名、邮箱、一级部门、二级部门
- Settlements：结算单ID、水单金额、核销金额、一级部门、业绩提交日、销售、审批状态

Agent 回复时：

1. 先说明接口、条件、count、code/msg、more_records/page。
2. 明细类默认展示前 20 条。
3. `more_records=true` 且用户问“全部/所有”时，循环请求下一页，最多 page 500；若数据量很大，先提示可能较慢。
4. 统计类直接输出 `data.total`。
5. 无数据明确说“未查到”。
6. 错误展示脱敏错误和 `code/msg`，不输出 token 或完整 Authorization。

## 7. 已验证 Smoke Test

2026-07-22/24 已用 CLI 对以下动作做 smoke test；V1.04 起以 `code=0,msg=""` 为成功：

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

## 8. 排错

- `MISSING_ENV: CRM_API_KEY`：运行时缺少环境变量。
- `Unauthorized` / 401：token 无效或服务端鉴权失败。
- `HTTP 404`：路径未部署；先核对 V1.04 文档明确动作路径。
- `SYNTAX_ERROR`：多条件组合可能触发服务端 COQL 拼接问题；减少条件或反馈服务端修复。

## 9. V1.04 变更点

- `orders search` 新增/明确入参 `--first-exhibition`；返回新增/明确 `contract_code`、`first_exhibition`。
- `orders search` 的 `total_received` / `total_confirmed` 口径调整为**审批通过**的水单金额/核销金额汇总；没有审批通过结算单时为 `0.0`。
- `orders receipts` 新增入参/返回 `contract_stage`；传入 `from/to` 时只返回日期范围内有审批通过结算单的合同。
- `settlements search` 返回新增 `approval_status` 审批状态。
- 单次返回上限表述调整为：常规查询接口 1000 条；结算单及合同实收确收查询 2000 条。

## 10. 版本记录

- 2026-07-24：吴合伟提供 `Agent-V1.04-HTTP接口文档.md`，要求继续升级 `xiaoao-zcrm-v1-api`；补齐 `orders search` 的 `first_exhibition/contract_code`，`orders receipts` 的 `contract_stage`，`settlements search` 的 `approval_status`，并明确实收/确收只统计审批通过结算单。
- 2026-07-24：吴合伟提供 `Agent-V1.04-HTTP接口文档.md`，要求继续升级 `xiaoao-zcrm-v1-api`；新增 `orders receipts`、`settlements search`，补齐合同展会类型/转展/实收/确收字段，并改为以 `code/msg` 判断业务状态。
- 2026-07-24：吴合伟要求按附件 V1.02 接口文档重新核对升级 `xiaoao-zcrm-v1-api`，确认 CLI 覆盖 `/agent` 下 V1.02 所有明确业务接口；补强 `users search/all` 默认表格展示 Zoho ID，并更新 Skill 说明。
- 2026-07-22：吴合伟要求补强 `zcrm --help` 的实际执行命令，明确禁止直接执行 PATH 中的 `zcrm --help`，必须映射为 `/root/makaron-openclaw/.openclaw-local/workspace/skills/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1 --help`。
- 2026-07-22：依据吴合伟提供的 `Agent-V1.02-HTTP接口文档.md` 升级 owner_name、performance 日期、users id 和 up_orders_day。
- 2026-07-20：依据吴合伟提供的 `Agent-V1.01-HTTP接口文档.md` 升级为 CLI 封装版。
- `orders/byAccount` 已从正常能力中移除，因为 V1.01/V1.02/V1.02/V1.03/V1.04 文档均未列为可用接口。
- 新增 Users：`users/all`、`users/search`。
- `events/count` 按 V1.01/V1.02/V1.03/V1.04 文档修正为读取 `data.total`。
