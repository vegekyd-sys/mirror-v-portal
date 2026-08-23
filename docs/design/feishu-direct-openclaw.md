# 设计：P2 飞书直连 OpenClaw 官方插件

> 状态：已评审（2026-08-24）。决策：D1 私信 **open 全开放**；D2 飞书工具**全部启用**
>（需租户 app 配齐 scopes，缺权限的工具调用会报错但不影响聊天）；D3 灰度用**新建测试租户**。
> 前置 P1（LLM 出口代理记账）已上线并 E2E 验证。

## 1. 背景与目标

当前消息链路（bridge 模式）：

```
飞书 WS ──► nexus-gateway ws-client ──POST /execute──► dealclaw-agent bridge
                                                        │ OpenClaw gateway HTTP API (18790)
                                                        ▼
                                              回复原路返回 → 网关调飞书 API 回帖
```

P1 已把记账/余额拦截收口到 LLM 出口代理，消息面不再承担商业能力。P2 将消息面整体替换为
OpenClaw 官方 `@openclaw/feishu` 插件（agent 内原生 WS 长连接），获得：

- **流式卡片回复**（Card Kit）——体验从「等全文」升级为「边生成边出」
- **原生群聊支持**（@提及策略、群会话、话题线程）——bridge 模式只支持单聊文本
- **媒体消息**（图片等）与飞书工作区工具（文档/wiki/多维表格）可选启用
- **消息面复杂度下沉**：nexus-gateway 的 ws-client / feishu-reply 整段退役，网关退化为纯 LLM 出口代理
- LLM 记账天然覆盖（插件消息同样经 baseUrl 代理出口）

## 2. 调研结论（全部实测确认）

| 事实 | 结论 |
|---|---|
| `@openclaw/feishu` npm 包 | 存在，latest `2026.7.1`，与基础镜像 `ghcr.io/openclaw/openclaw:2026.7.1` 同版本 |
| 镜像是否内置 | **否**——`/app/dist/extensions` 71 个插件中无 feishu，需 Dockerfile 构建时预装 |
| 配置格式 | `channels.feishu: { enabled, appId, appSecret, dmPolicy, groupPolicy, requireMention, tools… }` |
| 事件传输 | WebSocket 默认（无需公网 URL），与现有网关一致 |
| plugin-sdk 钩子 | `message_received` 确认存在（hook-runtime 导出 `isMessageReceivedEvent` 等），另有 message_sent/preprocessed/transcribed |
| 钩子上下文 | `ctx.From`、`ctx.OriginatingChannel`、`ctx.MessageSid`、`ctx.RawBody` 等字段可用——足以取 sender open_id |
| WS 竞争 | 同一 app 凭据多客户端连接会竞争分发——**切换必须先停网关 WS，再启插件** |
| 生命周期通知 | central-gateway notify-relay 直接调飞书 API（不依赖租户网关在线），**无需迁移**，只依赖 im_open_id 回写 |

## 3. 架构（目标态）

```
飞书 WS ──► @openclaw/feishu 插件（agent 内，原生会话/流式卡片/群聊）
                │ message_received 钩子
                ▼
        dealclaw-contact 插件 ──PATCH──► provisioning /v1/tenants/:id/contact（im_open_id 回写）
                │ LLM 调用
                ▼
        nexus-gateway LLM 出口代理（P1，不变：记账 + 余额拦截）

central-gateway notify-relay（生命周期通知，不变：直接调飞书 API）
```

## 4. 改动清单

### 4.1 dealclaw-agent 镜像（Dockerfile）

- 构建期安装 `@openclaw/feishu@2026.7.1` 到插件目录（与镜像 OpenClaw 版本严格对齐，
  避免运行时 `openclaw plugins install` 拉网络的不可控性）。

### 4.2 dealclaw-agent / write-config.mjs

- 读 env `DEALCLAW_MESSAGE_PLANE=openclaw` 且 `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 存在时，
  生成 `channels.feishu` 段；否则不生成（保持现状，零影响存量）。
- 建议配置（决策点见 §6）：
  ```json5
  channels: { feishu: {
    enabled: true, appId, appSecret,
    dmPolicy: "open", allowFrom: ["*"],
    groupPolicy: "allowlist",           // 群聊默认关，需要时按租户开
    requireMention: true,               // 群内需 @
    streaming: true,                    // 流式卡片
    typingIndicator: false,             // 省配额
    tools: { doc: true, chat: true, wiki: true, drive: true, perm: true, bitable: true } // D2 全开
  } }
  ```
- appSecret 走 env（bot Secret envFrom），config 引用不落盘敏感值——沿用 LLM_KEY 的 env 模式
  （channels.feishu.appSecret 若支持 `{source:"env"}` 则用之，否则接受 config 文件 0600 落盘，
  实现时以插件实际支持为准）。

### 4.3 dealclaw-agent / 新插件 dealclaw-contact

- `payload/plugins/dealclaw-contact/`：监听 `message_received`，取 `ctx.From`（open_id），
  fire-and-forget `PATCH ${PROVISIONING_SERVICE_URL}/v1/tenants/${DEALCLAW_TENANT_ID}/contact`，
  内存去重（同 open_id 只报一次），失败仅日志——对齐现有 ws-client 的 reportContact 语义。
- agent Deployment env 需补：`DEALCLAW_TENANT_ID`、`PROVISIONING_SERVICE_URL`、`PROVISIONING_API_TOKEN`。

### 4.4 provisioning-service

- tenants 表新增列 `message_plane VARCHAR(16) DEFAULT 'gateway'`（gateway | openclaw）。
- `provisionTenant` / `bindTenantFeishuApp`：
  - agent Deployment envFrom 增挂 bot Secret（仅 openclaw 模式；gateway 模式不挂，避免泄凭据）+ env
    `DEALCLAW_MESSAGE_PLANE`；gateway Deployment env `DEALCLAW_MESSAGE_PLANE`（ws-client 读到
    openclaw 即跳过 WS 启动，对齐现有 `!appId` 安全跳过路径）。
- 新路由 `PUT /v1/tenants/:id/message-plane`（body: `{plane}`），执行顺序保证无 WS 竞争：
  1. patch gateway env（停 WS）→ 滚动等待
  2. patch agent envFrom/env → 滚动
  3. 切回时反向：先 agent（去 channels）→ 再恢复网关 WS
- 存量租户迁移即调该路由，逐租户灰度。

### 4.5 nexus-gateway

- `config.ts` / `index.ts`：读 `DEALCLAW_MESSAGE_PLANE=openclaw` → 跳过 startWSClient（日志说明）。
- ws-client / feishu-reply 在全部租户迁移完成后于后续版本退役（本期保留，作为回退路径）。

### 4.6 不改动

- credits-ledger / LLM 出口代理（P1 成果直接覆盖新消息面）
- central-gateway notify-relay（生命周期通知链路不变）
- admin-web chat 测试入口（bridge /execute 保留）

## 5. 发布与验证计划

1. 单测：write-config channels 生成（开/关/缺凭据）、contact 插件回写、provisioning message-plane
   切换顺序（先停 WS 后启插件）、gateway 跳过逻辑。
2. 构建：dealclaw-agent + provisioning-service 两镜像，Jenkins `DEPLOY_ENV=PROD`。
3. 灰度 E2E（选 1 个测试租户）：
   - 切 openclaw 模式 → 飞书私聊发消息 → **流式卡片回复**正常
   - `llm_usage_events` 落行（记账经出口代理不受影响）
   - provisioning 租户记录 `im_open_id` 已回写
   - 触发一条 lifecycle 通知 → notify-relay 送达
   - 群聊 @ 机器人 → 默认不响应（allowlist 空）；开群后响应
   - 切回 gateway 模式 → 飞书消息恢复网关路径（回退演练）
4. 推广：逐租户 `PUT message-plane`，全部完成后下版本退役网关消息面代码。

## 6. 决策点（待确认）

| # | 决策点 | 选项 |
|---|---|---|
| D1 | 私信策略 dmPolicy | a) `open`+`["*"]`（任何人可私聊，每个租户独立 app，风险可控）b) `allowlist`（需先拿到老板 open_id，运营成本高） |
| D2 | 飞书工作区工具（文档/wiki/多维表格） | a) 默认全关（工具面最小，符合现有 deny 风格）b) 默认开 doc+wiki（增值卖点） |
| D3 | 灰度租户 | 现有两个存量租户（264559c9 / 55726626）选一个，或新建测试租户 |
