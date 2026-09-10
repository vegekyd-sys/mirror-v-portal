---
name: dealclaw-peer-search
description: >-
  搜同行 Skill：查类目、按类目/国家搜同行企业、看各国同行数、查同行买家。
  统一走 xiaoyuan CLI 的 `colleague` 命令组（对应 blade-agent-adapter /agent/colleague/*）。
  用于「搜同行/找同类展商/同行企业/同行买家/竞品展商」等意图。
metadata:
  openclaw:
    emoji: "🏢"
---

# 小元-搜同行（可执行）

对应慧展 `/aiSearch/colleague`。  
**必须用 `xc`/`bash` 跑 `xiaoyuan colleague` 命令**，以 stdout JSON 为事实再回复；不要只读文档假装已调用。

接口源：`AgentColleagueSearchController` → `/agent/colleague/*`  
默认 Base URL：`https://micro.tradechina.com/blade-agent-adapter`

## 鉴权（必须显式传，禁止靠环境变量自动读）

`xiaoyuan` CLI 只认 `MEO_OPEN_ID` / `MEO_SUPPLIER_ID` 环境变量，而本工程注入的是 `MIO_V_OPEN_ID` / `MIO_CDP_SUPPLIER_ID`，两者**无映射 shim**。因此每次调用必须显式传：

```bash
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" colleague <cmd> [选项]
```

缺则先向用户确认，禁止编造。

## 意图 → 命令

| 用户意图 | xiaoyuan 命令 |
|----------|---------------|
| 看本公司（或指定税号）可搜的类目 | `colleague categories` |
| 按公司名切换展商视角 | `colleague exhibitor-list` |
| 看各国有多少同行 | `colleague country-num` |
| 搜同行企业列表 | `colleague search` |
| 选中同行后看买家交易类目 | `colleague buyer-categories` |
| 选中同行后看这些同行的买家 | `colleague buyers` |

推荐链路：`colleague categories` → 取 `t4TagId` →（可选 `colleague country-num`）→ `colleague search` → 取 `records[].id` → `colleague buyers`。  
看别人家的同行：`colleague exhibitor-list` 取 `taxNumber` → `colleague categories --tax-number`。

精确匹配（`--search-type 1`）无结果时，再试推测匹配（`--search-type 2`）。

## 传参（逗号分隔，不用 JSON 数组）

| 场景 | 写法 | 易踩坑 |
|------|------|--------|
| T4 / 国家 / 同行 id | `t4_xxx` · `t4_a,t4_b` · `123,456` · `US` | 不要写 `"[\"US\"]"` |
| 空值 / 不筛 | **省略该参数** | 不必强传空 |

**重要**：`colleague buyer-categories` / `colleague buyers` 的 `--supplier-ids` 用的是 `colleague search` 返回的 `records[].id`（同行 id），**不是** `supplierId`。

## 可执行命令

全局选项 `--open-id` / `--supplier-id` 必须放在子命令前面。

### 1) 查类目

```bash
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" colleague categories
```

指定税号：`--tax-number "91310000XXXX"`  
只有 1 个类目时可直接用其 `t4TagId`；多个则按用户说的产品名匹配 `t4TagName`，优先 `isMainBusiness=1`。

### 2) 各国同行数（可选）

```bash
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" colleague country-num --t4-tag-ids T4_ID
```

### 3) 搜同行

```bash
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" colleague search \
  --t4-tag-ids T4_ID --country US --page-num 1 --page-size 20
```

可选：`--export-scale 2` `--staff-size 1` `--search-type 2` `--data-source 2` `--province 广东 --city 深圳 --district 南山`

### 4) 按公司名找展商

```bash
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" colleague exhibitor-list --company-name "天晨印务"
```

### 5) 同行买家类目 / 列表

```bash
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" colleague buyer-categories --supplier-ids 123,456 --countries US
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" colleague buyers \
  --supplier-ids 123,456 --countries US --page-num 1 --page-size 20
```

可选：`--is-contact-info 1` `--is-miao 1` `--is-vip 1` `--tag-ids T4_ID` `--sort-type 3`

## 筛选枚举

- **searchType**：1 精确匹配（类目×国家）· 2 推测匹配（AI 推荐）
- **dataSource**：1 Meo 数据库 · 2 AI+Meo
- **exportScale**（近 3 年，美国勿传）：0 &lt;100万 · 1 100~500万 · 2 500~1000万 · 3 1000~2000万 · 4 &gt;2000万 美元
- **staffSize**：0 0-99 · 1 100-500 · 2 500-999 · 3 1000+ 人
- **sortType**（买家）：1 VIP到展 · 2 交易次数 · 3 交易金额（默认）· 4 交易时间降序
- **countries**：US、IN、VN、ID、MX、PL、BR、AE、JP、SA、ZA 等二字码

## 输出与回复

- 命令打印：`path` + `request` + `response`（`success`/`data`/`msg`）。
- `success != true` → 转述 `msg`，不要编造列表。
- 类目读 `t4TagId` / `t4TagName` / `num` / `isMainBusiness`。
- 同行列表读 `response.data.records` / `total`；摘要公司名、省市、主营类目、出口/人员规模。
- 买家列表读 `companyName` / `companyCdpId` / `peerCompanyName` / 交易金额次数；需要触达再走买家 Skill 的 `buyer contacts`（xiaoyuan CLI）。
- **禁止**伪造 id/税号；勿在回复中泄露无关密钥。
