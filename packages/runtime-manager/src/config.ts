import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  databaseUrl: string;
  adminToken: string;
  encryptionKey: string;
  port: number;
  idleTimeoutSeconds: number;
  trialTenantId: string;
  snapshotId?: string;
  optimizeRuntime?: boolean;
  sandboxPrefix: string;
  model: { id: string; baseUrl: string; apiKey: string };
  vercel: { token: string; teamId: string; projectId: string };
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
