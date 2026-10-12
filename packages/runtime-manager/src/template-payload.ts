import fs from "node:fs";
import path from "node:path";
import type { SystemSchedule, TemplateRecord } from "./config.js";

/** OpenClaw version baked into every template snapshot. Upgrades need a new snapshot and a controlled migration. */
export const TEMPLATE_OPENCLAW_VERSION = "2026.7.1";
/** Vercel keeps a template snapshot this long; the record carries the deadline so it can be renewed in time. */
export const TEMPLATE_SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "payload-manifest.json"];

export interface TemplateManifest {
  name: string;
  version: string;
  description?: string;
  files?: string[];
  tools?: { pythonWheels?: string[]; commands?: string[]; versions?: Record<string, string> };
  /** Background loops registered for each tenant after its first successful turn. */
  systemSchedules?: SystemSchedule[];
}

export interface TemplatePayload {
  dir: string;
  manifest: TemplateManifest;
  files: string[];
  wheels: string[];
  commands: string[];
}

function safeRelative(file: unknown): file is string {
  return typeof file === "string" && file.length > 0 && !path.isAbsolute(file) &&
    !file.split(/[\\/]/).some((part) => part === ".." || part === "");
}

/**
 * Resolve an in-repo public template. Only files the manifest lists are
 * packaged, so stale files or private notes in the directory never ship.
 */
export function resolveTemplatePayload(root: string, templateId: string): TemplatePayload {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(templateId)) throw Error("UNKNOWN_TEMPLATE");
  const templateDir = path.join(root, "packages/agent-templates", templateId);
  const dir = path.join(templateDir, "payload");
  const manifestPath = path.join(dir, "payload-manifest.json");
  if (!fs.existsSync(manifestPath)) throw Error("UNKNOWN_TEMPLATE");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as TemplateManifest;
  if (manifest.name !== templateId || typeof manifest.version !== "string" || !manifest.version.startsWith(`${templateId}`))
    throw Error("TEMPLATE_MANIFEST_INVALID");
  const files = manifest.files ?? DEFAULT_FILES;
  if (!files.includes("payload-manifest.json") || !files.every(safeRelative)) throw Error("TEMPLATE_MANIFEST_INVALID");
  for (const file of files) if (!fs.statSync(path.join(dir, file), { throwIfNoEntry: false })?.isFile()) throw Error(`TEMPLATE_FILE_MISSING:${file}`);
  const wheels = (manifest.tools?.pythonWheels ?? []).map((wheel) => {
    if (!safeRelative(wheel) || !wheel.endsWith(".whl")) throw Error("TEMPLATE_MANIFEST_INVALID");
    const full = path.join(templateDir, wheel);
    if (!fs.existsSync(full)) throw Error(`TEMPLATE_FILE_MISSING:${wheel}`);
    return full;
  });
  const commands = manifest.tools?.commands ?? [];
  if (!commands.every((command) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(command))) throw Error("TEMPLATE_MANIFEST_INVALID");
  if (commands.length && !wheels.length) throw Error("TEMPLATE_MANIFEST_INVALID");
  return { dir, manifest, files, wheels, commands };
}

/**
 * The config entry a fresh build writes. Display metadata and the listed flag
 * survive rebuilds; a template built for the first time starts unlisted so it
 * can be tested by id before it appears on the signup page.
 */
export function templateRecord(
  previous: TemplateRecord | undefined,
  build: { version: string; snapshotId: string; builtAt: Date; tools?: Record<string, string>; agentKit?: TemplateRecord["agentKit"]; runtime?: Record<string, string>; systemSchedules?: SystemSchedule[] },
): TemplateRecord {
  return {
    ...(previous?.name ? { name: previous.name } : {}),
    ...(previous?.appName ? { appName: previous.appName } : {}),
    ...(previous?.description ? { description: previous.description } : {}),
    ...(previous?.model ? { model: previous.model, modelVersion: previous.modelVersion || previous.version } : {}),
    ...(build.agentKit ? { agentKit: build.agentKit } : {}),
    version: build.version,
    snapshotId: build.snapshotId,
    listed: previous ? previous.listed !== false : false,
    builtAt: build.builtAt.toISOString(),
    expiresAt: new Date(build.builtAt.getTime() + TEMPLATE_SNAPSHOT_TTL_MS).toISOString(),
    runtime: { ...(build.runtime ?? { openclaw: TEMPLATE_OPENCLAW_VERSION }), ...build.tools },
    // Private operator settings survive rebuilds: template keys and sandbox size.
    ...(previous?.runtimeEnv ? { runtimeEnv: previous.runtimeEnv } : {}),
    ...(previous?.resources ? { resources: previous.resources } : {}),
    ...(previous?.idleTimeoutSeconds ? { idleTimeoutSeconds: previous.idleTimeoutSeconds } : {}),
    ...(previous?.publicPorts ? { publicPorts: previous.publicPorts } : {}),
    ...(build.systemSchedules?.length ? { systemSchedules: build.systemSchedules } : {}),
  };
}
