import { prisma } from "../../prisma";
import { config } from "../../config";

export type FeishuAppCreds = {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  csChatId?: string;
  inviteAppIds: string[];
  inviteOpenIds: string[];
  inviteMobiles: string[];
  inviteEmails: string[];
};

/** 通用逗号/空白分隔列表（open_id / 手机号 / 邮箱），去重去空。 */
function parseCsvList(value?: string | string[] | null): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value || "";
  return [...new Set(raw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean))];
}

export function parseCliAppIds(value?: string | string[] | null): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value || "";
  return [
    ...new Set(
      raw
        .split(/[,，\s]+/)
        .map((id) => id.trim())
        .filter((id) => /^cli_[a-zA-Z0-9]+$/.test(id)),
    ),
  ];
}

function trim(value?: string): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

/** 去掉引号、BOM、`FEISHU_*=` 前缀；飞书密钥必须是控制台复制的 ASCII 串。 */
export function sanitizeFeishuSecret(value?: string): string | undefined {
  let next = value?.replace(/^\uFEFF/, "").trim() ?? "";
  if (
    (next.startsWith('"') && next.endsWith('"')) ||
    (next.startsWith("'") && next.endsWith("'"))
  ) {
    next = next.slice(1, -1).trim();
  }
  next = next
    .replace(/^(FEISHU_ENCRYPT_KEY|FEISHU_VERIFICATION_TOKEN|encryptKey|verificationToken)\s*=\s*/i, "")
    .trim();
  if (
    (next.startsWith('"') && next.endsWith('"')) ||
    (next.startsWith("'") && next.endsWith("'"))
  ) {
    next = next.slice(1, -1).trim();
  }
  return next || undefined;
}

function assertFeishuSecret(label: string, value: string | undefined, required: boolean): string | undefined {
  if (!value) {
    if (required) throw new Error(`缺少 ${label}`);
    return undefined;
  }
  if (!/^[\x21-\x7E]+$/.test(value)) {
    throw new Error(
      `${label} 必须是该飞书应用「加密策略」里复制的 ASCII 字符串，不能是中文说明或占位符`,
    );
  }
  if (value.length < 8) {
    throw new Error(`${label} 太短，请从开放平台「加密策略」复制完整值`);
  }
  if (/^\$?FEISHU_|changeme|placeholder|your[_-]?/i.test(value)) {
    throw new Error(`${label} 看起来是占位符。请读取智能体环境变量里的真实值，不要编造`);
  }
  return value;
}

export function envFeishuCreds(): FeishuAppCreds | undefined {
  if (!config.feishu.appId || !config.feishu.appSecret) return undefined;
  return {
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    verificationToken: config.feishu.verificationToken,
    encryptKey: config.feishu.encryptKey,
    inviteAppIds: [...config.feishu.inviteAppIds],
    inviteOpenIds: [...config.feishu.inviteOpenIds],
    inviteMobiles: [...config.feishu.inviteMobiles],
    inviteEmails: [...config.feishu.inviteEmails],
  };
}

function fromRow(row: {
  appId: string;
  appSecret: string;
  verificationToken: string | null;
  encryptKey: string | null;
  csChatId: string | null;
  inviteAppIds?: string | null;
  inviteOpenIds?: string | null;
  inviteMobiles?: string | null;
  inviteEmails?: string | null;
}): FeishuAppCreds {
  const stored = parseCliAppIds(row.inviteAppIds);
  const storedOpenIds = parseCsvList(row.inviteOpenIds);
  const storedMobiles = parseCsvList(row.inviteMobiles);
  const storedEmails = parseCsvList(row.inviteEmails);
  return {
    appId: row.appId,
    appSecret: row.appSecret,
    verificationToken: row.verificationToken || undefined,
    encryptKey: row.encryptKey || undefined,
    csChatId: row.csChatId || undefined,
    inviteAppIds: stored.length ? stored : [...config.feishu.inviteAppIds],
    inviteOpenIds: storedOpenIds.length ? storedOpenIds : [...config.feishu.inviteOpenIds],
    inviteMobiles: storedMobiles.length ? storedMobiles : [...config.feishu.inviteMobiles],
    inviteEmails: storedEmails.length ? storedEmails : [...config.feishu.inviteEmails],
  };
}

export async function getFeishuApp(appId: string): Promise<FeishuAppCreds | undefined> {
  const id = appId.trim();
  if (!id) return undefined;
  const row = await prisma.feishuApp.findUnique({ where: { appId: id } });
  return row ? fromRow(row) : undefined;
}

export async function getLatestFeishuApp(): Promise<FeishuAppCreds | undefined> {
  const row = await prisma.feishuApp.findFirst({ orderBy: { updatedAt: "desc" } });
  return row ? fromRow(row) : undefined;
}

export async function resolveFeishuAppCreds(appId?: string): Promise<FeishuAppCreds> {
  const explicit = trim(appId);
  if (explicit) {
    const row = await getFeishuApp(explicit);
    if (row) return row;
    const env = envFeishuCreds();
    if (env && env.appId === explicit) return env;
    throw new Error(`飞书应用未注册：${explicit}。请先 POST /api/feishu/apps`);
  }
  const latest = await getLatestFeishuApp();
  if (latest) return latest;
  const env = envFeishuCreds();
  if (env) return env;
  throw new Error("飞书应用未注册：智能体初始化时请 POST /api/feishu/apps");
}

export async function upsertFeishuApp(input: {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  inviteAppIds?: string | string[];
  inviteOpenIds?: string | string[];
  inviteMobiles?: string | string[];
  inviteEmails?: string | string[];
}): Promise<FeishuAppCreds> {
  const appId = trim(input.appId);
  const appSecret = trim(input.appSecret);
  if (!appId || !appSecret) {
    throw new Error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  }
  const verificationToken = assertFeishuSecret(
    "FEISHU_VERIFICATION_TOKEN",
    sanitizeFeishuSecret(input.verificationToken),
    false,
  );
  const encryptKey = assertFeishuSecret(
    "FEISHU_ENCRYPT_KEY",
    sanitizeFeishuSecret(input.encryptKey),
    true,
  );
  const inviteAppIds = parseCliAppIds(input.inviteAppIds);
  const inviteAppIdsStored = inviteAppIds.length ? inviteAppIds.join(",") : undefined;
  const inviteOpenIds = parseCsvList(input.inviteOpenIds);
  const inviteOpenIdsStored = inviteOpenIds.length ? inviteOpenIds.join(",") : undefined;
  const inviteMobiles = parseCsvList(input.inviteMobiles);
  const inviteMobilesStored = inviteMobiles.length ? inviteMobiles.join(",") : undefined;
  const inviteEmails = parseCsvList(input.inviteEmails);
  const inviteEmailsStored = inviteEmails.length ? inviteEmails.join(",") : undefined;
  const row = await prisma.feishuApp.upsert({
    where: { appId },
    update: {
      appSecret,
      ...(verificationToken !== undefined ? { verificationToken: verificationToken || null } : {}),
      ...(encryptKey !== undefined ? { encryptKey: encryptKey || null } : {}),
      ...(inviteAppIdsStored !== undefined ? { inviteAppIds: inviteAppIdsStored } : {}),
      ...(inviteOpenIdsStored !== undefined ? { inviteOpenIds: inviteOpenIdsStored } : {}),
      ...(inviteMobilesStored !== undefined ? { inviteMobiles: inviteMobilesStored } : {}),
      ...(inviteEmailsStored !== undefined ? { inviteEmails: inviteEmailsStored } : {}),
    },
    create: {
      appId,
      appSecret,
      verificationToken: verificationToken || null,
      encryptKey: encryptKey || null,
      inviteAppIds: inviteAppIdsStored || null,
      inviteOpenIds: inviteOpenIdsStored || null,
      inviteMobiles: inviteMobilesStored || null,
      inviteEmails: inviteEmailsStored || null,
    },
  });
  return fromRow(row);
}

export async function saveFeishuCsChatId(appId: string, csChatId: string): Promise<void> {
  await prisma.feishuApp.update({
    where: { appId },
    data: { csChatId },
  });
}

export async function saveFeishuInviteAppIds(appId: string, inviteAppIds: string[]): Promise<void> {
  const ids = parseCliAppIds(inviteAppIds);
  if (!ids.length) return;
  await prisma.feishuApp.update({
    where: { appId },
    data: { inviteAppIds: ids.join(",") },
  });
}

export function feishuWebhookUrl(baseUrl: string, appId: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/webhooks/feishu/${encodeURIComponent(appId)}`;
}

export function publicFeishuApp(creds: FeishuAppCreds, webhookUrl: string) {
  return {
    appId: creds.appId,
    webhookUrl,
    webhookPath: `/webhooks/feishu/${creds.appId}`,
    hasEncryptKey: Boolean(creds.encryptKey),
    hasVerificationToken: Boolean(creds.verificationToken),
    inviteAppIds: creds.inviteAppIds,
    inviteOpenIds: creds.inviteOpenIds,
    inviteMobiles: creds.inviteMobiles,
    inviteEmails: creds.inviteEmails,
  };
}
