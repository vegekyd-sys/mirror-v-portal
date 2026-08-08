---
name: "mio-zoho-minutes-transcript"
description: "奥创：从Zoho CRM会议模块获取飞书妙记链接，调用转录API获取完整文字转写"
---

# mio-zoho-minutes-transcript

## 触发条件
- 需要从 Zoho CRM 会议模块获取拜访记录的飞书妙记文字转录
- 需要按客户、销售、时间范围批量拉取会议转写
- 米奥/奥创项目中的「妙记原文获取」步骤

## 前置条件
- Zoho CRM 环境变量已配置（`ZOHO_CRM_REFRESH_TOKEN`、`ZOHO_CRM_CLIENT_ID`、`ZOHO_CRM_CLIENT_SECRET`、`ZOHO_ACCOUNTS_URL`）
- `work/mio-api/zoho_crm_client.py` 可用，或直接按本文 OAuth 流程调用
- 妙记转录 API endpoint：`POST https://zoho.meorient.com/feishu_api/v1/minutes/transcript`

## 重要认证规则：access token 约 1 小时过期
- Zoho `access_token` 只能短期使用，约 1 小时过期。
- 每次开始一个新任务时，优先用 `refresh_token` 换取新的 `access_token`，不要复用上一轮缓存 token。
- 如果 CRM 请求返回 401、`拒绝访问`、`INVALID_TOKEN` 或类似鉴权错误：立即刷新 access token 后重试一次。
- 不要把 refresh token、client secret、access token 打印到群聊、日志或报告中。

### 获取新 access token
```python
import os, requests
accounts = (os.getenv('ZOHO_ACCOUNTS_URL') or 'https://accounts.zoho.com.cn').rstrip('/')
resp = requests.post(accounts + '/oauth/v2/token', data={
    'refresh_token': os.getenv('ZOHO_CRM_REFRESH_TOKEN') or os.getenv('ZOHO_REFRESH_TOKEN'),
    'client_id': os.getenv('ZOHO_CRM_CLIENT_ID'),
    'client_secret': os.getenv('ZOHO_CRM_CLIENT_SECRET'),
    'grant_type': 'refresh_token',
}, timeout=20)
data = resp.json()
access_token = data['access_token']
api_domain = data.get('api_domain', 'https://www.zohoapis.com.cn')
```

## 核心流程

### Step 1: 理解需求，确定查询维度
用户可能按以下维度查询：
- 按客户（公司名称 → 查 Account → 查 What_Id 关联的 Events）
- 按销售/负责人（Owner 字段）
- 按时间范围（Start_DateTime）
- 按拜访类型（Visiting_Type）

### Step 2: 查 Zoho CRM Events
每次查询前先刷新 access token。

```python
headers = {'Authorization': 'Zoho-oauthtoken ' + access_token}
# 按客户名查 Events
requests.get(
    api_domain.rstrip('/') + '/crm/v2/Events/search',
    headers=headers,
    params={'criteria': '(Company_Name:equals:佛山市联诚家具有限公司)', 'per_page': 20},
    timeout=30,
)
```

### Step 3: 提取妙记 token
Zoho Events 的 `FeiShu_Meeting_Url` 字段格式：
`https://hit5b11g3sf.feishu.cn/minutes/{minute_token}`

从 URL 中提取最后一串字符即为 `minute_token`：
```python
url = record.get('FeiShu_Meeting_Url', '')
minute_token = url.rstrip('/').split('/')[-1] if url and url != 'None' else None
```

### Step 4: 调用妙记转录 API
```bash
curl -s --location --request POST 'https://zoho.meorient.com/feishu_api/v1/minutes/transcript' \
  --header 'Content-Type: application/json' \
  --data-raw '{"key":"ktjkdffdsa45145657wqertgfdsa","minute_token":"<token>"}'
```

API 固定 key：`ktjkdffdsa45145657wqertgfdsa`

### Step 5: 解析返回
```json
{
  "code": 20000,
  "data": {
    "minute_token": "...",
    "transcript": "2026-06-30 15:42:33 CST|26分钟 41秒\n\n关键词:\n...",
    "line_count": 95,
    "byte_size": 14435,
    "source_format": "txt"
  }
}
```

转录格式：
- 首行：时间戳|时长
- 关键词行
- 后续：`说话人 HH:MM:SS.mmm` + 说话内容

## 关键字段
| 字段标签 | API 名 | 类型 |
|---------|--------|------|
| 飞书妙计连接 | FeiShu_Meeting_Url | URL |
| 会议标题 | Event_Title | 单行 |
| 公司名称 | Company_Name | 单行 |
| 拜访类型 | Visiting_Type | 单行 |
| 拜访状态 | Visiting_Status | 单行 |
| 拜访目的 | Visiting_Purpose | 单行 |
| 负责人 | Owner | 查找 |
| 开始时间 | Start_DateTime | 日期时间 |
| 关联客户 | What_Id | 查找(Accounts) |
| 关联联系人 | Who_Id | 查找(Contacts) |

## 故障处理
- CRM 记录 `FeiShu_Meeting_Url` 为 null → 跳过该条，统计空值率
- 妙记 API 返回非 20000 → 检查 `minute_token` 是否有效、key 是否正确
- Zoho access token 报错/拒绝访问 → 先刷新 access token，再重试一次；不要直接判断 refresh token 失效
- refresh 获取 access token 失败 → 检查 `ZOHO_ACCOUNTS_URL` 是否使用中国区 `https://accounts.zoho.com.cn`，以及 refresh token/client id/client secret 是否完整
- 批量量大时 → 控制并发，逐条调用转录 API（单条 ~1-3 秒）

## 验证方法
1. 选一个已知有妙记链接的客户（如「佛山市联诚家具有限公司」或「佛山史莱克建材有限公司」）
2. 先刷新 access token
3. 跑通 Events → FeiShu_Meeting_Url → minute_token → transcript 全链路
4. 确认返回 `code: 20000` 且 transcript 非空
5. 检查转录内容格式完整（时间戳、关键词、说话人分段）
