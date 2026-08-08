import type { Platform } from './channel.js';

export interface OnboardingRequest {
  platform: Platform;
  companyName: string;
  contactEmail: string;
  contactPhone?: string;
  planTier: 'starter' | 'pro' | 'enterprise';
  /** OAuth code from platform callback */
  oauthCode?: string;
}

export interface OnboardingResult {
  ok: boolean;
  tenantId: string;
  platform: Platform;
  botWebhookUrl: string;
  welcomeMessage: string;
  provisioning: any;
}

/**
 * Orchestrate the full onboarding flow:
 * 1. Create tenant via provisioning-service
 * 2. Generate bot webhook URL
 * 3. Return welcome message + next steps
 */
export async function onboardTenant(
  provisioningServiceUrl: string,
  baseUrl: string,
  request: OnboardingRequest,
): Promise<OnboardingResult> {
  // 1. Call provisioning-service to create tenant + K8s resources
  let provisioning: any = {};
  let tenantId = '';

  try {
    const res = await fetch(`${provisioningServiceUrl.replace(/\/$/, '')}/v1/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: request.companyName,
        contactEmail: request.contactEmail,
        contactPhone: request.contactPhone,
        planTier: request.planTier,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`Provisioning failed: HTTP ${res.status} — ${errBody.message ?? ''}`);
    }

    provisioning = await res.json();
    tenantId = provisioning.tenant?.tenantId ?? '';
  } catch (err: any) {
    console.error('Provisioning error:', err.message);
    return {
      ok: false,
      tenantId: '',
      platform: request.platform,
      botWebhookUrl: '',
      welcomeMessage: `Onboarding failed: ${err.message}. Please try again or contact support.`,
      provisioning: { error: err.message },
    };
  }

  // 2. Generate bot webhook URL (tenant-specific gateway endpoint)
  const botWebhookUrl = `${baseUrl}/v1/agent/${tenantId}/webhook`;

  // 3. Platform-specific welcome message
  const welcomeMessage = generateWelcomeMessage(request.platform, {
    companyName: request.companyName,
    planTier: request.planTier,
    botWebhookUrl,
    tenantId,
  });

  return {
    ok: true,
    tenantId,
    platform: request.platform,
    botWebhookUrl,
    welcomeMessage,
    provisioning,
  };
}

/**
 * Generate platform-specific welcome message.
 */
function generateWelcomeMessage(
  platform: Platform,
  ctx: { companyName: string; planTier: string; botWebhookUrl: string; tenantId: string },
): string {
  const messages: Record<Platform, string> = {
    feishu: `🎉 Hi ${ctx.companyName}！DealClaw AI 销售助手已就绪！

✅ 你的专属 Agent 已部署
📊 当前套餐：${planLabel(ctx.planTier)}
🔗 Bot Webhook：${ctx.botWebhookUrl}

接下来：
1. 复制上方 webhook 地址
2. 在飞书开放平台「事件订阅」中填入
3. 验证通过后即可使用

有问题随时联系！`,

    dingtalk: `🎉 Hi ${ctx.companyName}！DealClaw AI 销售助手已就绪！

✅ 你的专属 Agent 已部署
📊 当前套餐：${planLabel(ctx.planTier)}
🔗 Bot Webhook：${ctx.botWebhookUrl}

接下来：
1. 在钉钉开放平台配置回调地址
2. 授权接入后即可使用

有问题随时联系！`,

    wecom: `🎉 Hi ${ctx.companyName}！DealClaw AI 销售助手已就绪！

✅ 你的专属 Agent 已部署
📊 当前套餐：${planLabel(ctx.planTier)}
🔗 Bot Webhook：${ctx.botWebhookUrl}

接下来：
1. 在企业微信管理后台配置回调 URL
2. 授权接入后即可使用

有问题随时联系！`,

    wechat: `🎉 Hi ${ctx.companyName}！DealClaw AI 销售助手已就绪！

✅ 你的专属 Agent 已部署
📊 当前套餐：${planLabel(ctx.planTier)}
🔗 Bot Webhook：${ctx.botWebhookUrl}

注意：微信个人号不支持独立 Bot，请联系我们获取企业版接入方案。`,

    unknown: `🎉 Hi ${ctx.companyName}！DealClaw AI 销售助手已就绪！

✅ 你的专属 Agent 已部署
📊 当前套餐：${planLabel(ctx.planTier)}
🔗 Bot Webhook：${ctx.botWebhookUrl}

请根据你的 IM 平台配置相应的 webhook 回调。`,
  };

  return messages[platform] ?? messages.unknown;
}

function planLabel(tier: string): string {
  const labels: Record<string, string> = {
    starter: 'Starter (免费试用)',
    pro: 'Pro (专业版)',
    enterprise: 'Enterprise (企业版)',
  };
  return labels[tier] ?? tier;
}
