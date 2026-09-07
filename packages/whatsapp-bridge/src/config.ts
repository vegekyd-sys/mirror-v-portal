import { appEnv, type AppEnv } from "./loadEnv";

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function csv(name: string): string[] {
  const value = optional(name);
  if (!value) return [];
  return [...new Set(value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))];
}

function commaSeparated(name: string): string[] {
  const value = optional(name);
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function flag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export { appEnv, type AppEnv };

/**
 * 把 ROUTE_PREFIX 归一化成 "" 或 "/xxx"（有前导斜杠、无尾部斜杠）。
 *
 * 留空 = 路由都在根上（本地开发）；集群里设 /whatsapp，接口变成
 * /whatsapp/webhooks/ycloud 等，与 email-webhook 共用一个 ALB host。
 * /health 无论如何都额外挂在根路径上，供探针直连 Pod 使用。
 */
function routePrefix(): string {
  let raw = process.env.ROUTE_PREFIX?.trim() || "";
  if (!raw || raw === "/") return "";
  if (!raw.startsWith("/")) raw = `/${raw}`;
  return raw.replace(/\/+$/, "");
}

export const config = {
  appEnv,
  routePrefix: routePrefix(),
  isDevelopment: appEnv === "development",
  isTest: appEnv === "test",
  isProduction: appEnv === "production",
  port: Number(process.env.PORT || 3000),
  database: {
    url: process.env.DATABASE_URL || "",
    user: optional("DATABASE_USER"),
    password: optional("DATABASE_PASSWORD"),
    schema: optional("DATABASE_SCHEMA") || "public",
  },
  databaseUrl: process.env.DATABASE_URL || "",
  bridgeBaseUrl: optional("WHATSAPP_BRIDGE_BASE_URL"),
  /** Server-side operator credential. Never expose this to tenant agents or client responses. */
  adminToken: optional("WHATSAPP_BRIDGE_ADMIN_TOKEN"),
  /** Temporary Skill-only existing-WABA binding gate. Empty means the endpoint is disabled. */
  skillBindAllowedSuppliers: commaSeparated("WHATSAPP_BRIDGE_SKILL_BIND_ALLOWED_SUPPLIERS"),
  ycloud: {
    apiKey: optional("YCLOUD_API_KEY"),
    webhookSecret: optional("YCLOUD_WEBHOOK_SECRET"),
    skipSignature: flag("YCLOUD_SKIP_SIGNATURE"),
    baseUrl: "https://api.ycloud.com/v2",
  },
  feishu: {
    appId: optional("FEISHU_APP_ID"),
    appSecret: optional("FEISHU_APP_SECRET"),
    verificationToken: optional("FEISHU_VERIFICATION_TOKEN"),
    encryptKey: optional("FEISHU_ENCRYPT_KEY"),
    chatId: optional("FEISHU_CHAT_ID"),
    notifyChatIds: csv("FEISHU_NOTIFY_CHAT_IDS"),
    notifyChatNames: csv("FEISHU_NOTIFY_CHAT_NAMES"),
    inviteOpenIds: csv("FEISHU_INVITE_OPEN_IDS"),
    inviteEmails: csv("FEISHU_INVITE_EMAILS"),
    inviteMobiles: csv("FEISHU_INVITE_MOBILES"),
    /** 建客服群时拉入的其他飞书机器人 App ID（cli_ 开头）。桥接自己不用填。 */
    inviteAppIds: csv("FEISHU_INVITE_APP_IDS"),
    skipSignature: flag("FEISHU_SKIP_SIGNATURE"),
    baseUrl: optional("FEISHU_BASE_URL") || "https://open.feishu.cn",
  },
};

/** Fail fast for a real server process; tests can still build an isolated Fastify instance. */
export function assertRequiredServerConfig(): void {
  if (!config.adminToken) {
    throw new Error("WHATSAPP_BRIDGE_ADMIN_TOKEN is required");
  }
}
