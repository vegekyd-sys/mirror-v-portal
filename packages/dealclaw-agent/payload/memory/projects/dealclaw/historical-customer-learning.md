# DealClaw · 历史客户学习引擎

> Phase 1 设计文档 | 2026-07-25 | 田耕郡

## 一、目标

导入企业的历史成交客户数据 → 自动抽取标签 → 在后续买家搜索时用标签重排序结果 → 越搜越准。

## 二、数据格式

### 导入 CSV

```csv
company_name,domain,country,product,deal_type,deal_date
EcoSolar GmbH,ecosolar.de,DE,Solar microinverter 400W,分销商,2025-03-15
SunPower NL,sunpower.nl,NL,Solar microinverter 800W,安装商,2025-06-01
Vienna Solar Solutions,vienna-solar.at,AT,Solar microinverter 2000W,系统集成商,2025-04-10
```

| 字段 | 必填 | 说明 |
|------|:---:|------|
| company_name | ✅ | 公司名 |
| domain | ✅ | 域名（去重键） |
| country | ✅ | ISO 国家码 |
| product | — | 成交产品/品类 |
| deal_type | — | 买家类型（分销商/安装商/OEM/终端） |
| deal_date | — | 成交日期 |

### 存储格式

```json
// data/customer_tags/{enterprise}.json
{
  "imported_at": "2026-07-25T10:00:00Z",
  "customer_count": 30,
  "tags": {
    "country": {"DE": 0.45, "NL": 0.25, "AT": 0.15, "AU": 0.10, "BR": 0.05},
    "keywords": {"microinverter": 28, "solar": 25, "photovoltaic": 18, "mppt": 12, "grid-tied": 8},
    "buyer_type": {"分销商": 0.40, "安装商": 0.35, "系统集成商": 0.20, "OEM": 0.05},
    "product_pattern": {"400W": 10, "800W": 8, "2000W": 6, "600W": 4, "2200W": 2}
  },
  "customers": [
    {"company": "EcoSolar GmbH", "domain": "ecosolar.de", "country": "DE", 
     "product": "Solar microinverter 400W", "deal_type": "分销商", "deal_date": "2025-03-15"},
    ...
  ]
}
```

## 三、标签提取引擎

### 三层标签

| 层级 | 来源 | 提取方式 | 用于 |
|:---:|------|------|------|
| L1 地域 | country 字段 | 频率统计 | CDP 搜索优先推高频国家 |
| L2 关键词 | product + company_name | 分词 + 词频 + 去停用词 | 搜索关键词自动加权 |
| L3 买家类型 | deal_type 字段 | 频率统计 | 结果重排序加分 |
| L4 产品偏好 | product 字段 | 功率/规格模式提取 | 同类产品买家优先 |

### 提取逻辑

```python
def extract_tags(customers):
    tags = {"country": {}, "keywords": {}, "buyer_type": {}, "product_pattern": {}}
    total = len(customers)
    
    for c in customers:
        # L1: 国家
        tags["country"][c["country"]] = tags["country"].get(c["country"], 0) + 1
        
        # L2: 从产品名和公司名中提取关键词
        text = f"{c.get('product','')} {c.get('company_name','')}".lower()
        words = extract_keywords(text)  # 去停用词、字母数字混合、技术术语
        for w in words:
            tags["keywords"][w] = tags["keywords"].get(w, 0) + 1
        
        # L3: 买家类型
        if c.get("deal_type"):
            tags["buyer_type"][c["deal_type"]] = tags["buyer_type"].get(c["deal_type"], 0) + 1
        
        # L4: 产品模式（功率、规格号）
        patterns = extract_product_patterns(c.get("product", ""))
        for p in patterns:
            tags["product_pattern"][p] = tags["product_pattern"].get(p, 0) + 1
    
    # 归一化为权重
    for key in tags:
        tags[key] = {k: v/total for k, v in sorted(tags[key].items(), key=lambda x: -x[1])[:20]}
    
    return tags
```

## 四、搜索重排序

### 流程

```
用户搜索 "solar microinverter distributor germany"
    ↓
CDP 搜索 → 返回 200 条原始结果
    ↓
【重排序层】每条结果 vs 历史客户标签 → 综合相似度分
    ↓
返回 Top 20（按相似度降序）
```

### 评分公式

```
sim_score = 
    country_weight × 0.30      # L1: 买家国家在历史成交国中的权重
  + keyword_match × 0.40       # L2: 买家业务描述与历史关键词的重叠度
  + buyer_type_match × 0.15    # L3: 买家类型匹配
  + product_match × 0.15       # L4: 产品规格匹配

exploration_bonus = 0.05       # 保留 5% 探索空间
                                # 买家不在任何历史标签中 → 仍然给基础分
final_score = sim_score * 0.95 + exploration_bonus * 0.05
```

### 为什么不是 100% 精确匹配

保留 5% 探索空间防止"过拟合"——系统不能只推和过去一模一样的买家。DealClaw 的价值之一是帮企业发现新市场。

## 五、集成点

```
dc_customer_import.py  ← CSV 导入 + 标签提取引擎
          ↓
          ↓
dealclaw_search.py  ← 搜索后读取标签，重排序
          ↓
dc_ls_store.py  ← 标注反馈 → 更新偏好（已有链）
```

现有偏好学习（preferences.json）和新标签系统并行运行，不互相覆盖：
- `customer_tags` = 批量导入的历史模式（"过去是什么样的买家"）
- `preferences` = 实时操作中的偏好（"你现在喜欢/不喜欢什么"）

## 六、落地清单

| # | 文件 | 内容 |
|:---:|------|------|
| 1 | `dc_customer_import.py` | CSV 解析 + 去重 + 校验 + 标签提取 + 存储 |
| 3 | `dealclaw_search.py` 修改 | 搜索结果重排序集成 + `--tags` 开关 |
| 4 | `dc_morning_report.py` 扩展 | 早报里加一行"标签系统就绪"状态 |
