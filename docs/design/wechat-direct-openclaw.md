# 个人微信扫码绑定 Agent — 技术实现方案

> 模式：**租户 Agent 内微信插件直连**（对标飞书 `message_plane=openclaw` 直连方案）
> 日期：2026-09-12
> 状态：方案待评审，未开始编码

---

## 1. 方案总览

### 1.1 目标

让管理员在控制台为租户绑定一个个人微信号，绑定后该租户 Agent 内的 OpenClaw 微信插件持有微信长连接，私聊消息经 Agent `/execute` → LLM → 微信回复，计费走 nexus-gateway 出口代理——和飞书 `message_plane=openclaw` 完全对称。

### 1.2 与飞书方案的核心差异

| 维度 | 飞书直连 | 个人微信直连（本方案） |
|------|---------|---------------------|
| 凭据形态 | `appId/appSecret`（管理员手填或扫码获取） | 扫码登录后插件自动生成 `bot_token`，**管理员无法手填** |
| 凭据校验 | provisioning 调飞书 API `tenant_access_token` 验证 | **无独立校验 API**；凭据由插件扫码流程生成，只能由插件自己确认 |
| 凭据存储 | `tenants.app_id/app_secret` + K8s Secret `DEALCLAW_APP_ID/SECRET` | 插件写入 `/data/state/openclaw-weixin/accounts/{id}.json`（PVC）；DB 只存绑定状态，**不存 token 明文** |
| 扫码执行位置 | provisioning-service 进程内调 `lark.registerApp()`（控制面） | **必须在 Agent Pod 内执行**（插件 `auth.login` 跑在 gateway 进程上下文） |
| 扫码会话 | 进程内 `Map`（provisioning pod） | 插件进程内 `activeLogins` `Map`（Agent pod） |
| channel 配置 | `channels.feishu`（write-config 生成，appId/appSecret env 引用） | `channels["openclaw-weixin"]`（插件读 state 目录账号，配置只需 `enabled:true`） |
| 消息面 owner | Agent（openclaw plane） | Agent（openclaw plane） |

### 1.3 关键约束（来自插件源码实证）

1. **扫码必须在 Agent Pod 内执行**：插件 `auth.login` → `startWeixinLoginWithQr` + `waitForWeixinLogin` 跑在 OpenClaw gateway 进程上下文（loopback 18790），不能由 provisioning-service 远程调用。
2. **扫码会话是进程内 `Map`**：`activeLogins` TTL 5 分钟，不跨副本、不持久。provisioning-service 不能直接持有这个会话。
3. **账号 token 落 PVC**：`saveWeixinAccount` 写入 `resolveStateDir()/openclaw-weixin/accounts/{accountId}.json`，文件权限 `0600`。重启后插件 `restoreContextTokens` + `gateway.startAccount` 恢复。
4. **插件配置 schema 为空**：`openclaw.plugin.json` 的 `configSchema.properties` 为空；账号列表来自 state 目录 `accounts.json`，不来自 `openclaw.json`。因此 write-config 只需 `channels["openclaw-weixin"].enabled = true`。
5. **插件 `auth.login` 用 stdout 输出二维码、stdin 读验证码**：不能直接给前端用，需要一个 Agent 内的受控 HTTP helper 把二维码/状态/验证码桥接到 HTTP。
6. **同一微信账号单 owner**：插件 `clearStaleAccountsForUserId` 会按 userId 清理旧账号，但这是单进程语义；跨 Pod 必须靠 DB 唯一约束 + 连接租约保证。

---

## 2. 架构设计

### 2.1 整体链路

```
管理员控制台 (admin-web)
    │
    │ 1. POST /v1/admin/tenants/:tid/wechat-binding/start
    ▼
provisioning-service
    │ 2. 写 DB: wechat_bindings 行 (status=validating)
    │ 3. 调 Agent 内受控 API: POST http://dealclaw-agent-{tid}.{ns}:18789/wechat/login/start
    ▼
dealclaw-agent Pod (OpenClaw gateway @ loopback 18790)
    │ 4. Agent bridge 收到 /wechat/login/start
    │ 5. 调插件 auth.login 的 startWeixinLoginWithQr()
    │ 6. 插件向 ilinkai.weixin.qq.com 请求二维码
    │ 7. 返回 {qrcodeUrl, sessionKey} 给 bridge
    ▼
Agent bridge HTTP 响应 → provisioning-service → 控制台显示二维码
    │
    │ 8. 前端每 3s 轮询 GET .../status/:sessionId
    ▼
Agent bridge 轮询插件 waitForWeixinLogin() 状态
    │ 9. 用户手机扫码 + 可能输入验证码
    │ 10. 插件确认 → saveWeixinAccount() → PVC 落盘
    │ 11. triggerWeixinChannelReload() → gateway 重载 config
    │ 12. gateway.startAccount() → 微信 monitor 启动
    ▼
provisioning-service 收到 completed
    │ 13. UPDATE wechat_bindings SET status=active, account_id=..., bound_at=NOW()
    │ 14. 写 tenant_status_log + audit_logs
    │ 15. 前端显示"已绑定"
```

### 2.2 Agent 内受控登录 helper（新增）

**为什么不直接用 `pod-exec`**：`pod-exec` 是通用终端，二维码解析、验证码输入、会话归属、并发互斥、审计和超时都无法控制。

**方案**：在 `packages/dealclaw-agent/src/` 新增 `wechat-login-bridge.ts`，挂到现有 Express app（`app.ts`）上，提供 3 个内部端点：

| 端点 | 方法 | 作用 |
|------|------|------|
| `/internal/wechat/login/start` | POST | 调 `startWeixinLoginWithQr`，返回 `{sessionId, qrcodeUrl, expiresAt}` |
| `/internal/wechat/login/status/:sessionId` | GET | 查 `activeLogins` 状态，返回 `{status, message, accountId?}` |
| `/internal/wechat/login/cancel/:sessionId` | POST | abort 扫码会话 |
| `/internal/wechat/login/verify-code/:sessionId` | POST | 提交手机验证码（如插件要求） |

**安全**：
- 只监听 loopback（与 OpenClaw gateway 一致），不暴露到 Pod 外。
- provisioning-service 通过 Service `dealclaw-agent-{tid}:18789` 访问，带 `Authorization: Bearer $PROVISIONING_API_TOKEN`。
- 单租户单会话：同一 `tenantId` 只允许一个 active login session，第二个 start 返回 409。
- 不返回 `bot_token` / `qrcode` 原始值给前端，只返回 `qrcodeUrl`（前端可渲染）和脱敏状态。

**实现要点**：
- `startWeixinLoginWithQr` 和 `waitForWeixinLogin` 是插件导出的异步函数，但它们用 `process.stdout`/`process.stdin`。需要：
  - `startWeixinLoginWithQr` 可以直接调用（它不依赖 stdin）。
  - `waitForWeixinLogin` 内部 `readVerifyCodeFromStdin` 依赖 stdin，需要 monkey-patch 或重构为可注入的 `readVerifyCode` 回调。**首选**：在 bridge 层用 `process.stdin` 的替代实现注入，或直接轮询插件状态 map 而不调用 `waitForWeixinLogin`（见下方替代方案）。

**替代方案（更简单）**：bridge 不调用 `waitForWeixinLogin`，而是：
1. 调 `startWeixinLoginWithQr` 拿到 `sessionKey` + `qrcodeUrl`。
2. 自己用 `pollQRStatus` 逻辑轮询 iLink API（从插件源码复制长轮询逻辑，或直接调 `apiGetFetch`）。
3. 确认后调 `saveWeixinAccount` + `registerWeixinAccountId` + `triggerWeixinChannelReload`。
4. 这样完全绕开 stdin，验证码通过 HTTP 端点提交。

> **决策**：采用替代方案，因为插件 `waitForWeixinLogin` 的 stdin 依赖在 HTTP 服务上下文中不可控。直接在 bridge 层复刻长轮询 + 账号持久化逻辑，比 monkey-patch stdin 更可靠。

### 2.3 write-config.mjs 改造

参照 `channels.feishu` 的生成逻辑，新增 `channels["openclaw-weixin"]`：

```javascript
// ── WeChat channel (personal WeChat direct connection) ──────────────
// DEALCLAW_WECHAT_BOUND=1 + DEALCLAW_MESSAGE_PLANE=openclaw 时启用。
// 与飞书不同：微信账号凭据由插件扫码后写入 PVC state 目录，
// write-config 只需声明 channel enabled，不需要 appId/appSecret。
const wechatBound = process.env.DEALCLAW_WECHAT_BOUND === '1' &&
  messagePlane === 'openclaw';
```

在 `config.channels` 中追加：

```javascript
...(wechatBound ? {
  'openclaw-weixin': {
    enabled: true,
    // 多账号隔离：每个微信账号+联系人独立 session
    // 插件官方建议 per-account-channel-peer
  },
} : {}),
```

在 `plugins.entries` 中追加：

```javascript
'openclaw-weixin': { enabled: true },
```

在 `plugins.allow` 中追加 `'openclaw-weixin'`。

在 `pluginLoadPaths` 中追加微信插件 sideload 路径（与飞书对称）：

```javascript
const WECHAT_PLUGIN_DIR = '/opt/dealclaw/plugins/weixin/node_modules/@tencent-weixin/openclaw-weixin';
if (wechatBound && process.env.DEALCLAW_WECHAT_TRUSTED !== '1') pluginLoadPaths.push(WECHAT_PLUGIN_DIR);
```

**session.dmScope**：当微信绑定时，应设为 `per-account-channel-peer`（插件官方建议）。飞书用 `per-channel-peer`。需要按 platform 区分：

```javascript
session: {
  dmScope: wechatBound
    ? 'per-account-channel-peer'
    : (process.env.DEALCLAW_SESSION_DM_SCOPE || 'per-channel-peer'),
  ...
}
```

### 2.4 entrypoint.sh 改造

参照 `ensure_feishu_trusted`，新增 `ensure_wechat_trusted`：

```bash
WECHAT_PLUGIN_VERSION="2.4.8"
export DEALCLAW_WECHAT_TRUSTED=0

wechat_bound() {
  [[ "${DEALCLAW_WECHAT_BOUND:-0}" == "1" \
     && "${DEALCLAW_MESSAGE_PLANE:-gateway}" == "openclaw" ]]
}

ensure_wechat_trusted() {
  local marker="${OPENCLAW_STATE_DIR}/npm/.dealclaw-weixin-version"
  if [[ -f "$marker" && "$(cat "$marker" 2>/dev/null || true)" == "$WECHAT_PLUGIN_VERSION" ]]; then
    return 0
  fi
  local force=""
  if compgen -G "${OPENCLAW_STATE_DIR}/npm/projects/openclaw-weixin-*" >/dev/null; then
    force="--force"
  fi
  if openclaw plugins install "npm:@tencent-weixin/openclaw-weixin@${WECHAT_PLUGIN_VERSION}" --accept-capabilities $force >/dev/null 2>&1; then
    mkdir -p "${OPENCLAW_STATE_DIR}/npm"
    printf '%s' "$WECHAT_PLUGIN_VERSION" > "$marker"
    echo "[dealclaw-runtime] weixin 插件 trusted 安装完成（v${WECHAT_PLUGIN_VERSION}）"
    return 0
  fi
  if [[ -n "$force" ]]; then
    echo "[dealclaw-runtime] weixin 插件升级失败，保留旧 trusted 安装" >&2
    return 0
  fi
  echo "[dealclaw-runtime] weixin 插件 trusted 安装失败，回退镜像内 sideload 副本" >&2
  return 1
}

if wechat_bound && ensure_wechat_trusted; then
  export DEALCLAW_WECHAT_TRUSTED=1
fi
```

**注意**：`--accept-capabilities` 是 OpenClaw 8.2+ 的安全机制（见记忆 #186），必须加。当前镜像基线 2026.7.1 可能不需要，但加上无害且向前兼容。

### 2.5 Dockerfile 改造

参照飞书插件的 bake，新增微信插件 bake：

```dockerfile
USER root
RUN npm install --omit=dev --no-save --legacy-peer-deps \
      --prefix /opt/dealclaw/plugins/weixin \
      @tencent-weixin/openclaw-weixin@2.4.8 \
    && chown -R node:node /opt/dealclaw/plugins
```

---

## 3. 数据模型

### 3.1 新增表 `wechat_bindings`

```sql
CREATE TABLE IF NOT EXISTS wechat_bindings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  account_id TEXT,                    -- 插件 normalizeAccountId (e.g. hex-im-bot)
  weixin_user_id TEXT,                -- 扫码用户的 userId (脱敏展示用)
  status TEXT NOT NULL DEFAULT 'unbound'
    CHECK (status IN ('unbound','validating','bound','active','disabling','disabled','failed','expired')),
  session_id TEXT,                    -- 当前扫码 sessionKey (validating 阶段)
  last_error TEXT,
  bound_at TIMESTAMPTZ,
  unbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id),                 -- 单租户单微信绑定
  UNIQUE (account_id)                 -- 单账号单租户（防跨租户竞争）
);
```

### 3.2 不复用 `tenants.app_id/app_secret`

微信 token 由插件管理，落在 PVC。DB 只存绑定状态和账号标识，**不存 token 明文**。这与飞书不同（飞书 token 是 `appSecret`，需要 provisioning 持有以调飞书 API）。

### 3.3 Redis 用途（复用 email-webhook Redis 基础设施）

| Key | TTL | 用途 |
|-----|-----|------|
| `dealclaw:wechat:lock:{tenantId}` | 30s lease | 防同租户并发扫码 |
| `dealclaw:wechat:session:{sessionId}` | 10min | 扫码会话元数据（跨 provisioning 副本可见） |
| `dealclaw:wechat:event:{messageId}` | 5min | 入站消息幂等去重 |

**注意**：扫码本身的 `activeLogins` 仍在 Agent Pod 进程内，Redis 只存 provisioning 侧的会话元数据（sessionId → tenantId → agentUrl 映射），用于跨 provisioning 副本路由轮询请求。

---

## 4. API 设计

### 4.1 控制台前端 API（provisioning-service）

| 端点 | 方法 | 请求 | 响应 |
|------|------|------|------|
| `/v1/admin/tenants/:tid/wechat-binding` | GET | — | `{bound, accountId?, weixinUserId?, status, boundAt?}` |
| `/v1/admin/tenants/:tid/wechat-binding/start` | POST | — | `202 {sessionId, qrcodeUrl, expiresAt}` |
| `/v1/admin/tenants/:tid/wechat-binding/status/:sessionId` | GET | — | `{status, message, accountId?}` |
| `/v1/admin/tenants/:tid/wechat-binding/cancel` | POST | `{sessionId}` | `{ok}` |
| `/v1/admin/tenants/:tid/wechat-binding/unbind` | POST | — | `202 {ok}` |

### 4.2 Agent 内部 API（dealclaw-agent bridge）

| 端点 | 方法 | 认证 | 请求 | 响应 |
|------|------|------|------|------|
| `/internal/wechat/login/start` | POST | Bearer PROVISIONING_API_TOKEN | — | `{sessionId, qrcodeUrl, expiresAt}` |
| `/internal/wechat/login/status/:sessionId` | GET | Bearer | — | `{status, message, accountId?}` |
| `/internal/wechat/login/cancel/:sessionId` | POST | Bearer | — | `{ok}` |
| `/internal/wechat/login/verify-code/:sessionId` | POST | Bearer | `{code}` | `{ok}` |

### 4.3 绑定状态机

```
unbound → validating → bound → active
              ↓           ↓
           failed/expired  disabling → disabled
```

- `validating`：provisioning 调 Agent `/internal/wechat/login/start` 成功，等待扫码。
- `bound`：Agent 确认扫码完成、token 已落 PVC。
- `active`：provisioning 确认 Agent 内 `gateway.startAccount` 成功（通过 `/healthz` + `channels status` 间接判断）。
- `disabling`：解绑中，Agent 正在停止 monitor + 清理 state。
- `disabled`：解绑完成，state 已清。

---

## 5. 绑定流程（详细步骤）

### 5.1 绑定

1. 管理员在控制台点击"绑定微信"。
2. 前端 `POST /v1/admin/tenants/:tid/wechat-binding/start`。
3. provisioning-service：
   - 查租户存在、非 destroyed。
   - 查 `wechat_bindings` 无 active 绑定。
   - Redis `SET NX PX 30000 dealclaw:wechat:lock:{tid}`（防并发）。
   - `INSERT wechat_bindings (tenant_id, status='validating')`。
   - `POST http://dealclaw-agent-{tid}.{ns}:18789/internal/wechat/login/start`。
   - Agent bridge 调 `startWeixinLoginWithQr`，返回 `{sessionId, qrcodeUrl}`。
   - provisioning 存 `session_id` 到 DB + Redis（跨副本路由）。
   - 返回 `202 {sessionId, qrcodeUrl, expiresAt}`。
4. 前端显示二维码，每 3s `GET .../status/:sessionId`。
5. provisioning 转发到 Agent `/internal/wechat/login/status/:sessionId`。
6. Agent bridge 轮询 iLink API：
   - `wait` → 返回 `{status:'pending', message:'等待扫码'}`。
   - `scaned` → 返回 `{status:'pending', message:'已扫描，等待确认'}`。
   - `need_verifycode` → 返回 `{status:'need_verify_code', message:'请输入手机显示的数字'}`，前端弹输入框。
   - `confirmed` → bridge 执行 `saveWeixinAccount` + `registerWeixinAccountId` + `triggerWeixinChannelReload`，返回 `{status:'completed', accountId}`。
   - `expired` → bridge 刷新二维码（最多 3 次），返回新 `{sessionId, qrcodeUrl}`。
7. provisioning 收到 `completed`：
   - `UPDATE wechat_bindings SET status='bound', account_id=..., weixin_user_id=..., bound_at=NOW()`。
   - 等 Agent `/healthz` 200 + `channels status` 显示 weixin running → `status='active'`。
   - 写 `tenant_status_log` + `audit_logs`。
8. 前端显示"已绑定"。

### 5.2 解绑

1. 管理员点击"解绑"，二次确认。
2. `POST /v1/admin/tenants/:tid/wechat-binding/unbind`。
3. provisioning：
   - `UPDATE wechat_bindings SET status='disabling'`。
   - 调 Agent `/internal/wechat/unbind`（新增）：
     - `clearWeixinAccount(accountId)` 删除 state 文件。
     - `unregisterWeixinAccountId(accountId)`。
     - `triggerWeixinChannelReload()`。
   - `restartDeployment(agent)`（scale-0-then-1，让 gateway 重载干净配置）。
   - `UPDATE wechat_bindings SET status='disabled', unbound_at=NOW()`。
   - 写审计。
4. 前端显示"已解绑"。

### 5.3 重启恢复

Agent Pod 重启时：
1. `entrypoint.sh` 运行 `ensure_wechat_trusted`（幂等，marker 命中跳过）。
2. `write-config.mjs` 生成 `channels["openclaw-weixin"].enabled=true`。
3. OpenClaw gateway 启动 → 插件 `gateway.startAccount` 读 `accounts.json` → 恢复 monitor。
4. 无需重新扫码（token 在 PVC）。

---

## 6. 文件清单

### 6.1 新增

| 文件 | 作用 |
|------|------|
| `packages/dealclaw-agent/src/wechat-login-bridge.ts` | Agent 内微信扫码 HTTP 桥（调插件 login API + 长轮询 + 账号持久化） |
| `packages/dealclaw-agent/src/__tests__/wechat-login-bridge.test.ts` | 桥单测（mock iLink API） |
| `packages/provisioning-service/src/services/wechat-binding.ts` | 微信绑定/解绑编排（调 Agent 内部 API + DB + Redis + rollout） |
| `packages/provisioning-service/src/routes/wechat-binding.ts` | 控制台 REST API 路由 |
| `packages/provisioning-service/src/__tests__/wechat-binding.test.ts` | 绑定编排单测 |
| `packages/admin-web/src/components/WeChatScanModal.tsx` | 扫码弹窗（复用 FeishuAppScanModal 交互模式） |
| `packages/provisioning-service/src/services/wechat-redis.ts` | Redis 连接工厂（复用 email-webhook 参数模式，独立 key 前缀） |
| `db/migrations/xxx_wechat_bindings.sql` | 建表迁移 |

### 6.2 修改

| 文件 | 改动 |
|------|------|
| `packages/dealclaw-agent/Dockerfile` | bake `@tencent-weixin/openclaw-weixin@2.4.8` |
| `packages/dealclaw-agent/runtime/entrypoint.sh` | 新增 `ensure_wechat_trusted` + `wechat_bound` |
| `packages/dealclaw-agent/runtime/write-config.mjs` | 新增 `channels["openclaw-weixin"]` + plugin entries + dmScope |
| `packages/dealclaw-agent/src/app.ts` | 挂载 `/internal/wechat/*` 路由 |
| `packages/provisioning-service/src/app.ts` | 挂载 `/v1/admin/tenants/:tid/wechat-binding` 路由 |
| `packages/provisioning-service/src/services/provisioning.ts` | Agent Deployment envFrom 加 `DEALCLAW_WECHAT_BOUND` env |
| `packages/admin-web/src/pages/AgentDetailPage.tsx` | 新增微信绑定区块（状态 + 绑定/解绑按钮） |

### 6.3 不修改

- `packages/nexus-gateway/`：微信不走网关 WS，网关只管 LLM 出口代理。
- `packages/central-gateway/`：微信不走去入驻流程。

---

## 7. 实现顺序（任务列表）

| # | 任务 | 依赖 | 说明 |
|---|------|------|------|
| 1 | DB 迁移：`wechat_bindings` 表 | — | 基础 |
| 2 | `wechat-redis.ts` Redis 工厂 | email-webhook 参数模式参考 | 复用 Redis 实例 |
| 3 | `wechat-login-bridge.ts` Agent 内扫码桥 | 插件 2.4.8 源码 | 核心，含长轮询+持久化 |
| 4 | `wechat-login-bridge.test.ts` | 3 | mock iLink API |
| 5 | `app.ts` 挂载内部路由 | 3 | Agent bridge 入口 |
| 6 | `Dockerfile` bake 微信插件 | 插件版本 2.4.8 | 镜像层 |
| 7 | `entrypoint.sh` `ensure_wechat_trusted` | 6 | 启动层 |
| 8 | `write-config.mjs` `channels["openclaw-weixin"]` | 7 | 配置层 |
| 9 | `wechat-binding.ts` provisioning 编排 | 1,2,5 | 绑定/解绑逻辑 |
| 10 | `wechat-binding.test.ts` | 9 | mock Agent bridge |
| 11 | `routes/wechat-binding.ts` | 9 | REST API |
| 12 | `provisioning.ts` Agent env `DEALCLAW_WECHAT_BOUND` | 9 | 部署层 |
| 13 | `WeChatScanModal.tsx` | 11 | 前端 |
| 14 | `AgentDetailPage.tsx` 微信绑定区块 | 13 | 前端 |
| 15 | E2E 测试租户验证 | 全部 | 真实扫码 + 消息收发 + 重启恢复 + 解绑 |

---

## 8. 风险与阻断项

### P0（必须解决才能上线）

1. **插件 `waitForWeixinLogin` 的 stdin 依赖**：bridge 不能直接调用它。方案：bridge 自己复刻长轮询逻辑（从插件源码 `pollQRStatus` 复制），不调 `waitForWeixinLogin`。**需验证**：`pollQRStatus` 和 `apiGetFetch` 是否是插件导出的 API，还是内部函数。如果是内部的，需要从 tgz 复制逻辑到 bridge。
2. **iLink API 出网**：Agent Pod 需要访问 `ilinkai.weixin.qq.com` 和 `novac2c.cdn.weixin.qq.com`。需确认 NetworkPolicy 允许。
3. **验证码交互**：微信扫码可能要求手机输入数字验证码（`need_verifycode` 状态）。bridge 必须支持 HTTP 提交验证码，前端必须展示输入框。
4. **二维码刷新**：插件最多刷新 3 次。bridge 必须处理 `expired` → 刷新 → 返回新 session，前端必须能切换二维码。
5. **真实 PoC 验证**：在隔离测试租户完成真实扫码、消息收发、重启恢复、解绑，才能灰度。

### P1

6. **provisioning 多副本**：扫码会话的 `activeLogins` 在 Agent Pod 内，provisioning 轮询需要路由到同一个 Agent Pod（Service 默认负载均衡）。由于 Agent 通常单副本（RWO PVC），这不是问题；但需确认。
7. **Agent scale-0**：如果租户 Agent 被 scale-0，扫码无法执行。绑定前需确认 Agent 运行中。
8. **插件版本兼容**：2.4.8 peerDeps `openclaw>=2026.5.12`，当前镜像 2026.7.1 满足。但 2.4.6 有 SDK 路径问题，必须用 2.4.8。
9. **token 失效**：微信 token 可能因长期未活动、风控、异地登录失效。插件没有自动重新扫码能力，需要产品接受"token 失效后需管理员重新扫码"。

### P2

10. **多账号**：插件支持多账号，但当前方案单租户单绑定。多账号需扩展 `wechat_bindings` 去掉 UNIQUE(tenant_id)。
11. **群聊**：插件能力元数据只声明 `direct`，群聊不支持。

---

## 9. 测试策略

### 9.1 单测

- `wechat-login-bridge.test.ts`：mock iLink API，覆盖 start/status/cancel/verify-code/expired/refresh/confirmed→持久化。
- `wechat-binding.test.ts`：mock Agent bridge，覆盖绑定/解绑/重复绑定/跨租户冲突/并发锁/状态机。
- `write-config-wechat.test.ts`：覆盖 wechatBound=true/false 时 `channels["openclaw-weixin"]` 生成与否、dmScope 切换。

### 9.2 集成

- Agent bridge + 插件真实安装（隔离容器）+ mock iLink 服务器。
- provisioning + Agent bridge + Redis + Postgres。

### 9.3 E2E（隔离测试租户）

1. 真实微信测试账号扫码绑定。
2. 私聊文本/媒体收发。
3. Agent `/execute` → LLM → 微信回复。
4. 计费落 `llm_usage_events`。
5. Agent Pod 重启后无需重新扫码。
6. 解绑后微信消息不可达。
7. 重新绑定新账号。

---

## 10. 与飞书方案的对齐检查

| 检查项 | 飞书 | 微信（本方案） | 对齐 |
|--------|------|---------------|------|
| 插件 bake 进 Dockerfile | ✅ `@openclaw/feishu@2026.7.1` | ✅ `@tencent-weixin/openclaw-weixin@2.4.8` | ✅ |
| entrypoint trusted install | ✅ `ensure_feishu_trusted` | ✅ `ensure_wechat_trusted` | ✅ |
| write-config channels | ✅ `channels.feishu` | ✅ `channels["openclaw-weixin"]` | ✅ |
| plugin entries/allow | ✅ `feishu` | ✅ `openclaw-weixin` | ✅ |
| env-driven 绑定开关 | `DEALCLAW_APP_ID/SECRET` | `DEALCLAW_WECHAT_BOUND=1` | ✅ |
| DB 绑定记录 | `tenants.app_id/app_secret` | `wechat_bindings` 独立表 | ⚠️ 不同（微信无 appSecret 可存） |
| K8s Secret | `dealclaw-bot-{tid}` (appId/secret) | 不需要（token 在 PVC） | ⚠️ 不同 |
| 扫码执行位置 | provisioning 进程内 | Agent Pod 内 bridge | ⚠️ 不同（微信必须） |
| 消息面 owner | Agent (openclaw plane) | Agent (openclaw plane) | ✅ |
| rollout 方式 | restartDeployment(agent) | restartDeployment(agent) | ✅ |
| 解绑保留 gateway | ✅ | ✅ | ✅ |
