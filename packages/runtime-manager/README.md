# DealClaw elastic runtime trial

消息先写入 PostgreSQL，pg-boss 调度同一租户的串行任务，再唤醒 Vercel Sandbox 内的 OpenClaw。飞书长连接留在本机常驻进程，Agent 无需常驻。默认使用原仓库 DealClaw payload；扫码 HTML 和 registerApp 保持原样，由原 central-gateway 代理到新的租户创建接口。

## 本机试用

入口：http://127.0.0.1:8097/ 。打开后点击右上角“扫码创建飞书 Bot”，使用飞书扫码。创建的新 Bot 凭据加密保存在试用数据库，服务重启后恢复长连接。浏览器也可直接对同一 Agent 发送文本消息。现有生产租户和 Kubernetes Pod 未迁移。

- 空闲阈值：本次试用 60 秒，每 5 秒检查一次；正常完成后保存会话与工作文件，停止 Sandbox 并留存快照。
- 恢复：下一条消息恢复同一命名 Sandbox。过期/丢失的既有快照报错，不静默创建空白 Agent。
- 持久化：每轮成功完成后额外备份完整会话状态与相对原 payload 的工作文件变更到本机私有目录；飞书密钥 AES-256-GCM 加密。基础快照没有租户或模型凭据，模型凭据只传入运行进程环境。
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


## 首字性能版（2026-09-14）

当前试用改用 DeepSeek 官方 `deepseek-flash`，不经 OpenRouter，默认关闭 thinking 以降低聊天首字等待。配置中的 key 只传入 VM 进程环境；loopback 模型代理记录首个 content delta 的耗时，不记录提示词或推理文本。Vercel SDK 输出必须等待 Writable 排空才判断完成。

飞书使用原生 CardKit 流式卡片（需要 Bot 已有 `cardkit` 写权限）。原扫码 Bot 实测有该权限；无权限或卡片更新失败时回退最终文本。指标 `feishu-first-content` 表示飞书 API 成功接收真实文字，不是占位提示，也不等于客户端实际渲染时间。扫码页面保持原样，浏览器试用页也会显示生成中的部分文字。

详见 [10 条样本与 CPU Profiling](docs/latency-profile-2026-09-14.md) 和 [原始耗时表](docs/latency-samples-2026-09-14.json)。

精简备份格式 v2 包含完整 `state`、配置及变更的 workspace 文件，并附 `.nexus-backup.json` 删除清单。人工恢复时，先从对应基础快照的原 payload 初始化 workspace，再覆盖备份，最后应用删除清单。快照仍包含完整磁盘，是正常唤醒的来源；这些精简归档是额外备份，不是可单独恢复的完整安装包。版本不匹配时不可套用其他 payload。测试覆盖文件修改、新增、删除、未修改文件恢复、符号链接和会话状态。

性能脚本会向指定 Bot 的最近一次用户消息发送测试回复，仅在已获该会话授权后运行：

```sh
NEXUS_PROFILE_TENANT_ID=<目标租户ID> pnpm --filter @dealclaw/runtime-manager exec tsx scripts/profile.ts
```

脚本需私有 `.elastic/profile/config.json` 的 `model` 配置。`profile-diagnostics.ts` 必须显式指定 `NEXUS_DIAGNOSTIC_TENANT_ID`，仅接受没有 Bot 且已休眠的隔离测试租户。`recover-completed-profile.ts` 是本次流输出收尾竞态的证据校验恢复工具：要求明确 run ID、唯一完成事件及已写入的验收文件，不重做工具操作；不要用它清除普通不确定状态。
