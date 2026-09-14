# 小脸与过程流式验收

用户已确认三项实际飞书效果：收到消息出现小脸，长命令等待期间卡片显示进展，完成后小脸消失。

## 改动

- 参考 V 的原生 `Typing` reaction，在消息持久入队后立即添加；执行入口也补偿添加。reaction ID 写入事件表，完成后移除，控制器重启后清理已送达任务的残留；表情接口失败不阻断任务。
- 参考 `patch-worker-visible-progress.mjs` 的公开进展边界：工具状态可在正文出现前打开同一张 CardKit 卡片，模型公开说明与工具状态实时更新，最终清除临时状态。
- Nexus 使用 HTTP Responses 接口，原接口只转发 assistant/lifecycle。给 Sandbox 内固定版本 OpenClaw 2026.7.1 增加最小、幂等、严格锚点补丁，转发当前 run 的工具 name/phase/id 和公开 assistant snapshot。禁止输出工具参数、工具结果原文或内部 reasoning。
- 模型请求附加简短中文公开进展要求；保持原 DealClaw payload、模型与租户隔离不变。
- 沿用上一轮最新文本合并及 fast 展示，最短更新间隔 150ms。

只读参考了 V 的代码；没有修改 V 或 VLab。

## 真实 Bot 验证

Bot：《出海精灵 AI外贸专家》；run `d0b76003-0373-4b5c-9195-1c424f51475c`。

任务：先说明操作，真实执行等待 12 秒并输出 `nexus-progress-ok` 的 Node 命令，再读取已有验收文件，最后报告结果。

| 事件 | 北京时间 |
|---|---|
| 消息任务开始唤醒 | 16:25:56.412 |
| Typing 添加成功 | 16:25:57.001 |
| OpenClaw ready | 16:26:10.214 |
| 首个公开文本 delta | 16:26:13.619 |
| exec start | 16:26:14.173 |
| 首卡 API 确认 | 16:26:14.501 |
| exec result | 16:26:26.521 |
| read start / result | 16:26:28.147 / 28.168 |
| 模型最终完成 | 16:26:30.215 |
| 最终回复送达 | 16:26:33.262 |
| Typing 移除成功 | 16:26:33.611 |

10 次卡片增量更新，无 stream-error，无文本 fallback。首卡比模型最终完成早 15.7 秒。以上是服务端/API 时间，客户端可见效果另有用户确认，未将状态占位算作模型首字。

原始证据 `.elastic/progress-verification.json`（私有、gitignored）。复现命令：`NEXUS_PROFILE_TENANT_ID=<tenant> pnpm --filter @dealclaw/runtime-manager exec tsx scripts/verify-progress.ts`，会向目标 Bot 最近会话发送真实验收回复。

## 验证与边界

原套件及新增 typing/无正文工具卡片测试共 15 项通过；新增补丁幂等、run 过滤与不泄露参数结果测试通过；TypeScript build 通过。

本轮改善的是等待期间的可见反馈，不代表减少 Sandbox 冷启动或工具自身执行时间。普通任务只有模型实际发出公开进展或工具事件时才有过程内容，不伪造进度。当前 Typing API 失败仅记录事件，重启时补偿清理；仍需沿用已有本机控制器在线要求。
