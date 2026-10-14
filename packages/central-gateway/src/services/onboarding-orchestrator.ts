/**
 * Onboarding Orchestrator
 *
 * 全自动入驻编排引擎。在 registerApp 完成后异步执行:
 *   1. 收到 App ID + Secret
 *   2. 调用 Provisioning Service 创建租户 (唯一 tenantId)
 *   3. 获取 tenant_access_token
 *   4. 配置飞书 Bot 事件订阅 webhook
 *   5. 发送欢迎消息
 *   6. 标记会话完成
 */

import type { RegistrationSession } from './feishu-register.js';
import { completeProvisioning } from './feishu-register.js';

export interface OrchestratorConfig {
  provisioningServiceUrl: string;
  provisioningApiToken?: string;
  baseUrl: string;
  tenantSecrets?: Record<string, string>;
}

export interface OnboardingResult {
  ok: boolean;
  tenantId?: string;
  appId?: string;
  botWebhookUrl?: string;
  tenantAccessToken?: string;
  welcomeMessage?: string;
  error?: string;
}

export async function orchestrateOnboarding(
  session: RegistrationSession,
  config: OrchestratorConfig,
): Promise<OnboardingResult> {
  const { appId, appSecret } = session;
  if (!appId || !appSecret) {
    return { ok: false, error: 'Missing app credentials from registration' };
  }

  try {
    // Step 1: Create tenant via provisioning-service (persists app_id + app_secret)
    const tenantResult = await createTenant(
      config.provisioningServiceUrl,
      appId,
      appSecret,
      config.provisioningApiToken,
      session.templateId,
      session.templateVersion,
    );
    if (!tenantResult.ok || !tenantResult.tenantId) {
      return { ok: false, error: tenantResult.error || 'Failed to create tenant' };
    }
    const tenantId = tenantResult.tenantId;

    // Bind only this scan's customer account, before welcoming the user. Never
    // copy a deployment-wide owner's account to a publicly created tenant.
    if (config.tenantSecrets) {
      const binding = await fetch(`${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/tenants/${encodeURIComponent(tenantId)}/secrets`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(config.provisioningApiToken ? { authorization: `Bearer ${config.provisioningApiToken}` } : {}) },
        body: JSON.stringify({ secrets: config.tenantSecrets }), signal: AbortSignal.timeout(10000),
      });
      if (!binding.ok) return { ok: false, error: 'MAKARON_ACCOUNT_BIND_FAILED' };
    }

    // Step 2: Get tenant_access_token
    const tokenResult = await getTenantAccessToken(appId, appSecret);
    const tenantAccessToken = tokenResult.ok ? tokenResult.token : undefined;
    if (!tenantAccessToken) {
      console.warn('Tenant access token failed:', tokenResult.error);
    }

    // Fallback: re-assert app credentials via PUT (primary write happens in createTenant)
    await persistAppCredentials(
      config.provisioningServiceUrl,
      tenantId,
      { appId, appSecret },
      config.provisioningApiToken,
    );

    // Step 3: Configure Feishu event subscription via API
    const botWebhookUrl = `${config.baseUrl}/v1/agent/${tenantId}/webhook`;
    let eventConfigOk = false;
    if (tenantAccessToken) {
      eventConfigOk = await configureEventSubscription(appId, tenantAccessToken, botWebhookUrl);
      if (!eventConfigOk) {
        console.log('[onboarding] event subscription API not available, will use WSClient long-connection');
      }
    }

    // Step 4: Send welcome message
    if (tenantAccessToken && session.userOpenId) {
      const welcomeMessage = generateWelcome(session.templateName, tenantId, botWebhookUrl);
      await sendWelcomeMessage(session.userOpenId, tenantAccessToken, welcomeMessage);
    }

    // Nexus-gateway Pod will auto-start WSClient on startup.
    // No need for central-gateway to manage WS connections.
    completeProvisioning(session, tenantId, botWebhookUrl);

    return {
      ok: true,
      tenantId,
      appId,
      botWebhookUrl,
      tenantAccessToken: tenantAccessToken || undefined,
      welcomeMessage: `🎉 Bot 已就绪！

✅ 租户: ${tenantId}
🔗 Webhook: ${botWebhookUrl}
${eventConfigOk ? '✅ 事件订阅已自动配置' : '⚠️ 事件订阅自动配置失败，请检查飞书后台'}`,
    };
  } catch (err: any) {
    console.error('Onboarding orchestration failed:', err);
    return { ok: false, error: err.message || 'Orchestration failed' };
  }
}

/** Get tenant_access_token for the self-built app. */
async function getTenantAccessToken(
  appId: string,
  appSecret: string,
): Promise<{ ok: boolean; token?: string; error?: string }> {
  try {
    const res = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: `Tenant token: ${err.msg || res.status}` };
    }

    const data = await res.json();
    return { ok: true, token: data.tenant_access_token };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/** Configure event subscription webhook URL via Feishu API. */
async function configureEventSubscription(
  appId: string,
  accessToken: string,
  webhookUrl: string,
): Promise<boolean> {
  try {
    // Try PATCHing the application with event config
    const res = await fetch(
      `https://open.feishu.cn/open-apis/application/v6/applications/${appId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          events_status: 'enable',
          event_config: {
            request_url: webhookUrl,
            events: ['im.message.receive_v1'],
          },
        }),
        signal: AbortSignal.timeout(5000),
      },
    );

    const data = await res.json();
    console.log('[event-config] response:', JSON.stringify(data).slice(0, 300));

    if (res.ok && data.code === 0) {
      console.log('[event-config] SUCCESS:', webhookUrl);
      return true;
    }

    console.warn('[event-config] API returned:', data.code, data.msg);
    return false;
  } catch (err: any) {
    console.warn('[event-config] error:', err.message);
    return false;
  }
}

/** Send welcome message via Bot API. */
async function sendWelcomeMessage(
  userOpenId: string,
  accessToken: string,
  message: string,
): Promise<void> {
  try {
    // The registerApp result identifies the person who scanned this QR code.
    const res = await fetch(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          receive_id: userOpenId,
          msg_type: 'text',
          content: JSON.stringify({ text: message }),
        }),
        signal: AbortSignal.timeout(5000),
      },
    );

    const respData = await res.json().catch(() => ({}));
    if (!res.ok || respData.code !== 0) {
      console.warn('Welcome message: HTTP', res.status, JSON.stringify(respData).slice(0, 200));
    } else {
      console.log('Welcome message sent');
    }
  } catch (err: any) {
    console.warn('Welcome message error:', err.message);
  }
}

async function createTenant(
  provisioningServiceUrl: string,
  appId: string,
  appSecret: string,
  provisioningApiToken?: string,
  templateId = 'dealclaw',
  templateVersion = 'dealclaw-base.v2',
): Promise<{ ok: boolean; tenantId?: string; error?: string }> {
  try {
    const res = await fetch(`${provisioningServiceUrl.replace(/\/$/, '')}/v1/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provisioningApiToken ? { Authorization: `Bearer ${provisioningApiToken}` } : {}),
      },
      body: JSON.stringify({
        companyName: '',
        contactEmail: '',
        planTier: 'starter',
        botAppId: appId,
        botAppSecret: appSecret,
        templateId,
        templateVersion,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      return { ok: false, error: `Provisioning: HTTP ${res.status} — ${errBody.message ?? ''}` };
    }

    const body = await res.json();
    return { ok: true, tenantId: body.tenant?.tenantId };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

function generateWelcome(templateName: string, tenantId: string, _webhookUrl: string): string {
  return `🎉 ${templateName} 已就绪！

✅ 你的专属 Agent 已创建
🆔 租户 ID: ${tenantId}

接下来我可以在飞书中直接与你对话。
现在可以直接给我发消息，开始聊天。`;
}

/** Start WebSocket long-connection — no webhook URL needed.
 * MOVED: WSClient now lives in nexus-gateway (per-tenant Pod).
 * See packages/nexus-gateway/src/ws-client.ts
 */

export function extractFeishuText(data: any): string {
  // The Lark SDK has emitted both an unwrapped event shape
  // ({ message, sender }) and wrapped webhook shapes
  // ({ event: { message } } / { data: { event: { message } } })
  // across versions and delivery modes. Accept all of them so a valid
  // user message never degrades into the empty-text chat fallback.
  const msg = data?.message ?? data?.event?.message ?? data?.data?.event?.message;
  if (!msg || (msg.msg_type && msg.msg_type !== 'text')) return '';

  try {
    const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
    if (typeof content?.text === 'string') return content.text.trim();
    if (typeof msg.text === 'string') return msg.text.trim();
    return '';
  } catch {
    return typeof msg.text === 'string' ? msg.text.trim() : '';
  }
}

async function persistAppCredentials(
  provisioningServiceUrl: string,
  tenantId: string,
  creds: { appId: string; appSecret: string },
  provisioningApiToken?: string,
) {
    try {
        const res = await fetch(provisioningServiceUrl.replace(/\/$/, '') + '/v1/tenants/' + tenantId + '/credentials', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...(provisioningApiToken ? { Authorization: `Bearer ${provisioningApiToken}` } : {}),
            },
            body: JSON.stringify(creds),
            signal: AbortSignal.timeout(3000),
        });
        if (res.ok) console.log('[onboarding] credentials persisted for', tenantId);
    } catch (e: any) { console.warn('[onboarding] persist failed:', e.message); }
}
