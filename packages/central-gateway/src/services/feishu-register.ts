/**
 * Feishu RegisterApp Service
 *
 * 使用 lark.registerApp() SDK 实现飞书一键扫码入驻。
 * 纯 SDK 封装 + 日志 + session 管理。不手动实现 HTTP 调用。
 */

import * as lark from '@larksuiteoapi/node-sdk';

export type RegistrationStatus =
  | 'pending' | 'provisioning'
  | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface RegistrationSession {
  deviceCode: string;
  qrUrl: string;
  expireIn: number;
  status: RegistrationStatus;
  startedAt: Date;
  completedAt?: Date;
  appId?: string;
  appSecret?: string;
  tenantId?: string;
  webhookUrl?: string;
  error?: string;
  progress: number;
  _abortController: AbortController;
  _completionPromise?: Promise<void>;
}

// What the user sees inside Feishu at the moment they scan, and what Feishu
// pre-fills on its app-creation screen. Overridable so the identity can change
// without a redeploy. The default matches the seeded payload — a shipped name
// that contradicts the payload is worse than either one alone — and the
// description traces V's own Evolution Direction: Mirror, Match, Exceed.
const APP_PRESET = {
  name: process.env.FEISHU_APP_NAME || 'V from Versa',
  desc: process.env.FEISHU_APP_DESC || '自进化智能体',
  // 1-6 publicly reachable image URLs; the first is pre-selected. Without this
  // Feishu offers its own stock avatars and the agent has no face of its own.
  ...(process.env.FEISHU_APP_AVATAR
    ? { avatar: process.env.FEISHU_APP_AVATAR.split(',').map((u) => u.trim()).filter(Boolean) }
    : {}),
};

export async function startFeishuRegistration(
  onRegistered?: (session: RegistrationSession) => Promise<void>,
): Promise<RegistrationSession> {
  const abortController = new AbortController();

  const session: RegistrationSession = {
    deviceCode: '',
    qrUrl: '',
    expireIn: 600,
    status: 'pending',
    startedAt: new Date(),
    progress: 0,
    _abortController: abortController,
  };

  session._completionPromise = (async () => {
    try {
      console.log('[registerApp] starting SDK registerApp...');

      const result = await lark.registerApp({
        onQRCodeReady(info) {
          const dc = extractDeviceCode(info.url);
          session.deviceCode = dc;
          session.qrUrl = info.url;
          session.expireIn = info.expireIn;
          session.status = 'pending';
          session.progress = 5;
          console.log('[registerApp] QR ready, deviceCode:', dc);
        },
        onStatusChange(info) {
          // SDK 的 'polling' 表示轮询返回 authorization_pending，即用户【尚未】完成
          // 扫码确认（二维码生成后第一次轮询就会触发）。SDK 不会单独通知"已扫码"，
          // 因此这里保持 'pending'（等待扫码），不能映射成 'authorizing'（已扫码待确认），
          // 否则用户还没扫码页面就会显示"已扫码，等待确认"。
          if (info.status === 'polling' || info.status === 'slow_down' || info.status === 'domain_switched') {
            session.status = 'pending';
          }
          console.log('[registerApp] status change:', info.status);
        },
        appPreset: APP_PRESET,
        addons: {
          preset: true,
          // im:message:send_as_bot — 发消息；contact:user.base:readonly — 通讯录
          // 基本信息只读（feishu 插件解析发送者姓名必需，缺失会报 41050）。
          scopes: { tenant: ['im:message:send_as_bot', 'contact:user.base:readonly'], user: [] },
        } as lark.AppAddons,
        createOnly: true,
        signal: abortController.signal,
      });

      console.log('[registerApp] success, app_id:', result.client_id);
      // registerApp resolve 时飞书应用已创建完成（createOnly:true），
      // 不存在可观察的"创建中"阶段，因此直接进入租户编排/部署。
      session.appId = result.client_id;
      session.appSecret = result.client_secret;

      if (onRegistered) {
        session.status = 'provisioning';
        session.progress = 75;
        await onRegistered(session);
      } else {
        session.status = 'completed';
        session.progress = 100;
        session.completedAt = new Date();
      }
    } catch (err: any) {
      console.error('[registerApp] error:', err.code || 'no-code', err.message || err);
      if (err.code === 'abort') { session.status = 'cancelled'; session.error = 'Registration cancelled'; }
      else if (err.code === 'access_denied') { session.status = 'failed'; session.error = 'User denied access'; }
      else { session.status = 'failed'; session.error = `${err.code || 'error'}: ${err.message}`; }
    }
  })();

  return session;
}

export function pollRegistrationStatus(session: RegistrationSession) {
  switch (session.status) {
    case 'pending': return { progress: 5, message: '请用飞书 App 扫描二维码' };
    case 'provisioning': return { progress: 75, message: '应用创建成功，正在为你分配专属资源...' };
    case 'completed': return { progress: 100, message: '入驻完成！' };
    case 'failed': return { progress: 0, message: `入驻失败: ${session.error}` };
    case 'cancelled': return { progress: 0, message: '已取消' };
    case 'expired': return { progress: 0, message: '二维码已过期，请重新扫码' };
    default: return { progress: 0, message: '未知状态' };
  }
}

export function getRegistrationResult(session: RegistrationSession) {
  return {
    appId: session.appId,
    appSecret: session.appSecret,
    tenantId: session.tenantId,
    webhookUrl: session.webhookUrl,
    status: session.status,
  };
}

export function cancelRegistration(sessions: Map<string, RegistrationSession>, deviceCode: string) {
  const session = sessions.get(deviceCode);
  if (!session) return { ok: false };
  session._abortController.abort();
  sessions.delete(deviceCode);
  return { ok: true };
}

export function completeProvisioning(session: RegistrationSession, tenantId: string, webhookUrl: string) {
  session.tenantId = tenantId;
  session.webhookUrl = webhookUrl;
  session.status = 'completed';
  session.progress = 100;
  session.completedAt = new Date();
}

function extractDeviceCode(url: string): string {
  try {
    return new URL(url).searchParams.get('user_code') || '';
  } catch { return ''; }
}
