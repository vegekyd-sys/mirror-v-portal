# 05 — Central Gateway + Onboarding 系分

> 优先级: P2 | 部署: 中央调度层 | 语言: TypeScript + Node.js
> 前置依赖: Provisioning Service (P1), Credits Ledger (P0)
> 版本: v0.2 | 2026-07-29 — 改为飞书一键扫码入驻，移除表单页

## 1. 设计原则

**零表单入驻**：客户不需要填写任何表单。扫码 → 飞书 App 内确认 → 10 秒拥有自己的 AI 外贸助手。客户信息由 DealClaw Agent 在后续对话中收集。

这完全不同于传统的 SaaS onboarding（填信息 → 验证邮箱 → 等开通）。参考 Hermes 使用飞书开放平台 `registerApp()` SDK 的一键扫码体验。

## 2. 职责边界

### Central Gateway
融合二维码入口。接收用户扫码请求，调用 `lark.registerApp()` 生成设备授权链接，返回二维码给用户。

### Onboarding 编排引擎
不跟客户聊天，只负责自动编排开通步骤。收到 `registerApp()` 回调后：
1. 创建租户（唯一 tenant_id）
2. 关联飞书 App ID/Secret
3. 调用 Provisioning Service 分配运行时资源（创建租户专用 dealclaw-agent）
4. 绑定 Bot webhook → 共享 Gateway（按 tenant_id 路由到专用 agent）
5. 发送欢迎语

```
客户飞书扫码
     │
     ▼
Central Gateway ── ① 生成 registerApp 二维码
     │
     ▼
客户在飞书 App 确认创建
     │
     ▼
registerApp() 返回 App ID + Secret
     │
     ▼
Onboarding 编排:
  ② 创建租户 (唯一ID)
  ③ 存储 App 凭证
  ④ 调用 Provisioning → K8s 资源
  ⑤ 等待 Pod 就绪
  ⑥ 绑定 Bot webhook
  ⑦ 发送欢迎语
     │
     ▼
客户在飞书内开始对话
     │
     ▼
DealClaw Agent 收集企业信息
```

## 3. Central Gateway API

### 3.1 获取扫码二维码

```
GET /onboard

→ 调用 lark.registerApp()
→ 获取 device authorization URL (info.url)
→ 生成二维码返回给用户
→ onQRCodeReady 回调触发后，开始轮询设备授权状态
```

**响应（给前端/用户）**：
```json
{
  "qrUrl": "https://open.feishu.cn/page/launcher?user_code=XXXX&from=sdk&source=node-sdk&tp=sdk",
  "expireIn": 600,
  "status": "pending"
}
```

### 3.2 轮询入驻状态

```
GET /onboard/status?deviceCode=XXXX

→ 返回入驻进度
```

**响应**：
```json
{
  "status": "completed",
  "tenantId": "14fe0d33",
  "appId": "cli_xxxx",
  "webhookUrl": "https://dealclaw.cn/v1/agent/14fe0d33/webhook"
}
```

状态值：`pending`（等待扫码）→ `authorizing`（用户已扫码授权）→ `provisioning`（创建资源中）→ `completed`（完成）

## 4. registerApp() 实现（核心）

```typescript
import * as lark from '@larksuiteoapi/node-sdk';

export async function onboardWithFeishu(): Promise<OnboardingResult> {
  // Step 1: 调用 registerApp — 生成二维码，等待用户确认
  const result = await lark.registerApp({
    onQRCodeReady(info) {
      // info.url → 二维码 URL，有效期 info.expireIn 秒
      // 这个 URL 发给前端生成二维码展示给用户
      console.log('QR ready:', info.url);
    },
    appPreset: {
      name: 'DealClaw AI销售助手',
      desc: 'AI-powered sales assistant for global trade — 全天候帮你找客户、写邮件、跟线索',
      avatar: 'https://dealclaw.cn/logo.png',
    },
    addons: {
      preset: true,  // 使用飞书默认 Agent 模板（包含所有常用权限）
    },
    createOnly: true,  // 只允许创建新应用，不可选择已有应用
  });

  // Step 2: 用户确认后，SDK 自动返回凭证
  const appId = result.client_id;
  const appSecret = result.client_secret;

  // Step 3: 创建租户
  const tenant = await createTenant({
    platform: 'feishu',
    botAppId: appId,
    botAppSecret: appSecret,  // 加密存储，不落明文盘
  });

  // Step 4: 分配运行时资源
  await provisioningService.createTenantResources(tenant.id);

  // Step 5: 等待 Pod 就绪 + 绑定 webhook
  await waitForPodReady(tenant.id);
  await bindBotWebhook(tenant.id, appId, appSecret);

  // Step 6: 发送欢迎语
  await sendWelcomeMessage(tenant.id, appId);

  return {
    tenantId: tenant.id,
    appId,
  };
}
```

## 5. 入驻流程（时序图）

```
用户               Central Gateway       lark SDK         Provisioning      DBAgent
 │                       │                   │                 │               │
 │ 飞书扫码                │                   │                 │               │
 │──────────────────────▶│                   │                 │               │
 │                       │ registerApp()     │                 │               │
 │                       │──────────────────▶│                 │               │
 │                       │  qrUrl            │                 │               │
 │                       │◀ ─ ─ ─ ─ ─ ─ ─ ─ │                 │               │
 │                       │                   │                 │               │
 │◀── 飞书创建确认页 ────│                   │                 │               │
 │ 「DealClaw AI销售助手」 │                  │                 │               │
 │                       │                   │                 │               │
 │ 点击确认               │                   │                 │               │
 │──────────────────────▶│                   │                 │               │
 │                       │ 轮询设备授权状态    │                 │               │
 │                       │──────────────────▶│                 │               │
 │                       │ App ID + Secret   │                 │               │
 │                       │◀ ─ ─ ─ ─ ─ ─ ─ ─ │                 │               │
 │                       │                   │                 │               │
 │                       │── POST /v1/tenants (创建租户)       │               │
 │                       │──────────────────────────────────▶│               │
 │                       │◀── tenantId, agent_service ────────│               │
 │                       │                   │                 │               │
 │                       │── 数据库写入 (tenant + credits_account)            │
 │                       │──────────────────────────────────────────────────▶│
 │                       │                   │                 │               │
 │                       │── 绑定 Bot webhook (通过飞书 API)                  │
 │                       │                   │                 │               │
 │                       │── 发送欢迎语 (通过客户 Bot)                        │
 │                       │                   │                 │               │
 │◀── "AI外贸助手已就绪" ─│                   │                 │               │
 │    + 开始对话          │                   │                 │               │
 │                       │                   │                 │               │
 │── "我是杭州奥创天下" ─▶│                   │                 │               │
 │                       │                   │                 │               │
 │                       │  DealClaw Agent 收集企业信息 ──────────────────────▶│
 │                       │                   更新 DB (company_name/email/...)  │
```

## 6. 钉钉/企业微信流程差异

### 6.1 平台能力对比

飞书是唯一支持「客户扫码即创建自建应用」的平台（`registerApp()` SDK，OAuth Device Authorization Grant）。钉钉和企业微信的自建应用均需管理员在后台手动操作，但各有其可自动化路径。

| 能力 | 飞书 | 钉钉 | 企业微信 |
|------|------|------|---------|
| 扫码创建自建应用 | ✅ registerApp SDK | ❌ | ❌ |
| 第三方/服务商应用扫码安装 | N/A | ❌ | ✅ 第三方应用推广码 |
| OAuth 用户授权 | ✅ | ✅ 扫码登录 | ✅ 扫码登录 |
| 事件订阅 webhook | ✅ API | ✅ 后台配置 | ✅ 后台配置 |
| 长连接接收事件 | ✅ WSClient | ❌ | ❌ |

### 6.2 钉钉方案

钉钉无 `registerApp` 等价物，需要在开发者后台手动创建机器人。客户入驻时：

1. 页面引导客户复制后台链接 → 打开钉钉开放平台
2. 管理员扫码登录 → 创建企业内部应用 → 获取 AppKey/AppSecret
3. 回到入驻页面填入凭证 → 完成租户创建

给客户的后台直达链接：`https://open-dev.dingtalk.com/fe/app#/corp/app`

### 6.3 企业微信方案

企微第三方应用支持扫码安装推广：

1. 在 `open.work.weixin.qq.com` 注册为第三方服务商
2. 上线应用 → 生成推广二维码
3. 客户管理员扫码 → 一键安装授权
4. 安装回调 → 自动创建租户

> 需走应用市场审核流程，审核通过后客户可扫码安装。适合正式商业化推广，不适合快速验证。

### 6.4 入驻方式对比

| 步骤 | 飞书 | 钉钉 | 企业微信 |
|------|------|------|---------|
| 入口 | `/onboard` → registerApp 二维码 | `/onboard` → 引导页 + 后台链接 | `/onboard` → 第三方应用推广码 |
| Bot 创建 | registerApp 一键创建 | 管理员后台手动创建 | 扫码安装第三方应用 |
| 用户操作 | 扫码 → 确认 | 打开链接 → 后台创建 → 回填凭证 | 扫码 → 确认安装 |
| 入驻耗时 | ~10 秒 | ~3-5 分钟 | ~30 秒 |
| 自动化程度 | 全自动 | 半自动（需回填） | 全自动（需上线审核） |

> 飞书是主力渠道，企微第三方应用作为第二优先（需上线审核），钉钉作为辅线（引导+回填）。

## 7. 多平台二维码调度

GET `/onboard` 根据 User-Agent 自动路由到对应平台流程：

| User-Agent 特征 | 平台 | 行为 |
|-----------------|------|------|
| `Lark/` 或 `Feishu/` | 飞书 | 调用 registerApp() 生成飞书扫码链接 |
| `DingTalk/` 或 `钉钉` | 钉钉 | 重定向钉钉 OAuth 授权页 |
| `wxwork/` 或 `企业微信` | 企业微信 | 重定向企微 OAuth 授权页 |
| `MicroMessenger/` | 微信 | 展示"暂不支持，请使用飞书扫码"引导页 |
| 其他 (浏览器) | 未知 | 展示平台选择页 + 引导下载飞书 |

## 8. 输入安全

Onboarding 编排引擎不直接接收用户输入。所有入参来自 `lark.registerApp()` 返回的 App ID/Secret，以及服务端计算的默认值。

```typescript
function buildProvisioningRequest(result: RegisterAppResult): ProvisioningRequest {
  return {
    // 以下值均由 SDK 返回或服务端计算，非用户输入
    platform: 'feishu',
    botAppId: result.client_id,              // SDK 返回
    botAppSecret: encrypt(result.client_secret), // 加密存储
    planTier: 'starter',                     // 默认套餐
    initialCredits: PLAN_CREDITS.starter,    // 服务端计算
    k8sDryRun: isDryRunMode(),              // 环境判断
  };
}
```

客户的公司名、邮箱等信息由 DealClaw Agent 在后续对话中收集，不在入驻流程中要求。

## 9. 部署规格

```yaml
# Central Gateway
cpu: 200m
memory: 256Mi
replicas: 2
port: 80

环境变量:
  NODE_ENV: production
  DATABASE_URL: postgresql://...
  PROVISIONING_SERVICE_URL: http://provisioning:8082

# 注意：registerApp() 不需要母应用 App ID/Secret
# SDK 使用 OAuth 2.0 Device Authorization Grant (RFC 8628)
# 无需预注册母应用
```

## 10. 与旧版 v0.1 的关键变更

| 旧版 (v0.1) | 新版 (v0.2) |
|------------|------------|
| HTML 表单页填公司信息 | 飞书扫码直接创建应用 |
| 用户填 6 个字段 | 用户只需点确认 |
| 表单停留 1-2 分钟 | 扫码到完成 ~10 秒 |
| /onboard/start POST 创建租户 | registerApp() 回调后异步创建 |
| 公司信息在入驻时收集 | Agent 对话中收集 |
| 用户需手动去开放平台配权限 | SDK 自动预配置权限和事件订阅 |
| 应用创建和租户创建分离 | 一气呵成 |
