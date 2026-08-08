---
name: "overseas-textile-buyer-search"
description: "海外采购商批量搜索→飞书表格。按国家×行业搜B2B目录，全行业通用"
---

# 海外采购商批量搜索 Skill

> 目标：为指定国家+行业批量搜集海外采购商/进口商信息，输出飞书多Sheet表格。**全行业通用**。

## 触发条件

用户提到以下关键词组合时触发：
- "找采购商" / "找买家" / "买家搜索" / "buyer search" / "海外买家" / "帮我找XX国的"
- 同时包含：国家名 + 行业/产品品类

全行业支持，典型场景：
- 纺织服装（面料/辅料/男装/女装/内衣/鞋子/箱包）
- 机械设备（工业设备/农业机械/工程机械/机床）
- 新能源（电池/光伏/储能/充电桩）
- 消费电子（手机配件/智能家居/可穿戴）
- 汽车零部件（发动机件/底盘/电子件）
- 建材家居（陶瓷/卫浴/家具/灯具）
- 医疗器械（耗材/诊断设备/康复器材）
- 化工原料（塑料/涂料/橡胶/添加剂）

## 核心流程

### 第一步：解析需求

从用户消息中提取：
- **目标国家列表**
- **目标行业/品类**（具体产品关键词）
- **每个国家目标数量**（默认200，可按需调整）

优先用英文关键词搜索（web_search 英文结果更丰富），中文关键词为辅。

### 第二步：多轮搜索数据源

对每个国家 × 行业组合，并行搜索以下层级：

#### 第1层：B2B目录搜索

```
"[国家名] + [行业关键词] + importers / buyers / wholesalers + directory / list"
"[国家名] + [行业关键词] + import companies + contacts"
```

优先数据源：
| 数据源 | 覆盖 |
|--------|------|
| Go4WorldBusiness | 全行业全球买家 |
| Kompass | 全行业企业目录 |
| TradeWheel | B2B买家询盘 |
| Fibre2Fashion | 纺织服装 |
| ATN Info / Yellow Pages | 阿联酋等国 |
| B2Brazil | 巴西 |
| Textile Infomedia | 纺织服装 |
| TradeKey / Alibaba Buyers | 全行业 |

#### 第2层：大牌进口商/零售商搜索

```
"[国家名] + [行业] + major retailers / distributors / importers"
"[国家名] + [行业] + leading brands / companies"
```

#### 第3层：海关数据平台（补充验证）

搜索 "Volza / Trademo / Export Genius + [国家] + [行业]" 获取企业名称线索。

#### 第4层：行业展会参展商

"[国家名] + [行业] + trade fair / exhibition + exhibitor list"

#### 第5层：品类细分搜索

如果首轮不足目标数量，按子品类拆分搜索补充。

### 第三步：编译CSV

```
Company Name,Country,City,Product Category,Phone,Email,Website
```

规则：
- **不虚构数据**：只用实际搜索到的公司名
- **允许空白字段**：联系方式在免费渠道通常不完整
- **城市从目录提取**：无法确定时用首都/经济中心
- **UTF-8 BOM编码**

### 第四步：创建飞书表格

```bash
# 创建工作簿
lark-cli sheets +workbook-create --title "[行业]采购商名录-[国家]" --as user --format json

# 为每个国家创建/重命名 Sheet → "🇦🇪 国名 英文名"
# 写入数据
lark-cli sheets +csv-put --spreadsheet-token <token> --sheet-id <sid> \
  --start-cell A1 --csv @<csv_file> --as user --format json
```

### 第五步：样式与权限

- 表头：深蓝背景 #2F5496 + 白色粗体 + 居中 + 冻结首行
- 列宽自适应
- 权限：设公众可读

### 第六步：交付

- 飞书表格链接
- 每国数量汇总
- 数据来源说明
- 如需更完整联系方式，建议配合海关数据平台

## 使用示例

```
用户: 帮我在阿联酋、沙特、墨西哥各找150个汽车零部件采购商
→ 搜 auto parts importers → 3国并行 → 飞书3 Sheet表格
```

```
用户: 找印尼、越南、印度的光伏储能进口商，每国100个
→ 搜 solar energy/power storage importers → 飞书表格
```

```
用户: 帮我在巴西找200个医疗器械采购商
→ 搜 medical device importers Brazil → 飞书表格
```

## 注意事项

- 免费公开渠道数据量在100-200之间波动
- 联系方式（电话/邮箱）免费渠道普遍不完整
- 可同时给出各国主要B2B平台链接供用户深入挖掘
- 中小国家/冷门行业可能不足100条，如实告知
