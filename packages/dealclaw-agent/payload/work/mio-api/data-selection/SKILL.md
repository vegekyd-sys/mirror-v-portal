---
name: "data-selection"
description: "数据圈选CLI — 9命令+50参数+产品搜索SOP+行业编码表"
---
> 作者/发起人: 李钰

# SKILL.md — 米奥兰特数据圈选

## 安装与配置
- CLI: `/usr/local/bin/selection`
- API: `export SELECTION_API=http://121.199.25.223:8080`
- 测试: `selection industries`

## 触发条件
用户提到以下关键词时自动触发:
"圈选"、"展商搜索"、"买家搜索"、"找展商"、"查买家"、"公司画像"、"贸易数据"、"参展历史"、"产品标签"、"行业列表"

## 全部命令

### 展商圈选
```bash
selection industries                                    # 行业列表(14个)
selection search --industry "宠物" --pageSize 20       # 展商搜索(50+参数)
selection cdp --industry "宠物" --max-results 500       # 全量圈选(自动翻页)
selection company --id "税号"                           # 公司画像(并行4接口)
selection trade --company-id "税号"                     # 贸易洞察(并行3接口)
selection exhibitions --company-id "税号"               # 参展历史(并行2接口)
selection products --company-id "税号"                  # 产品标签
```

### 买家搜索
```bash
selection buyers --industry "宠物" --pageSize 20
selection buyers --country "ID" --keywords "fan" --sizeMin 50 --sizeMax 100
selection buyers --category-code "105" --country "US"   # 工业机械美国买家
selection buyer-stats --dimension country               # 国家分布统计
selection buyer-stats --industry "114" --dimension country
```

## 展商搜索参数速查

### 基础
| 参数 | 说明 |
|------|------|
| `--industry` | 行业中文名→自动映射tag_dict |
| `--country` | 展会国中文→ISO自动转(印尼→ID) |
| `--keyword` | 公司名关键词 |
| `--company-products` | 主营产品(搜产品首选) |
| `--prod-desc` | 海关产品关键字 |
| `--hscode` | 海关编码(电饭煲=851660) |
| `--province/--city/--district` | 省/市/区 |

### 布尔筛选
`--is-listed` `--is-export` `--is-laolai` `--has-mobile` `--has-phone` `--has-email`

### 范围筛选
`--exh-cnt-lower/upper` `--trade-cnt-lower/upper` `--cl-year-lower/upper` `--reg-capital-lower/upper` `--export-amount-lower/upper`

## 买家参数
| 参数 | 说明 |
|------|------|
| `--industry` | 行业中文名 |
| `--country` | ISO代码(ID/US/DE/BR) |
| `--category-code` | T1编码(105=工业机械,114=宠物) |
| `--keywords` | 公司名/简介模糊搜索 |
| `--sizeMin/--sizeMax` | 企业规模 |

## 产品搜索策略 SOP（关键）
1. `--company-products "XX"` — 主营产品匹配(最精准)
2. `--prod-desc "XX"` — 海关产品关键字
3. `--hscode "XXXX"` — 海关编码
4. `--keyword "XX"` — 公司名关键词(兜底)
5. 单一参数返回0时，组合省份/国家缩小范围再试
6. 返回结果必须带税号和城市

## 行业编码对照
101=其他 103=孕婴童 104=家电3C 105=工业机械 106=建材 107=泛家居 108=电力能源 109=纺织服装 110=舞台音响 111=软装 112=食品 113=教育 114=宠物 115=服务贸易
