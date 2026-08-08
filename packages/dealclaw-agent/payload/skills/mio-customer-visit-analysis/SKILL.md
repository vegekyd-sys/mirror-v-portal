---
name: "mio-customer-visit-analysis"
description: "分析指定客户的 CRM 拜访记录：Zoho查Account→Events→FeiShu_Meeting_Url→minute_token→转录API→完整转写分析"
---

# 米奥客户拜访分析标准流程

当任何人要求分析某个具体客户的拜访记录时，按以下固定流程执行：

## 步骤

### 1. 在 Zoho CRM 中查找客户 Account
```
使用 ZohoCrmClient.account_search_equals("公司全名") 或精确搜索
fallback: /crm/v2/Accounts/search?criteria=(Account_Name:starts_with:公司名)
```
获取 Account ID。

### 2. 拉取该客户关联的所有 Events（拜访记录）
```
/crm/v2/Accounts/{account_id}/Events?page=1&per_page=200
分页获取直到 more_records=false
```

### 3. 提取 FeiShu_Meeting_Url 字段
对每条 Event，检查 `FeiShu_Meeting_Url` 字段（注意：Zoho 字段名是下划线格式 `FeiShu_Meeting_Url`，不是 `Feishu_Meeting_URL`）。
- 有值 → 继续步骤4
- 无值/null → 该条记录无妙计转写，跳过

### 4. 从妙计链接提取 minute_token
URL 格式：`https://hit5b11g3sf.feishu.cn/minutes/{minute_token}`
取最后一串路径即为 minute_token。

### 5. 调用转录 API 获取完整文字转写
```bash
curl -s POST 'https://zoho.meorient.com/feishu_api/v1/minutes/transcript' \
  -H 'Content-Type: application/json' \
  -d '{"key":"ktjkdffdsa45145657wqertgfdsa","minute_token":"<token>"}'
```
返回：`code=20000` → `data.transcript`（完整文字转写）

### 6. 综合分析输出
基于所有 Event 元数据 + 文字转写，输出：

**客户画像：** Account 基本信息（等级、负责人、地址、联系人）
**逐条拜访分析：**
  - 基本信息表格（销售、部门、状态、目的、类型、打卡状态）
  - 妙计内容摘要（如有转写）
  - 风险标注（打卡异常、地址不一致等）
**综合分析：**
  - 拜访节奏、跟进深度、合规性、联系人连续性、成交进展
  - 风险提示

## 关键字段映射
- `Visiting_Type`：拜访类型（临时拜访/预约拜访/云拜访）
- `Visiting_Purpose`：拜访目的（初访/催订/合同确认等）
- `Visiting_Status`：拜访状态（已拜访/未拜访）
- `Sales_Man`：执行销售
- `Owner`：负责人
- `Who_Id`：客户联系人
- `Sign_In_Status` / `Sign_Back_Status`：打卡状态
- `Visit_Content`：拜访内容标签（如 S2 = AI社媒产品）
- `FeiShu_Meeting_Url`：飞书妙计链接

## 注意事项
- Zoho access token 约1小时过期，使用 `ZohoCrmClient.from_env()` 自动刷新
- 转录 API 的固定 key 不要泄露到外部
- 打卡异常（Sign_In_Status/Sign_Back_Status = 异常）需要特别标注
- 签到地址与客户注册地址不一致时需要提示
- 无 FeiShu_Meeting_Url 的 Event 要标注「无妙计记录」

## 依赖
- `work/mio-api/zoho_crm_client.py`：Zoho CRM 只读客户端
- 转录 API endpoint：`https://zoho.meorient.com/feishu_api/v1/minutes/transcript`
