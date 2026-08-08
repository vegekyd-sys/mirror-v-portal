/**
 * Central Gateway — Channel Detection & Unified QR Routing
 * 
 * Detects the IM platform from User-Agent and routes to the appropriate OAuth flow.
 */

export type Platform = 'feishu' | 'dingtalk' | 'wecom' | 'wechat' | 'unknown';

export interface ChannelInfo {
  platform: Platform;
  userAgent: string;
  redirectUrl: string;
}

const UA_PATTERNS: Array<{ regex: RegExp; platform: Platform }> = [
  { regex: /Lark|Feishu|飞书/i, platform: 'feishu' },
  { regex: /DingTalk|钉钉/i, platform: 'dingtalk' },
  { regex: /wxwork|WeCom|企业微信/i, platform: 'wecom' },
  { regex: /MicroMessenger|微信(?!企业)/i, platform: 'wechat' },
];

export function detectPlatform(userAgent: string): Platform {
  for (const { regex, platform } of UA_PATTERNS) {
    if (regex.test(userAgent)) return platform;
  }
  return 'unknown';
}

/**
 * Generate OAuth redirect URLs for each platform.
 */
export function getRedirectUrl(platform: Platform, baseUrl: string, state: string): string {
  switch (platform) {
    case 'feishu':
      // registerApp QR code URL is generated server-side, redirect to onboarding page
      return `${baseUrl}/onboard/feishu?state=${encodeURIComponent(state)}`;
    case 'dingtalk':
      return `https://login.dingtalk.com/oauth2/auth` +
        `?response_type=code` +
        `&client_id=${process.env.DINGTALK_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(`${baseUrl}/onboard/dingtalk/callback`)}` +
        `&scope=openid` +
        `&state=${encodeURIComponent(state)}`;
    case 'wecom':
      return `https://open.weixin.qq.com/connect/oauth2/authorize` +
        `?appid=${process.env.WECOM_CORP_ID}` +
        `&redirect_uri=${encodeURIComponent(`${baseUrl}/onboard/wecom/callback`)}` +
        `&response_type=code` +
        `&scope=snsapi_base` +
        `&state=${encodeURIComponent(state)}#wechat_redirect`;
    default:
      return `${baseUrl}/onboard/unsupported`;
  }
}

/**
 * Full onboarding routing: detect → redirect.
 */
export function routeOnboarding(userAgent: string, baseUrl: string, state?: string): ChannelInfo {
  const platform = detectPlatform(userAgent);
  const s = state || generateState();
  return {
    platform,
    userAgent,
    redirectUrl: getRedirectUrl(platform, baseUrl, s),
  };
}

function generateState(): string {
  return `onboard_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
