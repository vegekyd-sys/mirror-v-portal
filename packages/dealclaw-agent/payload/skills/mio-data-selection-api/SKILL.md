---
name: "mio-data-selection-api"
description: "补充CRM会议妙记转写查询流程"
---

# Update: mio-data-selection-api — CRM会议妙记转写标准流程

## Change Summary

新增「销售拜访妙记转写查询」标准流程，用于后续有人要求 V 查询当天销售拜访/会议妙记并做质检、分析、话术萃取时执行。

## Trigger

当用户要求：
- 查询今天销售提交的拜访/会议记录；
- 从 CRM 获取飞书妙记文字转写；
- 对当天销售首访/回访录音做质检、SOP 萃取、话术分析；
- 或提到“拜访小助手 / 会议模块 / 飞书妙记链接 / Zoho 系统重点模块数据字典 transcript curl”。

## Required Order — Do Not Skip

### Step 1 — 先筛选要分析的 CRM 会议数据

使用 Zoho CRM 的 Events/会议模块接口获取会议数据。

筛选条件必须先在 CRM 层确定：

- 签到日期 = 今天（Asia/Shanghai 当天日期）
- 一级部门包含：`销售部`

注意：不要先全量抓妙记 token；不要先从已知 token 直接批量拉转写。必须先按 CRM 会议数据筛出当天应该分析的数据。

### Step 2 — 获取飞书妙记链接字段

从筛出的会议记录里读取会议模块字段：

- `FeiShu_Meeting_Url` / 飞书妙记连接 / 飞书妙记链接

从该链接中提取 `minute_token`：

- 例：`https://xxx.feishu.cn/minutes/obcnxxxx`
- token 为路径最后一段：`obcnxxxx`

### Step 3 — 按数据字典 curl 拉完整转写

使用《Zoho系统重点模块数据字典》文档中“通过妙计链接获取文字记录”的 curl：

```bash
curl --location --request POST 'https://zoho.meorient.com/feishu_api/v1/minutes/transcript' \
--header 'Content-Type: application/json' \
--data-raw '{
  "key": "ktjkdffdsa45145657wqertgfdsa",
  "minute_token": "<minute_token>"
}'
```

返回结果是一份记录的完整文字转写。解析 `data.transcript` 或返回体中等价 transcript 内容。

### Step 4 — 再做分析

拿到完整文字转写后，再按业务目标分析：

- 首访三要素质检：
  1. 奥创公司介绍
  2. TK趋势
  3. 调研问卷 / 需求挖掘
- 销售流程阶段拆解
- 关键话术萃取
- 客户信息、异议、跟进动作
- 标杆案例和共性问题
- 每日质检简报 / 训练重点

## Validation

报告结果时应说明：

- CRM 筛选口径：签到日期、一级部门条件；
- 命中会议数量；
- 成功获取转写数量；
- 未获取成功的记录及原因；
- 不要把“开始时间筛选”的结果冒充“签到日期筛选”。

## Failure Modes

- Zoho API 慢或分页超时：降低字段量，只请求必要字段；分批分页；避免频繁 OAuth 换 token。
- `FeiShu_Meeting_Url` 为空：记录为无法拉转写，不要转而猜 token。
- 飞书原生 `vc +notes` 无权限：优先使用 Zoho 数据字典里的 proxy transcript curl，而不是要求妙记 owner 授权。
- 字段口径不确定：优先确认“签到日期”实际字段（如系统字段/自定义字段），不要用会议开始时间代替。
