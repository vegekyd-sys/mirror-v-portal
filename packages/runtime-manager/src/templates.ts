import type { Config } from "./config.js";

export interface AgentTemplate {
  id: string;
  version: string;
  name: string;
  description: string;
  snapshotId: string;
  /** Hidden templates can be requested by id but are not offered on the signup page. */
  listed: boolean;
}

const LABELS: Record<string, { name: string; description: string }> = {
  dealclaw: { name: "DealClaw", description: "面向出海业务的 AI 顾问" },
  "mirror-v": { name: "Mirror V", description: "与你一起思考、整理和行动的通用 Agent" },
  xingqing: { name: "星擎助手", description: "查询企业在星擎的账号、作品、播放与线索数据" },
  makaron: { name: "Makaron", description: "与你一起创作图片、视频、音乐和动态设计" },
};

/**
 * Per-tenant runtime secrets a template accepts, injected as environment
 * variables when its sandbox boots. Operators bind them in the admin console;
 * names outside this list are rejected so a binding can never override the
 * runtime's own NEXUS_* or OPENCLAW_* variables.
 */
const TEMPLATE_SECRETS: Record<string, readonly string[]> = {
  xingqing: ["XINGQING_USERNAME", "XINGQING_PASSWORD"],
  makaron: ["MAKARON_API_KEY"],
};

export function templateSecretNames(templateId: string): readonly string[] {
  return TEMPLATE_SECRETS[templateId] ?? [];
}

/** A binding must supply exactly the template's declared secrets, each a non-empty single-line string. */
export function validateTenantSecrets(templateId: string, input: unknown): Record<string, string> {
  const names = templateSecretNames(templateId);
  if (!names.length) throw Error("TEMPLATE_HAS_NO_SECRETS");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("INVALID_SECRETS");
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length !== names.length || entries.some(([name]) => !names.includes(name))) throw Error("INVALID_SECRETS");
  for (const [, value] of entries)
    if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\r\n\0]/.test(value)) throw Error("INVALID_SECRETS");
  return Object.fromEntries(entries.map(([name, value]) => [name, (value as string).trim()]));
}

/** Only explicitly configured, versioned snapshots may be offered for signup. */
export function availableTemplates(config: Config): AgentTemplate[] {
  const entries: AgentTemplate[] = [];
  const dealclaw = config.templates?.dealclaw;
  if (dealclaw?.snapshotId && dealclaw.version) entries.push({
    id: "dealclaw", version: dealclaw.version, ...LABELS.dealclaw,
    snapshotId: dealclaw.snapshotId, listed: dealclaw.listed !== false,
  });
  else if (config.snapshotId) entries.push({
    id: "dealclaw", version: "dealclaw-base.v2", ...LABELS.dealclaw,
    snapshotId: config.snapshotId, listed: true,
  });
  for (const [id, value] of Object.entries(config.templates ?? {})) {
    if (id === "dealclaw" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !value?.snapshotId || !value?.version) continue;
    const label = LABELS[id];
    const name = value.name?.trim() || label?.name || id;
    const description = value.description?.trim() || label?.description || "独立 Agent 模板";
    entries.push({ id, version: value.version, name, description, snapshotId: value.snapshotId, listed: value.listed !== false });
  }
  return entries;
}

export function requireTemplate(config: Config, id: string, version?: string): AgentTemplate {
  const template = availableTemplates(config).find((item) => item.id === id);
  if (!template || (version && version !== template.version)) throw Error("TEMPLATE_NOT_AVAILABLE");
  return template;
}
