---
name: dealclaw-peer-search
description: >-
  搜同行 Skill：查类目、按类目/国家搜同行企业、看各国同行数、查同行买家。
  运行本目录 scripts/*.py 调用 blade-agent-adapter /agent/colleague/*。
  用于「搜同行/找同类展商/同行企业/同行买家/竞品展商」等意图。
metadata:
  openclaw:
    requires:
      anyBins: [python, python3]
    emoji: "🏢"
---

# 小元-搜同行（可执行）

对应慧展 `/aiSearch/colleague`。
**必须用 `exec`/`bash` 跑下方脚本**，以 stdout JSON 为事实再回复；不要只读文档假装已调用。

接口源：`AgentColleagueSearchController` → `/agent/colleague/*`
默认 Base URL：`https://micro.tradechina.com/blade-agent-adapter`（`--base-url` 或 `MEO_ADAPTER_BASE_URL`）

## 安装

将目录 `dealclaw-peer-search/` 拷到 OpenClaw skills 根目录后重载。`{baseDir}` = 本 Skill 目录。

## 身份（默认从环境变量取）

脚本会自动从 `.env` 读取以下环境变量，通常无需手动传：

| 参数 | Header | 环境变量 |
|------|--------|----------|
| `--open-id` | `X-Feishu-Open-Id` | `MIO_V_OPEN_ID` |
| `--supplier-id` | `X-Supplier-Id` | `MIO_CDP_SUPPLIER_ID` |

环境变量未配置时才需手动传 `--open-id` / `--supplier-id`；缺则先向用户确认，禁止编造。

工作目录：先 `cd {baseDir}/scripts`，再执行 `python ...`。

## 意图 → 脚本

| 用户意图 | 脚本 |
|----------|------|
| 看本公司（或指定税号）可搜的类目 | `get_category_list.py` |
| 按公司名切换展商视角 | `get_supplier_exhibitor_list.py` |
| 看各国有多少同行 | `get_country_num.py` |
| 搜同行企业列表 | `search_list.py` |
| 选中同行后看买家交易类目 | `get_buyer_category_list.py` |
| 选中同行后看这些同行的买家 | `search_buyer_list.py` |

推荐链路：`get_category_list` → 取 `t4TagId` →（可选 `get_country_num`）→ `search_list` → 取 `records[].id` → `search_buyer_list`。
看别人家的同行：`get_supplier_exhibitor_list` 取 `taxNumber` → `get_category_list --tax-number`。

精确匹配（`--search-type 1`）无结果时，再试推测匹配（`--search-type 2`）。

## `*-json` 传参（尤其 Windows）

数组参数名带 `-json`，但**不必**写成带转义引号的 JSON。

| 场景 | 推荐写法 | 易踩坑 |
|------|----------|--------|
| T4 / 国家 / 展会 | `t4_xxx` · `t4_a,t4_b` · `US` | `"[\"US\"]"`（PowerShell 常把引号吃掉） |
| 同行 id | `123` 或 `123,456` | 不要写成 `"[\"123\"]"` |
| 空数组 | **省略该参数** | 不必强传 `"[]"` |

**重要**：`search_buyer_list` / `get_buyer_category_list` 的 `--supplier-ids-json` 用的是 `searchList.records[].id`（同行 id），**不是** `supplierId`。

## 可执行命令

替换 `OPEN_ID` / `SUPPLIER_ID`。

### 1) 查类目

```bash
cd {baseDir}/scripts
python get_category_list.py --open-id "OPEN_ID" --supplier-id "SUPPLIER_ID"
```

指定税号：`--tax-number "91310000XXXX"`
只有 1 个类目时可直接用其 `t4TagId`；多个则按用户说的产品名匹配 `t4TagName`，优先 `isMainBusiness=1`。

### 2) 各国同行数（可选）

```bash
python get_country_num.py --open-id "OPEN_ID" --supplier-id "SUPPLIER_ID" --t4-tag-ids-json T4_ID
```

### 3) 搜同行

```bash
python search_list.py --open-id "OPEN_ID" --supplier-id "SUPPLIER_ID" --t4-tag-ids-json T4_ID --country US --page-num 1 --page-size 20
```

可选：`--export-scale 2` `--staff-size 1` `--search-type 1` `--province 广东 --city 深圳 --district 南山`

### 4) 按公司名找展商

```bash
python get_supplier_exhibitor_list.py --open-id "OPEN_ID" --supplier-id "SUPPLIER_ID" --company-name "天晨印务"
```

### 5) 同行买家类目 / 列表

```bash
python get_buyer_category_list.py --open-id "OPEN_ID" --supplier-id "SUPPLIER_ID" --supplier-ids-json 123,456 --countries-json US
python search_buyer_list.py --open-id "OPEN_ID" --supplier-id "SUPPLIER_ID" --supplier-ids-json 123,456 --countries-json US --page-num 1 --page-size 20
```

可选：`--is-contact-info 1` `--is-miao 1` `--is-vip 1` `--tag-ids-json T4_ID` `--sort-type 3`

## 筛选枚举

- **searchType**：1 精确匹配（类目×国家）· 2 推测匹配（AI 推荐）
- **dataSource**：1 Meo 数据库 · 2 AI+Meo
- **exportScale**（近 3 年，美国勿传）：0 &lt;100万 · 1 100~500万 · 2 500~1000万 · 3 1000~2000万 · 4 &gt;2000万 美元
- **staffSize**：0 0-99 · 1 100-500 · 2 500-999 · 3 1000+ 人
- **sortType**（买家）：1 VIP到展 · 2 交易次数 · 3 交易金额（默认）· 4 交易时间降序
- **countries**：US、IN、VN、ID、MX、PL、BR、AE、JP、SA、ZA 等二字码

## 输出与回复

- 脚本打印：`tool` + `request` + `response`（`R`：`success`/`data`/`msg`）。
- `success != true` → 转述 `msg`，不要编造列表。
- 类目读 `t4TagId` / `t4TagName` / `num` / `isMainBusiness`。
- 同行列表读 `response.data.records` / `total`；摘要公司名、省市、主营类目、出口/人员规模。
- 买家列表读 `companyName` / `companyCdpId` / `peerCompanyName` / 交易金额次数；需要触达再走买家 Skill 的 `get_cdp_contact.py`。
- **禁止**伪造 id/税号；勿在回复中泄露无关密钥。

## 依赖

Python 3 标准库即可，无需 pip。
