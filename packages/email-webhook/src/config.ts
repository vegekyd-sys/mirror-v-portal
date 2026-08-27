/** 运行期配置 —— 全部通过环境变量注入，便于本地/集群共用同一份代码。 */

/** Resend 会推送的全部事件类型。 */
export const ALL_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.received", // 买家回信（需在 Resend 侧开启 Receiving）
] as const;

// 验收标准第 6 条要求这四类推送飞书；email.received（买家回信）是
// 意向最强的信号，默认一并推送。
export const DEFAULT_NOTIFY_EVENTS = [
  "email.received",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
] as const;

function str(name: string, fallback = ""): string {
  const raw = process.env[name];
  return raw === undefined ? fallback : raw.trim();
}

/** 不做 trim 的版本：密码类值可能真的以空格开头结尾。 */
function secret(name: string, fallback = ""): string {
  const raw = process.env[name];
  return raw === undefined ? fallback : raw;
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

function float(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) ? fallback : value;
}

function csv(name: string, fallback: readonly string[]): ReadonlySet<string> {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return new Set(fallback);
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/**
 * 把 ROUTE_PREFIX 归一化成 "" 或 "/xxx"（有前导斜杠、无尾部斜杠）。
 *
 * 留空 = 根路径路由（/inbound、/bindings…）；集群里设 /webhook，接口即变为
 * /webhook/inbound 等，网关不需要 StripPrefix。
 */
function prefix(name: string): string {
  let raw = str(name);
  if (!raw || raw === "/") return "";
  if (!raw.startsWith("/")) raw = `/${raw}`;
  return raw.replace(/\/+$/, "");
}

export interface Settings {
  // --- HTTP 服务 ---
  host: string;
  port: number;
  logLevel: string;
  /** 所有业务路由的统一前缀。/health 无论如何都额外挂在根路径上，供探针使用。 */
  routePrefix: string;

  // --- PostgreSQL（必需）---
  /** 绑定表、供应商表、事件全部存这里。没有它服务起不来。 */
  databaseUrl: string;

  // --- 验签 ---
  /** Resend 使用 Svix 签名，密钥形如 whsec_xxxxx */
  signingSecret: string;
  /** 未配置密钥时是否放行。生产必须为 false，本地联调可临时打开 */
  allowUnsigned: boolean;
  signatureToleranceSeconds: number;

  // --- Resend API（按 email_id 获取正文）---
  resendApiKey: string;
  resendApiBaseUrl: string;
  resendTimeoutSeconds: number;
  emailContentPreviewChars: number;

  // --- Redis（可选，仅用于线索状态缓存）---
  // 幂等去重已经由 email_events.message_id 的唯一约束保证，不再依赖 Redis。
  redisAddr: string;
  redisPassword: string;
  redisDb: number;
  redisKeyPrefix: string;

  // --- 飞书通知 ---
  // 这里只有「推什么、超时多久」这类策略。**具体推到哪个群、用哪套凭据、@ 谁，
  // 全部按代理邮箱存在 email_bindings 表里**，通过 /bindings 接口动态维护。
  // 早期版本有一组全局 FEISHU_WEBHOOK_URL/SECRET/MENTION_OPEN_ID 作为「未命中绑定」
  // 时的兜底，已移除：在多租户下那条路会把某家的买家回信（含正文预览）推到
  // 另一家或平台的群里，绕过 supplier_id 隔离。
  notifyEvents: ReadonlySet<string>;
  feishuTimeoutSeconds: number;
  feishuMentionEvents: ReadonlySet<string>;

  // --- 多租户 ---
  /** 未指定归属时落到哪个供应商 */
  defaultSupplierId: string;
  /**
   * 管理接口的令牌。绑定接口会接收 app_secret，未设置时接口整体关闭（fail closed）。
   * /v1/events 增量读取接口同样用它（Authorization: Bearer），保持单一凭据。
   */
  adminToken: string;

  // --- 限流 ---
  /** 限流白名单 IP（CSV）。命中的请求不受限，测试用 127.0.0.1 豁免本地 inject。 */
  rateLimitAllowList: ReadonlySet<string>;

  // --- 线索（lead）后端 ---
  // noop      : 只记录状态流转日志，不写任何业务表（默认）
  // redis     : 线索状态写 Redis Hash
  // postgres  : 线索状态写业务表（需补齐下面的表/列名）
  leadBackend: string;
  leadTable: string;
  leadEmailColumn: string;
  leadStatusColumn: string;
  leadUpdatedColumn: string;
}

export function redisEnabled(s: Settings): boolean {
  return Boolean(s.redisAddr);
}

export function resendApiEnabled(s: Settings): boolean {
  return Boolean(s.resendApiKey);
}

function build(): Settings {
  return {
    host: str("HOST", "127.0.0.1"),
    port: int("PORT", 8000),
    logLevel: str("LOG_LEVEL", "info"),
    routePrefix: prefix("ROUTE_PREFIX"),

    databaseUrl: str("DATABASE_URL"),

    signingSecret: str("RESEND_SIGNING_SECRET"),
    allowUnsigned: bool("ALLOW_UNSIGNED", false),
    signatureToleranceSeconds: int("SIGNATURE_TOLERANCE_SECONDS", 300),

    resendApiKey: str("RESEND_API_KEY"),
    resendApiBaseUrl: str("RESEND_API_BASE_URL", "https://api.resend.com"),
    resendTimeoutSeconds: float("RESEND_TIMEOUT_SECONDS", 5),
    emailContentPreviewChars: int("EMAIL_CONTENT_PREVIEW_CHARS", 1200),

    redisAddr: str("REDIS_ADDR"),
    redisPassword: secret("REDIS_PASSWORD"),
    redisDb: int("REDIS_DB", 0),
    redisKeyPrefix: str("REDIS_KEY_PREFIX", "emailhook"),

    notifyEvents: csv("NOTIFY_EVENTS", DEFAULT_NOTIFY_EVENTS),
    feishuTimeoutSeconds: float("FEISHU_TIMEOUT_SECONDS", 5),
    feishuMentionEvents: csv("FEISHU_MENTION_EVENTS", ["email.received"]),

    defaultSupplierId: str("DEFAULT_SUPPLIER_ID", "151897148668"),
    adminToken: str("ADMIN_TOKEN"),

    rateLimitAllowList: csv("RATE_LIMIT_ALLOW_LIST", []),

    leadBackend: str("LEAD_BACKEND", "noop").toLowerCase(),
    leadTable: str("LEAD_TABLE"),
    leadEmailColumn: str("LEAD_EMAIL_COLUMN", "email"),
    leadStatusColumn: str("LEAD_STATUS_COLUMN", "email_status"),
    leadUpdatedColumn: str("LEAD_UPDATED_COLUMN"),
  };
}

let cached: Settings | undefined;

/** 整个进程只读一次环境变量。 */
export function getSettings(): Settings {
  cached ??= build();
  return cached;
}

/** 仅测试用：清掉缓存，让下次 getSettings() 重读环境变量。 */
export function resetSettings(): void {
  cached = undefined;
}
