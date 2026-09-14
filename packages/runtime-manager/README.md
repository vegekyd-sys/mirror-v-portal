# DealClaw elastic runtime trial

消息先写入 PostgreSQL，pg-boss 调度同一租户的串行任务，再唤醒 Vercel Sandbox 内的 OpenClaw。飞书长连接留在本机常驻进程，Agent 无需常驻。默认使用原仓库 DealClaw payload；扫码 HTML 和 registerApp 保持原样，由原 central-gateway 代理到新的租户创建接口。

## 本机试用

入口：http://127.0.0.1:8097/ 。打开后点击右上角“扫码创建飞书 Bot”，使用飞书扫码。创建的新 Bot 凭据加密保存在试用数据库，服务重启后恢复长连接。浏览器也可直接对同一 Agent 发送文本消息。现有生产租户和 Kubernetes Pod 未迁移。

- 空闲阈值：本次试用 60 秒，每 5 秒检查一次；正常完成后保存会话与工作文件，停止 Sandbox 并留存快照。
- 恢复：下一条消息恢复同一命名 Sandbox。过期/丢失的既有快照报错，不静默创建空白 Agent。
- 持久化：每轮成功完成后额外备份 `agent-data` 到本机私有目录；飞书密钥 AES-256-GCM 加密。基础快照没有租户或模型凭据，模型凭据只传入运行进程环境。
- 并发：消息 ID 去重，队列按租户限制并发，PostgreSQL advisory lock 协调唤醒、执行与回收。
- 失败：执行中断且外部操作结果不确定时标记 `uncertain/blocked`，不自动重做工具动作；需要检查后恢复。消息回复使用持久化 outbox 和稳定 UUID。

本次是单机控制面的试用部署：Mac、Docker PostgreSQL 和两个 Node 进程必须保持运行。Sandbox 计算在 Vercel。仅接通文本消息、模型与文件工具；CRM、邮箱等业务平台连接器没有配置。单轮限制 10 分钟，VM 安全上限 20 分钟；后台进程会推迟空闲回收，但不支持无限时后台任务。自动灾备恢复、控制面 HA、监控告警与生产迁移尚未交付。

## 启动与配置

需要 Node 22+、pnpm 9、Docker，以及有 Sandbox 权限的 Vercel 项目。当前使用独立的 `nexus-elastic-postgres` 容器，绑定本机 55436，未连接现有 Makaron 数据库。

在仓库根目录建立权限 0700 的 `.elastic`，写入权限 0600 的 `config.json`。配置结构见 `config.example.json`；自行生成 adminToken 和 32 字节十六进制 encryptionKey。凭据不要提交到 Git。可设置 `NEXUS_CONFIG_PATH` 指向绝对路径；Vercel token 支持环境变量 `VERCEL_TOKEN`，或本机已有 Vercel CLI 登录。

```sh
pnpm install
pnpm --filter @dealclaw/runtime-manager snapshot
pnpm --filter @dealclaw/runtime-manager build
pnpm --filter @dealclaw/runtime-manager start
# 第二个终端运行原有扫码入口（仅监听 loopback）
pnpm --filter @dealclaw/runtime-manager exec tsx scripts/onboarding.ts
```

构建 snapshot 使用 `git archive HEAD` 提取原 payload，安装固定版本 OpenClaw 2026.7.1。snapshot ID 保存到私有配置。源码使用 Vercel Sandbox SDK 3.3.0 和 pg-boss 12.31.1。

关闭试用时，对这两个 Node 进程发送 SIGTERM；先等所有 Agent 任务完成、试用页显示已释放计算资源。不要删除数据库 volume、私有配置或租户快照，否则会丢失注册信息或会话。私有配置中的 encryptionKey 丢失后不能解密 Bot 凭据。

## 验证

```sh
pnpm --filter @dealclaw/runtime-manager build
pnpm --filter @dealclaw/runtime-manager test
```

测试使用私有配置指定的本机 PostgreSQL 创建独立临时数据库，验证消息去重、并发串行化、处理中不释放、回收时新消息不丢失、失败不重放、后台任务延后回收、真实队列按顺序处理。结束后只删除本次测试数据库。

实际 Vercel/OpenClaw 验收证据见 `docs/acceptance-2026-09-14.md`。`scripts/smoke.ts` 与 `scripts/resume.ts` 是显式人工验收脚本，会启动计费 Sandbox 并调用真实模型；不要与运行中的同一试用租户并行执行。
