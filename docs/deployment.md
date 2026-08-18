# 部署方案

> 版本: v0.1 | 2026-07-26 | Author: V

## 1. 部署决策

**全部国内部署** — 阿里云 K8s 集群，Staging + Production 两个 Namespace。

### 决策依据

DealClaw 服务的核心链路全在国内：

```
国内客户 ──飞书/钉钉/企微──▶ DealClaw Agent ──▶ 米奥 API (国内)
                │                    │
                │ 飞书 SDK           │ 阿里云 ACR
                │ 支付宝回调          │ Jenkins
                │ 钉钉/企微 OAuth     │ PostgreSQL
                │                    │
                └──── 全部国内 ──────┘
                                    │
海外买家 ◀── 邮件 / 聊天页面 ────────┘
```

| 组件 | 主要通信 | 所在地 | 延迟需求 |
|------|---------|--------|---------|
| Nexus Agent Gateway | 飞书/钉钉/企微 webhook | 国内 | 低延迟 |
| DealClaw Agent | 米奥 API | 国内 | 低延迟 |
| Central Gateway | 飞书 registerApp / 钉钉企微 OAuth | 国内 | 低延迟 |
| Credits Ledger | Gateway / Agent 内部调用 | 国内 | 低延迟 |
| Payment Service | 支付宝/微信回调 | 国内 | 低延迟 + 监管要求 |
| Ops Agent | K8s API + DB | 国内 | — |
| Admin Dashboard | PostgreSQL | 国内 | — |

**唯一出海的流量**：Agent 给海外买家发邮件 → SMTP relay（可配海外节点），不单独部署服务器。

## 2. 集群规划

```
阿里云 ACK (Kubernetes)
│
├── namespace: dealclaw-staging       # Staging 环境
│   ├── nexus-gateway
│   ├── credits-ledger
│   ├── provisioning
│   ├── ops-agent
│   ├── central-gateway
│   ├── onboarding
│   ├── payment-service
│   └── admin-dashboard
│
├── namespace: dealclaw-prod          # 生产环境
│   ├── (同上，独立实例)
│   └── PostgreSQL (Supabase / RDS)
│
└── 租户运行时（同环境 namespace 内，按租户创建专用工作负载）
    ├── dealclaw-agent-<tenantId> (Deployment + Service，per-tenant)
    └── (其余中央服务按需调用/路由)
```

### 资源预估

| 环境 | 规格 | 月费估算 |
|------|------|---------|
| Staging (单副本) | 4C8G × 1 节点 | ~¥500 |
| Production 中央服务 | 8C16G × 2 节点 | ~¥2000 |
| 客户 Pod (每 10 个) | 4C8G | ~¥300/客户 |
| PostgreSQL (RDS) | 2C4G 基础版 | ~¥500 |
| 阿里云 ACR | 基础版 | ~¥200 |
| 合计 (10 客户) | — | **~¥6000/月** |

## 3. 海外买家交互策略

### 阶段策略

| 阶段 | 海外延迟方案 | 适用场景 |
|------|------------|---------|
| **M0** | 直接国内集群 | 几个测试客户，200-300ms 可接受 |
| **M1** | 国内集群 + 阿里云 CDN | 买家 Web Chat Widget 就绪后 |
| **M2+** | 香港/新加坡轻量 Chat Gateway | 海外买家量大，需低延迟 |

### M1 方案：CDN 加速

买家聊天页面部署在阿里云 CDN（全球节点），静态资源就近加载，WebSocket 连接回源到国内 K8s。

### M2+ 方案：边缘 Chat Gateway

```
                国内 K8s 集群
                    │
            ┌───────┼───────┐
            │       │       │
    香港边缘节点   新加坡    法兰克福
    (Chat GW)   (Chat GW)  (Chat GW)
    仅 WebSocket   仅转发     仅转发
    不落地业务     不落地      不落地
```

- 每个边缘节点只跑一个轻量 Chat Gateway（WebSocket proxy）
- 业务逻辑仍在国内 DealClaw Agent
- 不存储数据，无状态，随时扩缩

## 4. 域名规划

| 域名 | 用途 | DNS 解析 |
|------|------|---------|
| `dealclaw.cn` | DealClaw 官网（融合二维码入口） | 国内 |
| `api.dealclaw.cn` | Central Gateway API | 国内 |
| `pay.dealclaw.cn` | Payment Service 回调地址 | 国内 |
| `admin.dealclaw.cn` | Admin Dashboard | 国内（仅内网） |
| `chat.dealclaw.cn` | 买家聊天页面 (M1) | CDN 全球 |

## 5. 数据库

| 数据库 | 引擎 | 用途 |
|--------|------|------|
| DealClaw Nexus DB | PostgreSQL (Supabase / RDS) | Tenant Registry, Credits, Audit, Orders |
| 客户 CRM DB | 按客户独立 schema/project | 客户线索、邮件、会议数据 |

## 6. 租户数据持久化与备份

### 6.1 持久化分层

dealclaw-agent 运行时数据全部在容器 `/data` 下：

| 目录 | 用途 |
|------|------|
| `/data/state` | OpenClaw 状态（config、会话、插件） |
| `/data/home` | OpenClaw home |
| `/data/workspace` | agent 工作区（skills、memory、脚本） |

workspace 写入策略：
- **immutable payload**（identity/skills/scripts）每次启动从镜像 `/opt/dealclaw/payload` rsync 刷新（`--delete`）
- **customer-mutable 路径**仅保留 `memory/customer/` 和 `work/mio-api/data/`
- `/overlay`（可选 ConfigMap）→ 客户知识，rsync 进 `memory/customer/`

### 6.2 Per-tenant PVC

每个租户独立 PVC，挂到 dealclaw-agent 的 `/data`：

- PVC 命名：`dealclaw-runtime-<tenantId>`
- 默认规格：`10Gi` / `alibabacloud-cnfs-nas` / `ReadWriteOnce`
- 由 provisioning-service 创建，deprovision 时同步删除

环境变量（provisioning-service）：

```
AGENT_PVC_SIZE=10Gi
AGENT_PVC_STORAGE_CLASS=alibabacloud-cnfs-nas
AGENT_PVC_ACCESS_MODE=ReadWriteOnce
```

### 6.3 扩容策略

阿里云 CNFS NAS 本质是按量付费的弹性文件系统，PVC 的 size 只是配额。

- **在线扩容**：NAS 存储类支持 `allowVolumeExpansion`，`kubectl patch pvc` 无损扩容（NAS 不涉及数据迁移）
- **按套餐分档**：starter 10Gi / pro 30Gi / enterprise 100Gi，在 plan_tier 映射
- **监控告警**：ops-agent 巡检 PVC 实际用量，>80% 提醒

### 6.4 数据备份与归档（OSS）

备份通过一次性 K8s Job 实现：挂载租户 PVC → 跑 ossutil 上传 `/data` 到 OSS。

| 模式 | 触发时机 | OSS 存储层 | 用途 |
|------|---------|-----------|------|
| `backup` | 租户进 grace（suspend→grace） | Standard | 快速恢复 |
| `archive` | 销毁前（grace→destroyed） | Archive | 低成本长期归档 |

- 备份 Job：`dealclaw-<backup|archive>-<tenantId>-<timestamp>`，TTL 24h（backup）/ 7d（archive）
- OSS 路径：`oss://<bucket>/<tenantId>/<mode>/<timestamp>/`
- 归档顺序：**archive_data 必须先于 destroy_pod**（PVC 存在才能备份）

环境变量（provisioning-service）：

```
OSS_ENDPOINT=oss-cn-shanghai.aliyuncs.com
OSS_BUCKET=dealclaw-backup
OSS_SECRET_NAME=dealclaw-oss
BACKUP_IMAGE=alpine:3.19
```

OSS 凭证 Secret（`dealclaw-oss`，Opaque）：

```yaml
stringData:
  accessKeyId: "..."
  accessKeySecret: "..."
```

### 6.5 OSS 最小 RAM 权限

备份 Job 只做「上传 + 增量对比」，专用子账号 RAM User 最小策略：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:ListObjects",
        "oss:GetObjectMeta"
      ],
      "Resource": [
        "acs:oss:*:*:dealclaw-backup",
        "acs:oss:*:*:dealclaw-backup/*"
      ]
    }
  ]
}
```

- 恢复流程需额外加 `oss:GetObject`
- 用专用子账号 AK，不要用主账号，只授权指定 bucket
- `--update` 依赖 `oss:ListObjects`；若去掉则退化为全量覆盖上传

### 6.6 待办

- [ ] 恢复流程 `POST /v1/tenants/:id/restore`（从 OSS 拉回数据到新 PVC）
- [ ] 生产用预装 ossutil 的专用备份镜像（替换 alpine 运行时下载）
- [ ] PVC 用量监控告警
- [ ] OSS 备份定期校验 / 快照（Velero 或 CNFS 快照）

## 7. 未来扩展：海外集群

以下场景触发海外集群建设：

- DealClaw 服务 Slack/WhatsApp/Telegram 的海外客户
- 海外买家 Chat Widget 月活 > 1 万
- 海外客户要求数据主权（GDPR）

**实现**：在 `k8s/overlays/` 下预留 `overseas/` 目录，未来直接复制国内 overlay + 调整 endpoint。

## 8. 相关文档

- [CI/CD 方案](./cicd.md) — Jenkins + ACR 构建部署
- [架构设计](./architecture.md) — 系统架构 + ADR
- [任务列表](./tasks.md) — 开发进度追踪
