# 04 — Ops Agent 系分

> 优先级: P1 | 部署: 中央控制平面 | 语言: TypeScript + Node.js
> 前置依赖: K8s 集群, Tenant Registry, Credits Ledger

## 1. 职责边界

Ops Agent 是全自动生命周期管理引擎。**零人工介入**——从开通到销毁，所有状态流转由 Ops Agent 自动推进。

```
Ops Agent ─每小时巡检 ──▶ Tenant Registry (检查所有租户状态)
          ──▶ Provisioning Service (暂停/恢复/销毁)
          ──▶ Credits Ledger (月度重置)
          ──▶ 客户 Bot (到期提醒、续费通知)
```

## 2. 租户状态机

```
  ┌─────────┐
  │ pending  │  扫码完成，等待开通
  └────┬────┘
       │ Onboarding Agent → Provisioning
       ▼
  ┌──────────────┐
  │ provisioning │  K8s 创建中 (自动 → active)
  └──────┬───────┘
         │ 创建成功
         ▼
  ┌──────────┐  credits 不足
  │  active   │──────────┐
  └────┬─────┘          ▼
       │          ┌─────────────┐  充值成功
       │          │ low_credits  │──────────┐
       │          └──────┬──────┘          │
       │                 │ 持续不足         │
       │                 ▼                  │
       │          ┌───────────┐  续费      │
       │          │ suspended  │───────────┤
       │          └─────┬─────┘           │
       │                │ 超过暂停期        │
       │                ▼                  │
       │          ┌─────────┐  续费       │
       │          │  grace   │────────────┘
       │          └────┬────┘
       │               │ 保留期满 (30天)
       │               ▼
       │          ┌───────────┐
       │          │ destroyed  │  硬删除 + 归档
       │          └───────────┘
       │
       └──── 正常续费/充值 ────▶ active
```

## 3. 自动通知链

| 时间点 | 动作 | 渠道 |
|--------|------|------|
| 到期前 7 天 | "7天后到期" + 本月用量总结 | Bot 对话 + 邮件 |
| 到期前 3 天 | 提醒 + 续费入口卡片 | Bot 对话 |
| 到期前 1 天 | ⚠️ 最后提醒 | 全渠道 |
| 到期当天 00:00 | 进入 suspended 状态，暂停 Pod | 通知 |
| 到期第 8 天 | 进入 grace 状态，数据备份 | 通知 |
| grace 第 15 天 | "15天后数据永久删除" | 邮件 |
| grace 第 30 天 | 硬删除: Namespace + Token + 归档 | 邮件 |
| 销毁后 90 天 | COS 备份自动过期 | 系统自动 |

## 4. 巡检任务（每小时执行）

```
Ops Agent 每小时巡检:
│
├── ① 查询所有 active 租户
│   ├── credits 低于月额度 10% → 推送 low_credits 通知
│   ├── credits 耗尽 → 推送 suspended 通知
│   └── 到期日在 7/3/1 天内 → 推送到期提醒
│
├── ② 查询所有 suspended 租户
│   ├── suspended 超 7 天 → 推进到 grace
│   └── 客户续费 → 恢复 active + 重启 Pod
│
├── ③ 查询所有 grace 租户
│   ├── grace 第 15 天 → 推送最终删除提醒
│   └── grace 满 30 天 → 调用 Provisioning Service 销毁
│
├── ④ 查询所有 destroyed 租户
│   └── 数据保留满 90 天 → 清理 COS 备份
│
├── ⑤ 健康检查
│   ├── 所有 active Pod 是否 running
│   ├── Gateway 是否响应 /healthz
│   └── 异常 → 自动重启 + 通知运维
│
└── ⑥ 月度重置 (每月 1 日 00:00)
    └── 调用 Credits Ledger 重置 monthly_used
```

## 5. API 契约（内部调用）

### 5.1 触发巡检

```
POST /v1/ops/scan
Authorization: Bearer <ops-internal-token>

Response 200:
{
  "scanned": 45,
  "actions": {
    "notified_low_credits": 3,
    "notified_expiring": 1,
    "advanced_to_suspended": 1,
    "advanced_to_grace": 0,
    "destroyed": 0,
    "pod_restarted": 0,
    "errors": 0
  },
  "durationMs": 3200
}
```

### 5.2 手动干预（运维专用）

```
POST /v1/ops/tenants/{tenantId}/action
Authorization: Bearer <ops-admin-token>

{
  "action": "suspend" | "resume" | "extend_grace" | "destroy",
  "reason": "客户投诉 / 运维操作"
}
```

## 6. 对话式续费流程

```
Ops Agent (通过客户 Bot): 你的 DealClaw Pro 将于 7 天后到期。
                         本月已处理 230 封邮件，生成 45 条线索。
                         要续费吗？

客户: 续吧

Ops Agent: Pro 版续费一年 ¥69,800，确认？

客户: 确认

Ops Agent: ✅ 已生成续费订单。
            请点击链接完成支付：https://pay.dealclaw.cn/order/xxx
            支付完成后服务自动恢复。

[客户支付成功 → Payment Service 回调 → Credits 到账 → Ops Agent 自动恢复 Pod]
```

## 7. 部署规格

```yaml
cpu: 200m
memory: 256Mi
replicas: 1 (单实例, 避免巡检重复执行)

环境变量:
  DATABASE_URL: postgresql://.../dealclaw
  PROVISIONING_URL: http://provisioning.dealclaw-system:8082
  CREDITS_LEDGER_URL: http://credits-ledger.dealclaw-system:8081
  KUBECONFIG: /etc/dealclaw/kubeconfig  # 只读权限
  OPS_INTERNAL_TOKEN: <internal>
```
