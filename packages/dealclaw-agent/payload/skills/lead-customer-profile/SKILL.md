---
name: "lead-customer-profile"
description: "线索客户画像:批量为主,米奥贸易API逐条查→统一HTML报告,含6图表+排序表"
---

# 线索客户画像报告（Lead Customer Profile Report）

## 定位

**批量模式为主**：输入一批境外买家/公司名（Excel/CSV 或企业名列表），统一出一份 HTML 报告。也支持单品查询。

## 触发条件

- **批次（主要）**：用户上传线索 Excel/CSV，或给出企业名列表 → 逐条查 API → 合并出报告
- **单品**：说"查一下XX公司"

## 数据源

### 第一优先级：米奥兰特贸易数据库 API

**地址**：`POST https://apidiscovery.datathink.com/meorient/openApi/cdp/searchCompanyNameWithTrade.json`
**appKey**: `tradechina`  |  **appSecret**: `2AD93F04C38475F990C85395430AF7BC`

### 签名

```python
message = appKey + str(timestamp_ms) + companyName
sign = hmac.new(appSecret.encode(), message.encode(), hashlib.sha256).hexdigest().upper()
```

### ⚠️ 必须用 curl/subprocess

```python
import hashlib, hmac, json, time, subprocess
company = "公司名"
tm = int(time.time() * 1000)
message = f"tradechina{tm}{company}"
sign = hmac.new("2AD93F04C38475F990C85395430AF7BC".encode(), message.encode(), hashlib.sha256).hexdigest().upper()
body = json.dumps({"appKey":"tradechina","time":tm,"sign":sign,"data":{"companyName":company}})
result = subprocess.run(["curl","-s","-X","POST","https://apidiscovery.datathink.com/meorient/openApi/cdp/searchCompanyNameWithTrade.json","-H","Content-Type: application/json","-d",body], capture_output=True, text=True, timeout=20)
data = json.loads(result.stdout)
```

**Python urllib 不能用**——该 API 网关会丢弃 urllib 发出的 body。

### QPS 上限 = 3
批量查询每请求间隔 ≥ 0.35s。超出会被封禁 appKey。

### 响应关键字段

`data[0].buyerInfo`: company_name, country, website, company_profile, company_profile_cn, company_size, company_revenue, purchase_big_industry_cns（逗号分隔字符串，非 JSON 数组）, buyer_characteristics（积极到展/提单买家/VIP买家等）

`data[0].tradeOverView`: recentYearTradeCount, recentYearTradeMoney, chinaTradeMoney, datathinkUrl

### 匹配判断

✅ 命中 / ⚠️ 部分匹配 / ❌ 未命中（转公开搜索）

### 第二优先级：公开搜索

web_search + x_search 补充公司信息

## 批次模式（主流程）

1. 接收 Excel/CSV 或企业名列表
2. 逐条调用 API（间隔 0.35s）
3. 逐个判断匹配结果
4. API 未命中的转公开搜索补位
5. 统一生成一份 HTML 报告

## 批次报告结构

### 6 个图表（CSS-only）
1. 国家/地区分布（柱状图）
2. 线索质量分布（环形图：高/中/低）
3. 联系人部门分布（柱状图：C-Level/采购/运营/其他）
4. 采购意向行业分类（柱状图）
5. API 匹配状态（环形图：命中/部分/未命中/跳过）
6. 提交时间分布（柱状图）

### 线索质量排序表
排序 | 评级 | 公司名(含API匹配) | 联系人 | 部门 | 国家 | 岗位 | 采购意向 | 价值点 | 建议动作

### 质量评分
- **高**：真实企业名 + 决策者身份 + 意向明确 + 联系方式完整
- **中**：真实姓名+邮箱，意向模糊但信息可验证
- **低**：纯数字/单词填充、同值、机器人行为

## HTML 设计

- 深色商务看板风格
- 字体：DM Serif Display + DM Sans + JetBrains Mono
- 图表：纯 CSS（柱状图、环形图）
- 支持打印

## 安全

- API 凭证不写入文件
- 报告不包含个人隐私
