# 线索展示卡设计

> 创建: 2026-07-03 | Owner: 格格
> 触发: 用户说"帮我获取n条线索"

## 卡片规格

### 必需字段

| 字段 | 说明 |
|------|------|
| 企业名称 | 公司名 |
| 国家 | 🇺🇸 emoji + 国家名 |
| 来源 | 公网搜索 / 米奥数据库 / 星擎线索 / 展会现场 / 海关数据 |

### 卡片模板

```
┌─────────────────────────────────────┐
│ PT Indo Packaging Sejahtera         │  ← 标题（企业名称）
│ 🔗 indopack.co.id                   │  ← 可点击官网
│ 🇮🇩 印尼 · 公网搜索                  │  ← 国家 + 来源
│ 包装耗材 · 进口分销商 · BOPP胶带     │  ← CBIE 标签（3-5个）
│ ─────────────────────────────────── │
│ [✅ 我的]  [❌ 不是]  [📋 已有]      │  ← 三按钮横排 (column_set)
└─────────────────────────────────────┘
```

**卡片字段**：
- 标题：企业名称
- 可点击URL：markdown 链接格式 `[domain](https://...)`
- 国家 + 来源：一行，emoji 国旗
- CBIE 标签：3-5个粗体关键词，来自企业画像/买家画像匹配结果（产品类型·企业类型·行业·市场区域等）
- 三按钮横排：column_set + column + 按钮，width:fill

**技术实现**：
- 格式：Feishu Cards v2 JSON（`schema:"2.0"`, `config.width_mode:"compact"`）
- 发送：`lark-cli im +messages-send --chat-id <id> --msg-type interactive --content "<json>"`
- 按钮横排：`column_set` + `column` (weighted, weight=1) + `button` (width=fill)
- 回调值：保持平铺 `{"a":"lead:good:Company Name"}`，避免嵌套对象

### 按钮行为

| 按钮 | 动作 | 存储 |
|------|------|------|
| ✅ 是我的买家 | 标记为有效买家，加入跟进队列 | `memory/projects/mio/dealclaw/leads/{user_id}-qualified.md` |
| ❌ 不是我的买家 | 标记为不匹配，记录排除原因 | `memory/projects/mio/dealclaw/leads/{user_id}-rejected.md` |
| 📋 已有买家 | 标记为已有，避免重复推荐 | `memory/projects/mio/dealclaw/leads/{user_id}-existing.md` |

### 反馈反哺

- "是我的买家" → 自动提取公司特征（国家/行业/产品），强化偏好匹配
- "不是我的买家" → 追问原因（产品不对/市场不对/规模不对），更新排除规则
- "已有买家" → 加入已有客户池，不再推荐同公司

### 交互模式

**逐条发送**，每条线索一张独立卡片，卡片自带三个按钮。

优点：
- 按钮直接对应，不用追问"哪几个"
- 每条线索独立可操作，不互相干扰
- 用户点按钮即完成反馈

条数控制：单次不超过 5 条，超过则分批发送。先发一句汇总提示"🔍 为你找到 X 条线索，逐条发送——"，再逐条发卡片。

callback_data 格式：`lead:{action}:{company_name}`
- `lead:good:PT X` → 是我的买家
- `lead:bad:PT X` → 不是
- `lead:have:PT X` → 已有

## 反馈存储

```
memory/projects/mio/dealclaw/leads/
├── {user_id}-qualified.md    # 确认的买家
├── {user_id}-rejected.md     # 排除的买家 + 原因
└── {user_id}-existing.md     # 已有的买家
```

每行格式：
```
2026-07-03 | 公司名 | 🇮🇩 印尼 | 来源 | 原因(仅 rejected)
```
