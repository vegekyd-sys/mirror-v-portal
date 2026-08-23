# 记忆架构 — ID 命名空间 + 写入归属 + 目录结构

> 状态：设计定稿（2026-08-22）。本文件定义 DealClaw 记忆层的 ID 映射、canonical 写入方和目录结构，是「企业长期记忆」的地基。

## 一、ID 命名空间映射

| ID | 含义 | 取值 | 现状 |
|---|---|---|---|
| `enterprise_id` | 企业 | supplier id（数字） | 单租户从 MIO_CDP_SUPPLIER_ID 动态获取 |
| `open_id` | 用户 | 飞书 open_id（ou_xxx） | 已有 |

**映射关系：** 一个企业 → 多个用户。规则挂企业，偏好挂人。

```
enterprise_id（supplier id）
   └─ open_ids: [ou_a, ou_b, ...]     ← 该企业成员
        ├─ 偏好 → 按人挂（open_id 维度）
        └─ 规则 → 按企业挂（enterprise_id 维度）
```

## 二、目录结构

```
memory/
├── people/<open_id>.md              ← 用户特征 + 偏好（按人）
├── company/<enterprise_id>/rules.md ← 纠偏规则（按企业，if-then）
└── YYYY-MM-DD.md                    ← 日志（原始流水）

data/memory/<enterprise_id>/
├── meta.json                        ← 自描述（本文件字段定义见下）
├── leads.json                       ← 线索只读缓存（canonical 在飞书）
└── emails.jsonl                     ← 邮件只追加（canonical 在 email-facts）

data/memory/<supplier_id>/kb.json      ← 知识库 canonical（dc_kb_engine 写，key = supplier id）
```

## 三、每文件单一写入方（canonical 唯一）

| 数据 | canonical 位置 | 唯一写入方 | data/memory 角色 |
|---|---|---|---|
| 知识库 | `data/memory/<supplier_id>/kb.json` | `dc_kb_engine` | 只引用（不复制） |
| 线索 | 飞书 Bitable | `lark-cli`（飞书侧写） | 只读缓存 |
| 邮件 | `email-facts/` | `email_gateway` | 只追加（jsonl） |
| 规则 | `memory/company/<id>/rules.md` | dealclaw-review（当轮原子写） | — |
| 偏好 | `memory/people/<open_id>.md` | agent（用户交互时写） | — |

**铁律：** 每个数据只有一个 canonical 写方，data/memory 里的 leads 是飞书的只读缓存、emails 只追加、knowledge 不复制只引用——**不双写**。

## 四、meta.json 字段定义

模板：`data/memory/_template/meta.json`

| 字段 | 含义 |
|---|---|
| `enterprise_id` | supplier id（数字），从 MIO_CDP_SUPPLIER_ID 动态获取 |

| `open_ids` | 该企业成员列表（规则按企业、偏好按人） |
| `canonical` | 三个数据源的权威位置（knowledge/leads/emails） |
| `write_owner` | 每文件唯一写入方 |
| `rules_file` | 规则文件位置（按企业分文件） |
| `initialized` | supplier id 注入后置 true |
| `initialized_at` | 初始化时间戳 |

**新企业接入流程：** 照 meta.json 模板填一遍（enterprise_id / open_ids / canonical / write_owner），即可自描述接入。

## 五、待办（依赖本文件）

- ③ 纠偏当轮原子写 rules.md（接上 SOUL「记进画像」承诺）
- ④ 边界判据（if-then 进 rules，其余进 data）+ rules.md [状态|日期|来源] + 日志 30 天蒸馏
