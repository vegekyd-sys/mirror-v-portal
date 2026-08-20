# DealClaw 安全需求文档

> 参考 WorkBuddy 安全模型 | 2026-07-24 | 田耕郡

## 一、企业数据硬隔离 ✅ 已完成

| 措施 | 状态 | 实现 |
|------|:---:|------|
| enterprise 参数强制 | ✅ | 所有引擎读写必须传 enterprise，无参数抛 ValueError |
| 跨企业域名去重 | ✅ | `save_lead` 按 `enterprise+domain` 联合去重，同域名可存在于不同企业 |
| 老板视角内嵌 | ✅ | 传 `enterprise` 不传 `user_open_id` = 全企业数据 |
| 发送日志隔离 | ✅ | `SendLog` 所有统计/查询/时间线方法强制 enterprise 参数 |
| GS/FD 发送前退订检查 | ✅ | 发送脚本自动调 `can-send` CLI，退订买家全渠道拦截 |
| IQ 数据最小化 | ✅ | 退订/拒绝时不存回复原文 |
| GS 邮件合规 footer | ✅ | 按国家自动附加 (EN/PT/ES) |

---

## 二、操作确认扩展

### 原则

```
高风险操作 → 预览/确认 → 执行
低风险操作 → 静默执行
```

### 需要加确认的操作

| 操作 | 当前行为 | 目标 | 风险等级 |
|------|------|------|:---:|
| 发送邮件 (GS/FD) | 预览后确认 ✅ | 保持 | 🔴 |
| 覆盖已有 CBIE 画像 | 直接覆盖，无提示 | 弹窗：「已存在画像，是否覆盖？」 | 🔴 |
| 删除 KB 材料 | 不可逆，无确认 | 弹窗：「删除后 IQ 自动回复将缺此材料」 | 🔴 |
| 解锁被退订的买家 | 无此操作 | 故意不支持——退订不可逆 | — |
| 修改企业偏好设置 | 直接改 | 弹窗：「修改后影响该企业所有销售」 | 🟡 |
| 批量标注线索 | 直接标注 | 弹窗：「确认标注 15 条线索？」 | 🟡 |
| 切换企业上下文 | 无此操作 | 提示：「你即将切换到 X 企业，当前未保存的操作将丢失」 | 🟢 |

### 实现方式

```python
# dc_confirm.py — 操作确认引擎
CONFIRM_REQUIRED = {
    "image_overwrite": "已存在 CBIE 画像，是否覆盖？",
    "kb_delete": "删除后 IQ 自动回复将缺此材料，确认删除？",
    "prefs_update": "修改后影响该企业所有销售，确认修改？",
    "batch_annotate": "确认标注 {count} 条线索？",
    "enterprise_switch": "你即将切换到 {target}，当前未保存的操作将丢失。",
}

def require_confirm(action, context=None):
    """返回确认提示。如果 action 不需要确认，返回 None。"""
    msg = CONFIRM_REQUIRED.get(action)
    if msg and context:
        msg = msg.format(**context)
    return msg
```

---

## 三、审计日志

### 当前状态：零

| 有审计吗？ | send_log | leads | KB |
|:---:|:---:|:---:|:---:|
| 谁操作 | ⚠️ 仅发送记录有 user_open_id | ⚠️ 标注时有，其他操作无 | ❌ |
| 操作了什么 | ✅ 发送明细 | ⚠️ 仅标注状态变更 | ❌ |
| 什么时候 | ✅ _ts | ⚠️ 仅标注时间 | ❌ |
| 改了之前是什么 | ❌ | ❌ | ❌ |

### 审计日志设计

**存储：** `data/audit_log.jsonl`（与 send_log 同格式，逐行追加）

**字段：**

```json
{
  "_ts": "2026-07-24T07:08:00.000Z",
  "user_open_id": "ou_xxx",
  "enterprise": "solarunis.com",
  "action": "lead.annotate",
  "target": "ecori.com.br",
  "detail": "我的买家 → 不是我的买家",
  "before": "我的买家",
  "after": "不是我的买家"
}
```

**action 枚举：**

| action | 触发时机 | target 示例 |
|------|------|------|
| `lead.annotate` | 标注线索 | buyer domain |
| `lead.save` | 新线索入库 | buyer domain |
| `lead.dedup_filter` | 去重过滤移除 | buyer domain |
| `kb.seed` | KB 播种（CBIE→KB） | enterprise_key |
| `kb.delete` | 删除 KB 材料 | material_key |
| `profile.update` | 更新 CBIE 画像 | enterprise domain |
| `send.gs` | GS 发送 | buyer_email |
| `send.fd` | FD 发送 | buyer_email |
| `iq.process` | IQ 处理买家回复 | buyer domain |
| `iq.unsubscribed` | IQ 标记退订 | buyer domain |
| `prefs.update` | 修改偏好 | — |
| `enterprise.create` | 新企业入驻 | enterprise domain |
| `search.perform` | 执行买家搜索 | keyword |

### 查询接口

```python
# dc_audit.py — 审计查询
class AuditLog:
    def user_actions(self, user_open_id, enterprise, days=7):
        """某销售在某企业内的操作记录"""

    def enterprise_actions(self, enterprise, days=7):
        """某企业所有成员的操作记录（老板视角）"""

    def action_stats(self, enterprise, days=7):
        """操作统计：谁做了什么、做了多少次"""
```

### 老板看板示例

```
本周企业 solarunis.com 操作统计

田耕郡: 搜索 8 次 | 入库 5 条 | 发送 12 封 | 标注 3 条
张三:   搜索 3 次 | 入库 1 条 | 发送 5 封  | IQ处理 2 次
```

### 落表策略

| 操作类型 | 何时写入 |
|------|------|
| 发送/入库/标注/IQ | 操作完成后立即写入（同 send_log 模式） |
| 搜索 | 仅写 search.perform 计数，不写每次 keyword 详情 |
| KB/画像修改 | 写入时附带 before/after 用于回溯 |

### 隐私边界

- 审计日志本身不存储买家 PII（邮箱、回复原文）——只存储 buyer_domain 和操作摘要
- 审计日志按 enterprise 隔离查询
- 审计日志保留 12 个月，之后归档

---

## 四、优先级

| 优先级 | 项目 | 工作量 | 依赖 |
|:---:|------|:---:|------|
| 🔴 P0 | 审计日志引擎 (`dc_audit.py`) + 写入埋点 | 2h | 无 |
| 🔴 P0 | 审计查询 CLI + 老板看板集成 | 1h | dc_audit.py |
| 🟡 P1 | 操作确认引擎 (`dc_confirm.py`) | 1h | 无 |
| 🟡 P1 | 高风险操作接入确认 | 1h | dc_confirm.py |
| 🟢 P2 | 搜索审计、画像修改审计 | 1h | dc_audit.py |
