# P2 飞书直连 OpenClaw — 发布与灰度 E2E 全流程报告

日期：2026-08-24 05:30 · 构建 #64(失败)/#65/#66（PROD）· 灰度 E2E 通过 · 灰度租户运行于 openclaw 消息面

## 成果总览

P2 将飞书消息面从 nexus-gateway WS bridge 整体替换为 agent 内 OpenClaw 官方
`@openclaw/feishu` 插件（原生 WS 长连接、流式卡片），nexus-gateway 退化为纯 LLM
出口代理，支持租户级灰度切换与回退。**灰度租户已上线并完成双向演练。**

| E2E 项 | 结果 |
|---|---|
| feishu 插件 WS 启动（mode: websocket） | ✅ |
| 飞书私聊 → 插件接收 → agent 回复（replies=1，流式卡片） | ✅ |
| LLM 记账走网关出口代理（llm_usage_events 落行，source=proxy） | ✅ |
| appSecret 环境引用、无明文落盘 | ✅ |
| im_open_id 回写（dealclaw-contact 插件） | ✅（Build #66 修复后） |
| lifecycle 通知（notify-relay → 飞书私聊） | ✅ 用户确认收到 |
| 回退演练（切 gateway → 网关 WS 恢复 → agent_ok + feishu_reply_ok → 切回） | ✅ |
| 群聊默认不响应（groupPolicy=allowlist 空） | ⚠️ 未实测（单测已覆盖） |

## 发布过程（三次构建）

1. **Build #64 FAILURE** — 根因：CI 使用 aochi 仓库的 override Dockerfile
   （`cicd/dealclaw-nexus/build/dealclaw-agent/Dockerfile`）覆盖包内 Dockerfile：
   ① `npm test` stage 只 COPY src，新测试找不到 `/build/runtime/write-config.mjs`；
   ② override 未包含 P2 feishu 插件预装；③ payload 版本停在 v1。
   **教训：改包内 Dockerfile 必须同步改 aochi override。**
2. 修复 aochi（`08a2c0a`：npm test 前 COPY runtime + 插件预装 USER root + payload v2）
   → **Build #65 SUCCESS**（`master.f951f054.65`，三服务）→ GitOps 滚 provisioning
   （message_plane 列迁移生效）→ promote gateway+agent → rollout cron 滚 2 存量租户。
3. **Build #66 SUCCESS**（`master.a250e53b.66`，仅 agent）— 修复 im_open_id 回写：
   `message_received` 钩子真实形态为 `(event, ctx)` 双参数，sender 在
   `ctx.senderId` / `event.senderId` / `event.from`（字符串）、channel 在
   `ctx.channelId`（依据 `/app/dist/message-hook-mappers-*.js` 反编译实证）。
   原 commit `a250e53`。

## 灰度租户

- 租户 `a3f6ac0b6823462c9a40c7901137aa7a`（bot `cli_aaf3dccc14f89bb3`）
- 最终态：`message_plane=openclaw`，feishu 插件 WS ready，网关跳过 WS
- 存量 2 租户（264559 / 55726626）仍 gateway plane，按计划逐租户推广

## 已知遗留（非 P2 回归）

- bridge「scope upgrade pending approval」配对报错 — 存量租户同样存在，不影响飞书消息面
- feishu-dedup `openKeyedStore is only available for trusted plugins` 警告 — 回退内存去重，无害
- 群聊实测待用户后续补充（把 bot 拉群 @ 它，默认不应响应）

## 关键代码提交

| commit | 内容 |
|---|---|
| `a874e4e` | P2 全量代码（15 文件 +824 行，12 新测试全绿） |
| `f951f05` | agent Dockerfile 插件预装前显式 USER root |
| `a250e53` | dealclaw-contact 钩子字段形态修复（im_open_id 回写） |
| aochi `fd6d838`/`08a2c0a` | CI override Dockerfile 对齐 P2 |
