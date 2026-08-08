---
name: "survey-alert"
description: "奥创直营销售部调研问卷预警：按部门到人，每日4次扫描，🔴未交/🟡不足3张/🟢已达标"
---

# survey-alert — 调研问卷预警

> 奥创直营销售部：每日扫描调研问卷回收情况，按部门到人三级预警。
> 通过飞书卡片消息推送到指定群。

## 触发条件

- 触发词：`调研问卷预警` `问卷预警` `通报调研` `调研情况`
- 定时触发：每天 11:30 / 14:00 / 16:00 / 18:00（由 cron 或外部调度触发）
- 手动触发时直接执行一次扫描并发送预警卡片

## 数据源

| 表 | Base Token | Table ID | 用途 |
|---|---|---|---|
| 今日表 | H6oebS8BGavCSIsvmpqcCrJinkd | tblQ4zOJ49EdXyQU | 今日回收调研表量 |
| 本周表 | H6oebS8BGavCSIsvmpqcCrJinkd | tblAdQ4S6iDMDVaF | 本周累计回收调研问卷 |

## 花名册规则

- 从本周表中筛选 `是否在职=在职` 的人员
- 排除人员：张贤煜、李培培、苏群才、余晓燕、张云、Cai Lucas、王菊
- 排除规则说明：这些人员为经理/新人/外籍/非一线销售，不纳入调研表考核
- 目标部门：华东销售一部、华东销售二部、华东销售三部、华南销售一部

## 执行流程

### Step 1：拉取基础数据

```bash
# 本周表（获取花名册 + 本周累计问卷数）
lark-cli base +record-list --base-token H6oebS8BGavCSIsvmpqcCrJinkd \
  --table-id tblAdQ4S6iDMDVaF --json --page-size 200 --as bot

# 今日表（获取今日问卷数）
lark-cli base +record-list --base-token H6oebS8BGavCSIsvmpqcCrJinkd \
  --table-id tblQ4zOJ49EdXyQU --json --page-size 200 --as bot
```

JSON 数组索引映射：

**本周表：** 7=姓名, 13=部门, 18=是否有效人力, 20=本周回收调研问卷, 23=是否在职
**今日表：** 0=姓名(需确认), 同字段名查找 `今日收回调研表量`

> ⚠️ 使用 JSON 数组模式时，先用 `+field-list` 确认字段顺序，或直接用 `--format markdown` 解析表格。

### Step 2：数据解析与过滤

用 Python 解析 JSON：

```python
import json, sys

EXCLUDED = {'张贤煜','李培培','苏群才','余晓燕','张云','Cai Lucas','王菊'}
TARGET_DEPTS = {'华东销售一部','华东销售二部','华东销售三部','华南销售一部'}

# 解析本周表
def parse_weekly(data):
    rows = data['data']['data']
    employees = []
    for r in rows:
        name = r[7]
        dept = r[13][0] if isinstance(r[13], list) and r[13] else ''
        eff = r[18][0] if isinstance(r[18], list) and r[18] else ''
        status = r[23][0] if isinstance(r[23], list) and r[23] else ''
        weekly_surveys = int(r[20]) if r[20] else 0
        
        if status == '在职' and dept in TARGET_DEPTS and name not in EXCLUDED:
            employees.append({
                'name': name, 'dept': dept, 'eff': eff,
                'weekly': weekly_surveys, 'daily': 0
            })
    return employees

# 解析今日表 — 按姓名匹配
def merge_daily(employees, data):
    rows = data['data']['data']
    daily_map = {}
    for r in rows:
        name = r[0]  # 今日表姓名在 index 0
        daily_count = int(r[-5]) if len(r) > 5 else 0  # 今日收回调研表量
        daily_map[name] = daily_count
    
    for e in employees:
        e['daily'] = daily_map.get(e['name'], 0)

# 分级
def classify(e):
    w = e['weekly']
    if w >= 3: return '🟢已达标'
    elif w >= 1: return f'🟡不足（{w}/3）'
    else: return '🔴未交'
```

### Step 3：生成预警卡片

按部门汇总，输出格式：

```
📊 奥创直营调研问卷预警
⏰ 2026-07-27 14:00

━━ 华东销售一部（7人）━━
🔴 未交：毛一松、王印、刘丰硕...
🟡 不足3张：无
🟢 已达标：无

━━ 华东销售二部（5人）━━
...
```

生成飞书卡片消息并通过 CLI 发送：

```bash
lark-cli message send --chat oc_c6d49820d64ea1c17deb01c6bdfa6f9c \
  --card @/tmp/survey_alert_card.json --as bot
```

卡片 JSON 设计（`--presentation` 格式）：

```json
{
  "title": "📊 奥创直营调研问卷预警",
  "tone": "warning",
  "blocks": [
    {"type": "text", "text": "⏰ 2026-07-27 14:00\n📋 基准：每人每周3张调研表"},
    {"type": "divider"},
    {"type": "text", "text": "**华东销售一部（7人）**\n🔴未交：XXX、XXX\n🟡不足：—\n🟢达标：—\n📋本周问卷：0份"},
    {"type": "divider"},
    ...每个部门一个 block...
  ]
}
```

### Step 4：输出摘要

在触发群内回复一句话摘要（不用重复卡片内容）：

```
📊 预警已推送至奥创群
🔴未交：22人 | 🟡不足：3人 | 🟢达标：0人
```

## 输出规范

- 预警卡片发送到 `chat_id=oc_c6d49820d64ea1c17deb01c6bdfa6f9c`
- 摘要回复触发所在的群/人
- 时间段映射：11:30=「上午预警」、14:00=「午后预警」、16:00=「下午预警」、18:00=「收盘预警」

## 失败降级

| 场景 | 处理 |
|------|------|
| Base API 无权限 | 告知用户 bot 无此 base 权限，需子璇重新授权 |
| 今日表拉取失败 | 仅用本周表数据出预警，标注「今日数据暂未获取」 |
| 本周表拉取失败 | 无法出预警，告知用户数据源不可用 |
| 卡片发送失败 | 降级为普通文本消息发送到目标群 |

## 边界

- 仅统计目标四部门 + 在职 + 非排除人员
- 不修改 base 数据，只读
- 预警卡片不在触发群重复发送（触发群只回摘要）
- 排除人员名单如有变更需手动更新此 skill
