# DealClaw Nexus

Agent 多租户运行平台。客户飞书扫码 → 10 秒拥有自己的 AI 外贸销售 Agent。零表单、无需手动配置。

## 当前部署

| 服务 | URL | 状态 |
|------|-----|------|
| 入驻页面 | http://43.156.232.2:8085/onboard | ✅ 已部署 |
| Central Gateway API | http://43.156.232.2:8085 | ✅ 运行中 |
| Provisioning Service | http://localhost:8082 (内网) | ✅ 运行中 |

### 入驻流程实现状态 (2026-07-30)

- ✅ 飞书扫码 → `lark.registerApp()` 生成设备授权二维码
- ✅ 用户确认 → SDK 自动返回 App ID + App Secret
- ✅ 创建租户 + 分配 K8s 资源
- ✅ 前端轮询入驻状态，完成展示结果
- ⬜ 飞书 App 内自动跳转授权页（当前浏览器扫码需手动打开飞书）
- ⬜ Bot webhook 绑定飞书开放平台 API 调用
- ⬜ 欢迎语通过客户 Bot 发送

## 入驻流程

```
用户飞书扫码 → 飞书 App 内确认创建 → 后台异步创建租户+虚拟机 → 开始对话
```

无需填写表单。公司信息由 DealClaw Agent 在对话中收集。

## 架构

```
Central Gateway (扫码入口 + registerApp 集成)
        │
        ├── lark SDK registerApp() ── 飞书一键创建应用
        │
        └── Onboarding 编排 ──▶ Provisioning Service ──▶ K8s
                │
                └── Tenant Registry (DB)

每个租户独立 Pod:
        ├── Nexus Agent Gateway (auth/credits/audit)
        └── DealClaw Agent (skills orchestration)

后台运维:
        ├── Ops Agent (lifecycle management)
        ├── Credits Ledger
        └── Payment Service (规划中)
```

## 项目结构

```
dealclaw/
├── packages/
│   ├── central-gateway/       # 扫码入口 + registerApp 集成 + 入驻编排
│   ├── nexus-gateway/         # 客户 Pod 内 Gateway（Node.js/TS）
│   ├── provisioning-service/  # K8s 资源开通服务（Node.js/TS）
│   ├── credits-ledger/        # Credits 账本服务
│   ├── ops-agent/             # 全自动生命周期管理
│   ├── mock-agent/            # Agent 模拟器（开发用）
│   ├── dealclaw-agent/        # DealClaw Agent 核心（Skill 组合）
│   └── admin-dashboard/       # 运维管理后台
├── e2e/                       # 全链路端到端测试
├── docs/                      # 技术设计文档
├── k8s/                       # K8s 部署清单
└── scripts/                   # 运维脚本
```

## 技术栈

- **核心服务**: TypeScript + Node.js
- **Agent 运行时**: OpenClaw
- **容器编排**: K3s / Kubernetes
- **数据库**: PostgreSQL
- **飞书集成**: @larksuiteoapi/node-sdk (registerApp 一键创建)

## 测试覆盖

| 层级 | 服务数 | 测试数 | 状态 |
|------|--------|--------|------|
| 单元测试 | 8 | 127 | ✅ |
| E2E 全链路 | 4 链 | 15 | ✅ |
| **合计** | | **142** | ✅ |

## 参考文档

- [DealClaw Nexus 系统设计](./docs/architecture.md)
- [模块详情](./docs/modules/)
- [测试设计](./docs/testing.md)
- [任务列表](./docs/tasks.md)
- [DealClaw Nexus 技术方案 v3.0](https://versa-ai.feishu.cn/docx/EPGvdMIb6onOdIxdRKScpj6tnxI)
- [DealClaw 定价策略 v4](https://versa-ai.feishu.cn/docx/UmbpdM4h9o0qF2xkgy9cLSR3nff)
