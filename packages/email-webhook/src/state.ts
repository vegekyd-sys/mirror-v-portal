/** 进程内的单例集合。 */

import type { Redis } from "ioredis";
import type { Settings } from "./config.js";
import { EventStore } from "./storage/events.js";
import { buildRedis } from "./storage/redis.js";
import { BindingStore } from "./bindings.js";
import { SupplierStore } from "./suppliers.js";
import { FeishuAppClient } from "./feishuApp.js";
import { ResendEmailClient } from "./emailContent.js";
import { FeishuNotifier } from "./notify.js";
import { buildLeadUpdater } from "./leads.js";
import type { LeadUpdater } from "./leads.js";

export interface AppState {
  settings: Settings;
  events: EventStore;
  /** 仅 LEAD_BACKEND=redis 时才需要；幂等已由数据库唯一约束保证 */
  redis: Redis | null;
  leads: LeadUpdater;
  bindings: BindingStore;
  suppliers: SupplierStore;
  feishuApp: FeishuAppClient;
  resendEmail: ResendEmailClient;
  notifier: FeishuNotifier;
}

export function buildState(settings: Settings): AppState {
  const redis = buildRedis(settings);
  const bindings = new BindingStore();
  const suppliers = new SupplierStore();
  const feishuApp = new FeishuAppClient(settings.feishuTimeoutSeconds);
  const resendEmail = new ResendEmailClient(settings.resendApiKey, {
    baseUrl: settings.resendApiBaseUrl,
    timeoutSeconds: settings.resendTimeoutSeconds,
    previewChars: settings.emailContentPreviewChars,
  });

  return {
    settings,
    events: new EventStore(),
    redis,
    leads: buildLeadUpdater(settings, redis),
    bindings,
    suppliers,
    feishuApp,
    resendEmail,
    notifier: new FeishuNotifier(settings, {
      bindingStore: bindings,
      appClient: feishuApp,
      contentClient: resendEmail,
    }),
  };
}
