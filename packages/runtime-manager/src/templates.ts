import type { Config } from "./config.js";

export interface AgentTemplate {
  id: string;
  version: string;
  name: string;
  description: string;
  snapshotId: string;
}

const LABELS: Record<string, { name: string; description: string }> = {
  dealclaw: { name: "DealClaw", description: "面向出海业务的 AI 顾问" },
  "mirror-v": { name: "Mirror V", description: "与你一起思考、整理和行动的通用 Agent" },
};

/** Only explicitly configured, versioned snapshots may be offered for signup. */
export function availableTemplates(config: Config): AgentTemplate[] {
  const entries: AgentTemplate[] = [];
  const dealclaw = config.templates?.dealclaw;
  if (dealclaw?.snapshotId && dealclaw.version) entries.push({
    id: "dealclaw", version: dealclaw.version, ...LABELS.dealclaw,
    snapshotId: dealclaw.snapshotId,
  });
  else if (config.snapshotId) entries.push({
    id: "dealclaw", version: "dealclaw-base.v2", ...LABELS.dealclaw,
    snapshotId: config.snapshotId,
  });
  for (const [id, value] of Object.entries(config.templates ?? {})) {
    if (id === "dealclaw" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !value?.snapshotId || !value?.version) continue;
    const label = LABELS[id];
    const name = value.name?.trim() || label?.name || id;
    const description = value.description?.trim() || label?.description || "独立 Agent 模板";
    entries.push({ id, version: value.version, name, description, snapshotId: value.snapshotId });
  }
  return entries;
}

export function requireTemplate(config: Config, id: string, version?: string): AgentTemplate {
  const template = availableTemplates(config).find((item) => item.id === id);
  if (!template || (version && version !== template.version)) throw Error("TEMPLATE_NOT_AVAILABLE");
  return template;
}
