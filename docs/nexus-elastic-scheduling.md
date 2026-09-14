# Nexus 弹性运行的 Cron 与 heartbeat

用户通过 OpenClaw 的 `nexus_schedule` 工具创建、查询、修改、暂停和取消任务。内置 Cron 工具继续禁用，内置 heartbeat 继续设为 0m，避免实例内外重复调度。这里的 heartbeat 是 Nexus 到点唤醒 OpenClaw 执行检查的适配实现，不是让休眠的进程继续计时。

## 数据和执行

- `elastic_schedules`：所属租户和会话、投递群、任务内容、时区和下一次时间。
- `elastic_schedule_commands`：工具调用的幂等回执。只有数据库提交后才向 OpenClaw 返回成功。
- `elastic_runs`：聊天和调度共用执行队列、租户锁、状态保存和空闲释放。每个计划时间有唯一 request_key。
- 1 秒轮询到期任务，事务内创建运行和 pg-boss 工作，并推进下一次时间。停机期间错过的周期合并为一次，不补发大量过期任务。
- 同一 Agent 的调度任务尚未完成时不堆积下一轮；聊天和定时任务按已有队列串行执行。每个计划使用独立会话，仍共享所属 Agent 的工作目录和记忆，避免每次检查携带完整群聊历史。blocked Agent 的计划保留等待恢复。
- 定时结果主动发送到创建任务时的飞书会话。heartbeat 只回复 HEARTBEAT_OK 或 NO_REPLY 时，记为静默完成，不发群消息。
- 取消或暂停会取消已入队但未开始的运行；正在执行的工具不能因此撤回。

## 支持的计划

- 指定时间：`{kind:"at",at:"2026-09-15T09:00:00+08:00"}`，执行入队后关闭。
- 周期：`{kind:"every",everySeconds:1800}`，最短 60 秒。
- 五字段 Cron：`{kind:"cron",expr:"0 9 * * *",tz:"Asia/Shanghai"}`。
- heartbeat 默认每 30 分钟，默认读取工作目录 HEARTBEAT.md；也可设置具体检查指令。
- 最多每 Agent 100 个启用计划；任务只能在所属会话中查看和修改。

## 运行桥接

受控插件通过本次 invoke 的 nonce 将请求写入临时目录；invoke 将完整 RPC 帧复用到 SSE 输出。控制服务从当前运行推导租户及会话，不信任工具传入的租户或投递目标。数据库提交后的回执写回同一个 Sandbox。无需公开额外管理端口，也不向模型暴露数据库或管理员凭据。

这是业务调度适配，不是 OS 级权限隔离。Agent 的 exec 仍运行于现有权限环境；本改动没有实现配置文件的强制不可写。

## 当前运行边界

调度器目前随 Mac 上的 runtime-manager 运行。Mac 休眠/服务停止期间不会准时执行；恢复后合并补执行。正式无人值守需把控制服务和数据库迁移到持续可用环境。已持久化的任务不依赖 Sandbox 存活。

工具加载需要 manifest 的 contracts.tools 和 activation 元数据。仅配置 alsoAllow 不会注册工具。

## 2026-09-14 验收记录

在《出海精灵 AI外贸专家》原群验证：

- OpenClaw 实际调用 nexus_schedule 的 add/list，Nexus 事务提交后返回回执。
- 注册后重启 runtime-manager，数据库中的任务保留。
- 18:06:48 Sandbox 释放，Cron 唤醒后 18:07:06 群投递成功。
- 18:08:13 再次释放；heartbeat 在 18:09:02 到期，启动耗时 12.754 秒，18:09:24 群投递成功。
- 两次均有新的 OpenClaw 启动记录（processReused=false），无需用户发消息。
- 自动测试覆盖时区、命令幂等、租户隔离、取消、并发调度、漏周期合并、一次性任务、blocked 等待恢复及取消已排队任务。

- 18:10:36 HEARTBEAT_OK 被记为 heartbeat-quiet，未向群发送；随后取消全部验收计划，启用计划数为 0。群消息投递以飞书 API 成功和执行记录为据，客户端展示等待用户反馈。
