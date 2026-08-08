---
name: "s2-win-analysis"
description: "S2赢单分析：CRM全量抽查→多维画像→可复制规律→飞书文档。含OCR纠错、标签交叉验证、Feature_label_Filter扫描"
---

# S2赢单客户分析 Skill

## 触发条件
- 用户提供S2赢单/已成交客户名单（截图或表格）
- 用户要求分析赢单规律、客户画像、销售方向
- 用户说"这批客户为什么能成交""找规律""分析特征"

## 执行流程

### Step 1: 获取客户名单
- 从截图OCR提取公司名，逐字核对防误读（擎/挚、舜/舸、染/梁等形近字）
- 如有多张图以最新为准
- 确认总数

### Step 2: CRM全量抽查
- 使用 `ZohoCrmClient.from_env()` 逐家查询
- 必须提取字段：
  - 基础：Account_Name, Province, Main_Products, Staff_Size, Registered_Capital, Business_Status
  - 关系：Customer_Level, First_Touch_Time, Related_Deals_Amount, VIP, is_win
  - 平台：Official_Website, Company_English_Name
  - 展会：field10（定展年份标签）, Marketing_Activity_Type
  - 标签：Feature_label_Filter（含阿里/中国制造/会刊/海关提单等标签）
  - 分类：field3（简称）, field4（行业数组）
- 导出CSV备用
- API限流：每次查询间隔0.3秒

### Step 3: 多维度分析
#### 3.1 基础验证
- Customer_Level是否全部为"定金老客户"
- is_win是否全部为"是"
- 定展年份分布（field10标签解析）
- 首触时间分布

#### 3.2 行业分析
- field4统计，归并大类（工业机械/纺织服装/建材/家电3C等）
- 找出占比最高的行业

#### 3.3 地域分析
- Province统计
- 城市级分析（从公司名前缀或District/Town字段）

#### 3.4 平台分析（关键）
- Official_Website：官网记录
- Feature_label_Filter中扫描：阿里巴巴、中国制造、环球资源、1688等关键词
- 合并去重计算线上覆盖率
- 会刊（国内/国际展）、海关提单等标签分类

#### 3.5 交易深度分析
- Related_Deals_Amount分层（≥7/3-4/1-2）
- 交叉定展年份分析转化模式

### Step 4: 提炼可复制规律
- 规律1：定展转化模式（同期/次年/长期）
- 规律2：交易数分层策略
- 规律3：城市集中度
- 规律4：行业集中度
- 规律5：线上平台画像（阿里/中国制造持有率）
- 规律6：S2目标客户筛选公式（P0-P3优先级）

### Step 5: 生成文档
- 使用 `lark-cli docs +create --as bot` 创建飞书文档
- 设置公开可读：`drive permission.public patch --yes`
- 结构：核心结论→可复制规律→逐一特征表→后续建议
- 表格按定展年份排序（2026→2027→2026商机→2025→2024→历史→老客）

### Step 6: 复核
- 逐条检查公司名与原始截图一致
- 逐条验证CRM数据与文档表格一致
- 检查所有计数和百分比
- 搜索文档中是否有残留错误词（OCR误读、CRM未查到等）
- 修正后告知用户

## 安全规则
- 仅读CRM，不写CRM
- 文档创建使用 `--as bot`，创建后设公开可读
- 定价、打款金额等敏感信息不写入分析文档
- OCR结果必须交叉验证，特别是形近汉字

## 常见陷阱
- **OCR形近字**：擎/挚、舜/舸、染/梁等，须人工确认
- **Feature_label_Filter是关键数据源**：阿里/中国制造/会刊/海关数据都在此字段，不在独立平台字段
- **文档可能有多张表格**：修改时要检查所有表格
- **Zoho API限流**：连续查询可能触发429，需控制频率
- **计数要包含手动添加的客户**（如挚诚）
