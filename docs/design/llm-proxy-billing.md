# 设计：nexus-gateway 代理大模型 API + 全量 Token 记账（P1）

> 状态：已评审通过（2026-08-24）。本文档记录 P1 阶段的架构决策与实现清单。
> P2（飞书直连 OpenClaw 插件）见文末「P2 展望」，另行立项。

## 1. 背景与目标

- **记账**：每个租户 agent 的大模型调用（输入 token / 输出 token）需要全量精确记账，
  覆盖 chat、cron、主动任务、工具循环每一轮 LLM 调用，以及 bridge 超时后的「孤儿消耗」。
- **拦截点后移**：余额拦截从「消息一进网关」移到「大模型调用出口」——不再依赖消息入口
  的关键词嗅探，cron/主动任务的 LLM 消耗同样被拦截。
- **聊天体验升级（P2）**：为飞书直连 OpenClaw 官方插件铺路——增值逻辑（记账/拦截/审计）
  收口到 LLM 出口网关后，消息面可以整体替换而不丢失商业能力。

### 已确认的三个决策

| 决策点 | 结论 |
|---|---|
| API Key 归属 | **Authorization 直通**：真实 key 仍写入租户 tenant-config Secret，网关原样转发，零改动分发链路 |
| web 平台租户覆盖 | **always-create 网关**：所有租户（含 web 平台）都创建 nexus-gateway；非 IM 平台跳过飞书 WS 启动 |
| 余额拦截 | **P1 一起做**：「查余额」关键词与余额不足拦截都迁到 proxy 合成响应，消息入口拦截同步下线 |

## 2. 架构

```
飞书/网页 chat ──► nexus-gateway(消息面, 不变)
                      │ POST /execute
                      ▼
               dealclaw-agent ── OpenClaw 网关(18790)
                      │  baseUrl = http://nexus-gateway-<t>:8080/v1/llm/<provider>
                      ▼
        nexus-gateway LLM 透明代理  /v1/llm/:provider/*
          ├─ 余额不足 ──► 合成 SSE 响应（提示充值），不调上游，记账 status=blocked
          ├─ 「查余额」关键词 ──► 合成余额回复，零 token 成本
          └─ 正常 ──► 流式直通上游（Authorization 原样转发）
                 ├─ tee SSE 末块 usage（OpenClaw 主动带 stream_options.include_usage）
                 └─ fire-and-forget POST credits-ledger /v1/billing/llm-usage
```

### 数据流要点

1. **URL 重写发生在推送时**：`pushLlmProviders` 写租户 tenant-config 时把每个 provider 的
   baseUrl 重写为 `http://nexus-gateway-<tenantId>:8080/v1/llm/<name>`（同 namespace 短域名）。
   真实 apiKey 保留在 blob 中（Authorization 直通）。OpenClaw / write-config.mjs **零改动**。
2. **上游映射在网关侧**：provisioning 同时写租户 namespace 的 `llm-proxy-config` Secret
   （`LLM_UPSTREAMS` = JSON `{<providerName>: <真实baseUrl>}`），gateway envFrom 注入。
   管理后台改供应商库 → 推送时同步更新该 Secret 并滚动 gateway。
3. **记账表**：credits-ledger 新表 `llm_usage_events`（与 skill_billing_events 语义分离），
   只记 token 不折 credits（shadow 模式）；是否折算成 credits 扣费是后续产品决策。

## 3. 各模块改动清单

### 3.1 credits-ledger

- `db/migrate.ts`：新表
  ```sql
  CREATE TABLE llm_usage_events (
    id            VARCHAR(64) PRIMARY KEY,
    tenant_id     VARCHAR(64) NOT NULL,
    account_id    VARCHAR(64) NOT NULL,
    provider      VARCHAR(64) NOT NULL,
    model         VARCHAR(128) NOT NULL,
    input_tokens  BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens  BIGINT NOT NULL DEFAULT 0,
    latency_ms    INTEGER,
    status        VARCHAR(16) NOT NULL DEFAULT 'ok',   -- ok | error | blocked | synthesized
    source        VARCHAR(32) NOT NULL DEFAULT 'agent', -- agent | proxy
    request_id    VARCHAR(128),                         -- 幂等键（可选）
    metadata      JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- 索引：(tenant_id, created_at DESC)、(created_at)、(provider, model)
  -- request_id 唯一索引（幂等：ON CONFLICT DO NOTHING）
  ```
- 新路由（service token 鉴权，挂 requireServiceOrAdmin 层下）：
  - `POST /v1/billing/llm-usage` — 网关上报（request_id 幂等）
  - `GET /v1/billing/llm-usage/summary?tenantId=&days=` — 单租户聚合（按天/按模型）
  - `GET /v1/billing/llm-usage/tenants?days=` — 全租户聚合（管理页用）

### 3.2 nexus-gateway

- `config.ts`：platform 增加 `'web'`（不再对非 IM 平台 crash）；新增
  `llmUpstreams`（解析 env `LLM_UPSTREAMS` JSON）。
- 新 `services/llm-proxy.ts`：`app.all('/v1/llm/:provider/*')`，
  **注册在 globalLimiter 与全局 json parser 之前**（LLM 上下文可超 1MB，用
  `express.raw({ type: '*/*', limit: '16mb' })`；且不能被 100 req/15min 限流掐住）。
  - 上游解析：`LLM_UPSTREAMS[provider]`，未配置 → 404。
  - 余额预检：`GET /v1/accounts/acct_<t>/balance`，15s 内存缓存，**fail-open**（ledger 不可达
    不阻断 LLM 调用；记账本就是 fire-and-forget）。
  - 关键词合成：请求体末条 user 消息命中余额查询模式 → 合成回复（带余额），status=synthesized。
  - 余额不足（available ≤ 0）→ 合成充值提示，status=blocked。
  - 合成响应：`stream:true` 时输出合法 openai chat.completion.chunk SSE（含 usage 末块 +
    [DONE]）；非流式输出完整 JSON。模型收到的是「正常回复」，工具循环自然终止。
  - 正常代理：转发原始字节（Authorization 直通），流式 tee：边转发边缓存尾部 ~64KB，
    结束后解析末块 usage 上报；非流式整体缓冲后转发 + 上报。
  - 上游错误：透传状态码与 body，上报 status=error。
- `app.ts`：**删除 webhook 路径的余额查询拦截段**（拦截点已迁至 proxy）；
  余额格式化辅助函数迁至 llm-proxy 复用。
- `index.ts`：无需改（ws-client 已有 `!appId` 安全跳过）。

### 3.3 provisioning-service

- `provisioning.ts`：
  - 网关创建不再限制 `platform !== 'web'`——所有租户创建（web 平台 DEALCLAW_PLATFORM=web，
    bot Secret 本就是占位值，WS 自动跳过）。
  - 网关 envFrom 增加 `llm-proxy-config` Secret；资源上调
    requests 200m/256Mi → limits 1000m/512Mi（SSE 直通余量）。
  - 创建 Secret `llm-proxy-config`（初始 `{}`，推送供应商库时更新）。
- `k8s-client.ts`：新增 `patchDeploymentEnvFromSecret(ns, name, secretName)`——
  读现有 envFrom，已含则跳过，否则 PATCH 合并（存量网关补挂 Secret 用）。
- `llm-providers.ts` `pushLlmProviders`：
  - 写 tenant-config 的 blob 中 baseUrl 重写为代理地址（真实 baseUrl 转存
    llm-proxy-config Secret 的 LLM_UPSTREAMS）。
  - 滚动重启 agent 之外，同时滚动 gateway（envFrom/上游映射变更）。
- `feishu-binding.ts`：
  - bind：网关 Deployment 增加 llm-proxy-config envFrom（与 provisioning 一致）。
  - **unbind：不再删除网关 Deployment**（它是 LLM 出口）——改为把 bot Secret 置占位值 +
    滚动重启（WS 拿占位凭据取 token 失败自动不启动），DB platform 回 'web'。
- 新路由 `GET /v1/admin/llm-usage`（proxy credits-ledger，带 service token），
  供 admin-web 展示。

### 3.4 admin-web

- `LlmProvidersPage`：新增「用量汇总」卡片（近 7 天各租户 calls / 输入 / 输出 token）。
- `AgentDetailPage`：模型选择卡片下方追加本租户用量摘要（今日/近 7 天）。

### 3.5 dealclaw-agent

**零改动**（baseUrl 由 blob 驱动；write-config 本就支持 http:// 的 baseUrl）。

## 4. 关键行为矩阵

| 场景 | 行为 | 记账 |
|---|---|---|
| 正常 chat / cron / 工具循环 | 流式直通上游 | ok：input/output tokens |
| 「查余额/用量」关键词 | 合成余额回复，不调上游 | synthesized：0 token |
| 余额 ≤ 0 | 合成充值提示，不调上游 | blocked：0 token |
| 上游报错（4xx/5xx） | 透传给 OpenClaw | error：latency + status |
| ledger 不可达 | 放行（fail-open），上报失败仅日志 | 尽力而为 |
| provider 不在 LLM_UPSTREAMS | 404 | 无 |

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 网关成为 LLM 唯一出口，单点 | 资源上调 + 滚动重启（OpenClaw 自带重试）；后续可加 PDB |
| 网关重启中断进行中的流 | OpenClaw transport 有重试；记账靠 tee 已完成部分丢失可接受（transcript 可对账） |
| 请求体超 1MB | proxy 路由独立 raw body 16MB，不走全局 json parser |
| 限流误伤 LLM 调用 | proxy 路由注册在 globalLimiter 之前 |
| 存量网关缺 envFrom/代理 Secret | pushLlmProviders 时 patch envFrom + putSecret + 滚动，幂等 |
| 旧 agent 镜像 + 新 blob（代理 URL） | 无影响：write-config 旧版同样接受 http baseUrl |

## 6. 验证计划

1. 单测：ledger 记账幂等/聚合；gateway proxy（合成/直通/tee usage/错误透传）；
   provisioning 重写/patch/unbind。
2. 构建 #59 发布三服务后：
   - `PUT /v1/admin/llm-providers` 触发全租户推送 → 检查 tenant-config（代理 URL）+
     llm-proxy-config（真实 URL）+ gateway/agent 双滚动。
   - 测试租户发飞书消息 → 观察 `llm_usage_events` 落行、openclaw.json providers 的
     baseUrl 为代理地址、回复正常。
   - 发「查余额」→ 秒回余额（synthesized 落行）。
   - （可选）把测试租户余额清零 → 验证 blocked 合成提示。
3. 对账：拉测试租户 OpenClaw transcript 的 entry.usage 与 llm_usage_events 汇总比对。

## 7. P2 展望（另行立项，本文档不实施）

飞书直连 `@openclaw/feishu` 官方插件：插件预装 agent 镜像 → write-config 生成
channels.feishu → 停 nexus-gateway 该 app 的 WS 连接（避免双客户端竞争分发）→
im_open_id 回写迁插件 message_received 钩子 → 生命周期通知改 `openclaw message` CLI →
退役 nexus-gateway 消息面。前置验证：feishu target 在 message CLI 的格式。
