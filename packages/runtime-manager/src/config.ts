import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A built template snapshot. The build script records when it expires and what it runs. */
export interface TemplateRecord {
  version: string;
  snapshotId: string;
  name?: string;
  description?: string;
  /** false = selectable by explicit id (tests, migrations) but hidden from the signup catalog. */
  listed?: boolean;
  builtAt?: string;
  expiresAt?: string;
  runtime?: Record<string, string>;
  /** Public provenance only; the full profile is immutable inside this snapshot. */
  agentKit?: { archiveSha256: string; sourceCommit: string; requiredEnvKeys: string[] };
  /** Private per-template planner override. Never copied into the payload/snapshot. */
  model?: { id: string; baseUrl: string; apiKey: string };
  /** Explicit version pin for a private model profile; old tenants fail closed on mismatch. */
  modelVersion?: string;
  /** Exact payload versions explicitly approved to share this private planner profile. */
  modelVersions?: string[];
  /**
   * Private template-wide service keys (e.g. GOOGLE_API_KEY for memory embeddings),
   * injected into the boot environment only. Never copied into a payload or snapshot.
   */
  runtimeEnv?: Record<string, string>;
  /** Sandbox size for this template's tenants; defaults to 2 vCPUs. */
  resources?: { vcpus: number };
  /**
   * Named public HTTPS ports of this template's sandboxes (desktop takeover page,
   * browser relay, voice page). Each is served at its own https://*.vercel.run origin.
   */
  publicPorts?: Record<string, number>;
  /** Idle seconds before this template's new tenants sleep (15..1800); defaults to the global value. */
  idleTimeoutSeconds?: number;
  /**
   * Background loops every tenant of this template gets (e.g. Mirror V's nightly
   * Librarian). Registered once into the owner's chat after their first
   * successful turn; a schedule the owner removes is never re-added.
   */
  systemSchedules?: SystemSchedule[];
}

export interface SystemSchedule {
  name: string;
  kind?: "cron" | "heartbeat";
  schedule: { kind: "cron"; expr: string; tz?: string } | { kind: "every"; everySeconds: number };
  prompt: string;
}

export interface Config {
  databaseUrl: string;
  adminToken: string;
  encryptionKey: string;
  port: number;
  idleTimeoutSeconds: number;
  trialTenantId: string;
  snapshotId?: string;
  /** Versioned, approved snapshots for additional signup templates. */
  templates?: Record<string, TemplateRecord>;
  optimizeRuntime?: boolean;
  sandboxPrefix: string;
  /** External payload tar, rooted at the workspace. Overrides the in-repo payload. */
  payloadArchive?: string;
  model: { id: string; baseUrl: string; apiKey: string };
  vercel: { token: string; teamId: string; projectId: string };
  /** Public origin of the Portal (wake links handed to owners); defaults to the Vercel edge. */
  publicBaseUrl?: string;
  alibaba?: { apiKey: string; region: string; templateId: string; trialTenantId?: string; enabled?: boolean };
  dataDir: string;
}

export function loadConfig(): Config {
  const file = path.resolve(
    process.env.NEXUS_CONFIG_PATH || "../../.elastic/config.json",
  );
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const authPath =
    process.env.NEXUS_VERCEL_AUTH_PATH ||
    path.join(
      os.homedir(),
      "Library/Application Support/com.vercel.cli/auth.json",
    );
  const vercelToken =
    process.env.VERCEL_TOKEN ||
    saved.vercel?.token ||
    JSON.parse(fs.readFileSync(authPath, "utf8")).token;
  if (
    !saved.databaseUrl ||
    !saved.adminToken ||
    !/^[a-f0-9]{64}$/.test(saved.encryptionKey)
  )
    throw new Error("Invalid Nexus private configuration");
  if (!saved.model?.apiKey)
    throw new Error("Nexus model credentials are not configured");
  return {
    ...saved,
    port: saved.port ?? 8097,
    idleTimeoutSeconds: saved.idleTimeoutSeconds ?? 600,
    trialTenantId: saved.trialTenantId || "elastic-trial",
    sandboxPrefix: saved.sandboxPrefix || "nexus-elastic-20260914",
    dataDir: path.dirname(file),
    vercel: { ...saved.vercel, token: vercelToken },
  };
}
