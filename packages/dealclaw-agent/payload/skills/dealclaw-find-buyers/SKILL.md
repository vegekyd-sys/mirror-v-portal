---
name: "dealclaw-find-buyers"
description: "v2: 默认搜索字段从 keyword 切换到 tag-keyword，增加 company-attributes 买家类型过滤"
---

# DC-Find-Buyers

## 核心规则

先找买家公司，再找联系人或解锁邮箱。

用户确认买家方向或选定具体公司后，才搜索联系人。用户确认消耗 Apollo 额度后，才执行邮箱 reveal。

## 必要输入

### 用户上传已有买家表格（Excel/CSV）

用户发送 `.csv` / `.xlsx` 文件 → V 调用 `dc_customer_import.py` 解析 → 校验必填字段（公司名/域名/国家）→ 直接写入线索池 bitable → 来源标注「用户导入」→ 气泡确认：「导入了 X 家买家，已写入线索池」+ 发 bitable 链接。

### 搜索新买家

执行公司搜索前，必须确认三项信息：

- 目标国家：国家名或 ISO 码。传给搜索脚本前统一转成大写 ISO 码，例如 `AE`，不要传 `ae`。
- 买家类型：制造商、经销商、品牌商、零售商、平台、项目采购方，或不限。
- 产品/品类：用户要找的产品、品类或行业词。**默认走 `--tag-keyword`（采购品类标签匹配），只有用户明确说搜公司/品牌名时才用 `--keyword`。**

如果缺少任意一项，只问一个简短追问。默认输出 Top 10 买家公司。

## 执行流程

1. 确认搜索参数。
2. 按正确字段建立公司候选池。
3. 执行去重，并移除已确认排除偏好。
4. 检查关键词歧义和买家类型匹配度。
5. 输出 Top 5–10 公司及推荐理由。
6. 用户确认公司或方向后，再搜索联系人。
7. Apollo 邮箱 reveal 前，先让用户确认额度消耗。

## 数据源路由

按以下规则寻找公司：

- 展会国 `MX/BR/ZA/VN/ID/AE/SA/IN/PL/JP/DE/TR/EG`：优先使用 CDP `searchAIV2`。
- 非展会国：优先使用 Apollo `--companies` 关键词碰撞搜索。
- Apollo 联系人搜索只在用户确认公司或方向后使用。
- web search 用于结果补足、歧义判断、公司验证和联系人全名验证。

没有实际调用的数据源，不要说已经执行。必要数据源返回 0 条时，简短说明，并继续走下一个允许步骤。

## CDP 搜索字段规则（v2 — 2026-08-07 更新）

**默认搜索字段为 `--tag-keyword`**，匹配采购品类标签（英文），最贴近真实采购行为。

| 搜索意图 | 字段 | 说明 |
|---------|------|------|
| 产品/品类词（如 water pump, vacuum flask） | `--tag-keyword` | **默认首选**。匹配采购品类英文标签，层级越深越精准 |
| 产品/品类词（兜底） | `--profile-keyword` | 匹配公司简介，tag-keyword 召回不足时尝试 |
| 公司/品牌名（如 Stanley, Shimizu） | `--keyword` | **仅限用户明确要搜某个公司名/品牌时使用** |

**买家类型过滤新增 `--company-attributes`：**

```bash
# 编码对照
1=制造商  2=分销商  3=零售商  4=电商  5=代理商
6=物流    7=媒体    8=咨询    9=大型商超

# 找经销商/分销商
--company-attributes 2,5
# 找经销商+零售商+大型商超（排除制造商）
--company-attributes 2,3,5,9
```

正确示例：

```bash
# ✅ 产品品类词 → --tag-keyword（默认首选）
python3 dealclaw_search.py --tag-keyword "water pump" --country ID --size 10 --enterprise "<enterprise>" --user "<open_id>"

# ✅ 限定买家类型为分销商
python3 dealclaw_search.py --tag-keyword "water pump" --country ID --company-attributes 2,5 --size 10

# ✅ 兜底：tag-keyword 召回不足时用 profile-keyword
python3 dealclaw_search.py --profile-keyword "water pump" --country ID --size 10

# ✅ 公司名搜索（仅限用户明确要搜某公司）
python3 dealclaw_search.py --keyword "Shimizu" --country ID --size 5
```

错误示例：

```bash
# ❌ 产品品类词放进 --keyword，只能匹配公司名，搜不到或全是噪声
python3 dealclaw_search.py --keyword "water pump" --country ID --size 10

# ❌ 多产品词堆在一次调用里——OR 逻辑只会累加噪声
python3 dealclaw_search.py --tag-keyword "drinkware bottle flask tumbler" --country AE --size 10

# ❌ tag-keyword 传中文——接口只认英文标签，中文返回 0 条
python3 dealclaw_search.py --tag-keyword "水泵" --country ID --size 10
```

## Apollo 关键词碰撞

非展会国搜索时，生成 3×3 关键词矩阵：

- 产品词：用户原词、品类泛称、行业术语。
- 渠道词：用户指定买家类型、行业分销词、零售/渠道词。

逐个用 Apollo `--companies` 搜索产品词和渠道词组合，合并结果，去重，最多保留 20 个内部公司候选。默认只向用户展示最优 5 个。

Apollo `--companies`、联系人搜索和 reveal 共用额度或 API key。3×3 矩阵最多会产生 9 次公司搜索，结果够用时不要继续扩词。

## 内部评分

内部评分只用于排序，不向用户展示分数。

基础权重：

- 行业/产品匹配度：30%。
- 买家类型匹配度：20%。
- 采购可能性：20%。
- 渠道价值和客单价潜力：15%。
- 触达可行性：10%。
- 风险和准入难度：5%。

评分依据优先级：

- 公司简介、官网品类、产品目录、进口/采购信号。
- 目标国家和买家类型是否匹配。
- 联系人、职位、公开业务动态。
- 数据不足时标注 `[待验证]`，不要自由脑补。

把判断转成简洁的业务化推荐理由，不输出维度分和计算过程。

## 去重规则

展示结果前必须去重。去重键为标准化公司名加官网域名。

如果使用 `dealclaw_search.py`，必须带上 `--enterprise` 和 `--user`，否则企业/用户级去重可能不会执行。

去重失败或无法确认去重状态时，明确标注 `[去重待验证]`，不要承诺"已去重"。

## 歧义处理

如果搜索词或结果存在多义，先暂停并让用户选择方向。

示例：

- `coupling`：管件联轴器 vs 情侣产品。
- `pump`：工业泵 vs 美妆泵头瓶。
- `insulation`：保温建材 vs 保温杯/保温容器语义误伤。
- `brand`：品牌方 vs 品牌营销公司。

用户确认排除方向后，用 `dc_ls_store.py exclude` 持久化到当前企业偏好。

## 输出格式

默认使用聊天气泡，不使用卡片。

5 条以内买家，按以下格式逐条输出：

`1. 公司名` - `[官网域名](https://domain.com)`

关键信号：一句话。

推荐理由：一句话。

建议下一步：一句话。

超过 5 条买家，或用户要求查询全部线索库时，输出简短气泡总结 + 飞书多维表格链接。

## 线索池统一格式（v4）

所有来源的线索统一写入同一份飞书多维表格，列结构：

| 列 | 类型 | 说明 |
|------|------|------|
| 公司名 | 文本 | — |
| 官网 | 链接 | 可点击跳转 |
| 国家 | 文本 | 🇬🇧🇧🇷等国旗emoji |
| 买家类型 | 单选 | 品牌商/制造商/经销商/工程商 |
| 匹配产品 | 多选 | 硼硅灯罩/吹制定制/压制玻璃/光学平板/钢化面板 |
| 推荐理由 | 文本 | 标签+判断合一，≤30字 |
| 联系人 | 文本 | `姓名 \| 职位 \| 邮箱`，多人换行。待Apollo解锁标「待Apollo解锁」 |
| 来源 | 单选 | 引擎搜索/星擎线索/猎采线索/米奥数据库/Apollo数据库/展会线索/用户导入 |
| 冷热 | 单选 | 🔥热/❄️冷 |
| 阶段 | 单选 | 待触达/已触达/已回复/报价中/成交/停止触达 |

搜索、星擎、猎采、展会所有来源统一入此表，来源列区分，用户自行筛选。

用户标注结果好坏后，如果 `dc-review` 可用，则写入决策历史并更新偏好计数。同一排除维度被标记 3 次负向后，建议晋升为排除规则；没有可用工具时，不要声称已写入。

## 联系人与邮箱解锁

联系人搜索和邮箱解锁独立于公司发现流程。

1. 用 Apollo 搜索联系人：`--sourcing`、`--brand` 或 `--contacts`。
2. 如果 Apollo 返回 `has_email=True` 且姓名被混淆，用公司、职位、名和混淆姓氏通过 web search 验证完整姓名。
3. Apollo 邮箱 reveal 前，先让用户确认是否消耗额度。
4. 用户确认后，用已验证完整姓名执行 `--reveal`。

重要规则：

- `has_email=True` 且 `email=—` 表示邮箱可能可解锁，不代表没有邮箱。
- `has_email=True` 不保证 reveal 一定成功。失败时说明具体原因，例如缺少完整姓名、Apollo 额度不足、API 错误或未找到 verified email。
- 不为用户未确认的公司解锁邮箱。

## CLI 参考

```bash
# CDP 产品品类搜索（默认首选）：tag-keyword + 分销商过滤
cd work/mio-api
python3 dealclaw_search.py --tag-keyword "water pump" --country ID --company-attributes 2,5 --size 10 --enterprise "<enterprise>" --user "<open_id>"

# CDP 产品品类搜索（兜底）：profile-keyword
python3 dealclaw_search.py --profile-keyword "vacuum flask" --country AE --size 10 --enterprise "<enterprise>" --user "<open_id>"

# CDP 公司名搜索：只有用户明确搜公司/品牌名时才用 keyword
python3 dealclaw_search.py --keyword "Stanley" --country AE --size 5

# Apollo 公司搜索：非展会国。
python3 apollo_client.py --companies "smart glasses" --country US --employees "51,200" --size 10

# Apollo 联系人搜索。
python3 apollo_client.py <domain> --sourcing
python3 apollo_client.py <domain> --brand
python3 apollo_client.py <domain> --contacts

# Apollo 邮箱 reveal：完成全名验证并获得用户确认后执行。
python3 apollo_client.py <domain> --reveal "FirstName LastName"

# 持久化排除偏好。
python3 dc_ls_store.py exclude <enterprise> <open_id> --keywords "..." --industries "..." --reason "..."
```

## 边界

- 不脑补缺失的国家、买家类型或产品/品类词。
- 未经用户确认，不搜索联系人，不调用 Apollo 邮箱 reveal。
- 不使用未授权付费源或私有 CRM 联系方式。Apollo reveal 仅在已配置且用户确认后允许使用。
- 不推荐自产自用型公司，除非它对用户产品有明确渠道采购可能。
- 不确定的信息标注 `[待验证]`。
- 未实际执行去重时，不承诺已去重。
- CDP 只覆盖上文列出的展会国；名单如脚本已有常量，以脚本为准。
- Apollo 公司搜索依赖标签覆盖，可能漏掉冷门或细分公司。
- web search 用于验证和补足，不保证完整覆盖。
- 去重使用公司名加官网域名；同集团不同子公司仍可能需要人工复核。
