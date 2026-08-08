---
name: "xingqing-s2-data-analysis"
description: "S2定金老客户数据画像：CRM/圈选API多源合并→口径对齐→分布统计→圈选规则反推→飞书文档输出"
---

# S2 定金老客户数据分析 Skill

## 触发场景

1. Bright/郑总/子璇要求分析 S2 客户数据（CRM 导出 + 圈选平台）
2. 需要对定金老客户做赢单复盘、画像提取、圈选规则推导
3. 需要补标客户属性（会刊记录、定展年份、阿里交集等）
4. 需要从样本数据反推数据圈选平台的筛选规则

## 核心分析文档

S2 中东阿里巴巴交集客户分析文档
链接：https://versa-ai.feishu.cn/docx/CLGCdNGqyoyX9HxTotdcNdE2nOh

## 分析流程

### 第一步：数据获取与清洗
- 从 CRM/Zoho 导出客户数据（Accounts/Deals/Sales_Orders/Contacts）
- 从数据圈选平台 API 获取补充数据（工商/贸易/参展/产品标签）
- 从阿里巴巴/会刊等渠道获取额外交集数据
- 合并多源数据，去重，统一字段命名

### 第二步：口径定义与对齐
- 明确分析口径（如：样本范围=Customer_Level=定金老客户，不代表全部S2赢单）
- 关键字段口径对齐：field10（定展年份）、会刊-国际展/国内展、Feature_label_Filter
- 区分"已定展"和"商机"两种记录类型，避免混算
- 所有口径需与 Bright/郑总确认后固化

### 第三步：画像与分布统计
- 按国家/区域/行业/公司规模等维度统计客户分布
- 提取高价值客户的共同特征
- 计算各项指标覆盖率（官网率、B2B平台率、会刊记录率等）
- 识别异常值和数据缺口

### 第四步：圈选规则反推
- 从定金老客户特征反推数据圈选平台的筛选条件
- 输出可操作的圈选规则（行业/区域/规模/线上资产/参展历史等维度）
- 标注每条规则的信度和覆盖范围
- 按优先级排列圈选规则（先圈确定性高的，再扩展）

### 第五步：输出与更新
- 分析结论写入飞书文档
- 圈选规则同步到任务房和销售团队
- 标注数据来源、样本量、置信度和局限性
- 更新项目 memory（memory/projects/xingqing/main.md）

## 关键约束

1. **口径先说后算**：每个统计数字之前，先明确口径定义
2. **样本不越界**：当前样本仅代表"定金老客户"子集，不推至全体S2客户
3. **字段验证**：CRM 字段值（如 field10）以实际读取为准，不凭前文记忆
4. **补标透明**：会刊/定展等补标字段需注明来源和补标方法
5. **质量反馈保留**：文档中保留关键标识符以便追溯（如 record_id、message_id）
6. **不覆盖原文**：除非 Bright 明确确认，否则创建独立分析文档而非覆盖原 Wiki

## 相关资源

- Zoho CRM API 只读 client：work/mio-api/zoho_crm_client.py
- 数据圈选平台 API client：work/mio-api/miao_data_selection_client.py
- 字段映射 playbook：work/mio-api/field_mapping_business_playbook_2026-06-26.md
- CRM 数据字典：Zoho系统重点模块数据字典（飞书文档）
- 项目记忆：memory/projects/xingqing/main.md
- Task room：V｜米奥数据圈选平台｜0626
