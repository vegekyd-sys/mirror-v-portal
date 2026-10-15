import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { sandboxExecPolicy } from "./sandbox-exec.mjs";

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const defaultDeny = ["cron", "gateway", "sessions_spawn", "sessions_send"];

function relativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) throw Error("INVALID_PAYLOAD_PATH");
  return value;
}

export function normalizeRuntimeOptions(input = {}) {
  const agentId = input.agentId ?? "dealclaw";
  if (!idPattern.test(agentId)) throw Error("INVALID_RUNTIME_AGENT_ID");
  const payloadLayout = input.payloadLayout ?? "workspace";
  if (!["workspace", "agent-kit-v1"].includes(payloadLayout)) throw Error("INVALID_PAYLOAD_LAYOUT");
  if (input.payloadVersion !== undefined && (typeof input.payloadVersion !== "string" || !input.payloadVersion || input.payloadVersion.length > 128)) throw Error("INVALID_PAYLOAD_VERSION");
  const envKeys = input.envKeys ?? [];
  if (!Array.isArray(envKeys) || envKeys.some(key => !/^[A-Z][A-Z0-9_]+$/.test(key) || key.startsWith("NEXUS_") || key.startsWith("OPENCLAW_"))) throw Error("INVALID_RUNTIME_ENV_KEYS");
  const plugins = input.plugins ?? [];
  if (!Array.isArray(plugins)) throw Error("INVALID_RUNTIME_PLUGINS");
  const seen = new Set(["nexus-scheduler"]);
  for (const plugin of plugins) {
    if (!idPattern.test(plugin.id) || seen.has(plugin.id)) throw Error("INVALID_RUNTIME_PLUGIN_ID");
    relativePath(plugin.path);
    seen.add(plugin.id);
  }
  const tools = input.tools ?? {};
  const modelInput = input.modelInput ?? ["text"];
  if (!Array.isArray(modelInput) || !modelInput.length || modelInput.some(kind => !["text", "image"].includes(kind))) throw Error("INVALID_RUNTIME_MODEL_INPUT");
  if (input.mediaBinaries !== undefined && typeof input.mediaBinaries !== "boolean") throw Error("INVALID_RUNTIME_MEDIA_BINARIES");
  const skills = input.skills;
  if (skills !== undefined && (!Array.isArray(skills) || skills.some(name => typeof name !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(name)))) throw Error("INVALID_RUNTIME_SKILLS");
  const skillsLimits = input.skillsLimits;
  if (skillsLimits !== undefined && (!skillsLimits || typeof skillsLimits !== "object" || Array.isArray(skillsLimits) ||
    Object.keys(skillsLimits).some(key => key !== "maxSkillsPromptChars") ||
    (skillsLimits.maxSkillsPromptChars !== undefined && (!Number.isSafeInteger(skillsLimits.maxSkillsPromptChars) || skillsLimits.maxSkillsPromptChars < 0)))) throw Error("INVALID_RUNTIME_SKILLS_LIMITS");
  if (tools.exec !== undefined && (!tools.exec || !["deny", "allowlist", "full"].includes(tools.exec.security) || !["off", "on-miss", "always"].includes(tools.exec.ask))) throw Error("INVALID_RUNTIME_EXEC");
  for (const list of [tools.alsoAllow ?? [], tools.deny ?? defaultDeny]) {
    if (!Array.isArray(list) || list.some(name => typeof name !== "string" || !/^[a-zA-Z0-9_.:*\/-]+$/.test(name))) throw Error("INVALID_RUNTIME_TOOLS");
  }
  return {
    agentId, displayName: input.displayName ?? "Portal Agent",
    payloadVersion: input.payloadVersion ?? "dealclaw-2026-09-14",
    payloadLayout, envKeys: [...envKeys], modelInput: [...new Set(modelInput)], mediaBinaries: input.mediaBinaries ?? false,
    ...(skills !== undefined ? { skills: [...new Set(skills)] } : {}),
    ...(skillsLimits !== undefined ? { skillsLimits: { ...skillsLimits } } : {}),
    plugins: plugins.map(plugin => ({ id: plugin.id, path: plugin.path, config: plugin.config ?? {} })),
    tools: { profile: tools.profile ?? "coding", alsoAllow: [...new Set(["portal_schedule", "portal_environment", ...(tools.alsoAllow ?? []).filter(name => name !== "nexus_schedule")])], deny: [...(tools.deny ?? defaultDeny)], ...(tools.exec ? { exec: { security: tools.exec.security, ask: tools.exec.ask } } : {}) },
  };
}

export function payloadWorkspace(payloadRoot, runtime) {
  return runtime.payloadLayout === "agent-kit-v1" ? path.join(payloadRoot, "workspace") : payloadRoot;
}

export function verifyAgentKit(payloadRoot, options) {
  const runtime = normalizeRuntimeOptions(options);
  if (runtime.payloadLayout !== "agent-kit-v1") return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(payloadRoot, "payload-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.layout !== "agent-kit-v1" || manifest.agentId !== runtime.agentId
    || manifest.id !== runtime.agentId || manifest.version !== runtime.payloadVersion || manifest.workspace !== "workspace") throw Error("AGENT_KIT_IDENTITY_MISMATCH");
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw Error("AGENT_KIT_FILES_MISSING");
  if (manifest.craft?.topLevelSkills) {
    if (!Array.isArray(manifest.craft.topLevelSkills)) throw Error("AGENT_KIT_SKILL_ALLOWLIST_MISMATCH");
    const canonical = manifest.craft.topLevelSkills.map(skill => skill.name).sort();
    if (canonical.length !== manifest.craft.topLevelSkillCount || !runtime.skills ||
      JSON.stringify([...runtime.skills].sort()) !== JSON.stringify(canonical)) throw Error("AGENT_KIT_SKILL_ALLOWLIST_MISMATCH");
  }
  const declared = new Set();
  for (const file of manifest.files) {
    const rel = relativePath(file.path);
    if (declared.has(rel)) throw Error("AGENT_KIT_DUPLICATE_FILE");
    declared.add(rel);
  }
  const inspect = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory)) {
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const filename = path.join(directory, entry);
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory()) inspect(filename, rel);
      else if (!stat.isFile() || (rel !== "payload-manifest.json" && !declared.has(rel))) throw Error("AGENT_KIT_UNDECLARED_FILE");
    }
  };
  inspect(payloadRoot);
  // Check all ancestors before reading a declared file: a symlink directory
  // must never turn checksum verification into a read outside this payload.
  for (const file of manifest.files) {
    const filename = path.join(payloadRoot, file.path);
    if (!fs.lstatSync(filename).isFile()) throw Error("AGENT_KIT_FILE_TYPE_INVALID");
    const bytes = fs.readFileSync(filename);
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw Error("AGENT_KIT_CHECKSUM_MISMATCH");
  }
  for (const plugin of runtime.plugins) {
    if (!manifest.plugins?.some(item => item.id === plugin.id && item.path === plugin.path)) throw Error("AGENT_KIT_PLUGIN_MISMATCH");
    const native = JSON.parse(fs.readFileSync(path.join(payloadRoot, plugin.path, "openclaw.plugin.json"), "utf8"));
    if (native.id !== plugin.id) throw Error("AGENT_KIT_PLUGIN_ID_MISMATCH");
  }
  if (!fs.statSync(payloadWorkspace(payloadRoot, runtime)).isDirectory()) throw Error("AGENT_KIT_WORKSPACE_MISSING");
  return manifest;
}

/** Validate a release before creating any billed sandbox. Never extract links. */
export function verifyAgentKitArchive(archive, runtime) {
  if (normalizeRuntimeOptions(runtime).payloadLayout !== "agent-kit-v1") return null;
  const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).trim().split("\n");
  for (const name of names) {
    const cleaned = name.replace(/^\.\//, "").replace(/\/$/, "");
    if (cleaned && cleaned !== ".") relativePath(cleaned);
  }
  const listing = execFileSync("tar", ["-tvf", archive], { encoding: "utf8" });
  if (listing.split("\n").filter(Boolean).some(line => !["-", "d"].includes(line[0]))) throw Error("AGENT_KIT_ARCHIVE_LINK_FORBIDDEN");
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-agent-kit-"));
  try {
    execFileSync("tar", ["-xf", archive, "-C", extracted]);
    return verifyAgentKit(extracted, runtime);
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

export function seedWorkspace(payloadRoot, dataRoot, options) {
  const runtime = normalizeRuntimeOptions(options);
  verifyAgentKit(payloadRoot, runtime);
  const marker = path.join(dataRoot, "seeded");
  const identity = JSON.stringify({ agentId: runtime.agentId, payloadVersion: runtime.payloadVersion, payloadLayout: runtime.payloadLayout });
  if (fs.existsSync(marker)) {
    const prior = fs.readFileSync(marker, "utf8");
    const legacy = runtime.agentId === "dealclaw" && runtime.payloadVersion === "dealclaw-2026-09-14" && prior === "dealclaw-2026-09-14";
    if (prior !== identity && !legacy) throw Error("PAYLOAD_MIGRATION_REQUIRED");
    return false;
  }
  const workspace = path.join(dataRoot, "workspace");
  fs.mkdirSync(dataRoot, { recursive: true });
  if (fs.existsSync(workspace) && fs.readdirSync(workspace).length) throw Error("UNSEEDED_WORKSPACE_NOT_EMPTY");
  fs.cpSync(payloadWorkspace(payloadRoot, runtime), workspace, { recursive: true });
  fs.writeFileSync(marker, identity);
  return true;
}

export function createOpenClawConfig({ runtime: input, workspace, payloadRoot, schedulerPath, modelId, gatewayPort = 18790, modelProxyPort = 18791 }) {
  const runtime = normalizeRuntimeOptions(input);
  return {
    gateway: { mode: "local", bind: "loopback", port: gatewayPort, auth: { mode: "token", token: "${NEXUS_GATEWAY_TOKEN}" }, http: { endpoints: { responses: { enabled: true } } } },
    models: { mode: "merge", providers: { nexus: { baseUrl: `http://127.0.0.1:${modelProxyPort}/v1`, api: "openai-completions", apiKey: "${NEXUS_MODEL_KEY}", models: [{ id: modelId, name: runtime.displayName, input: runtime.modelInput, contextWindow: 200000, maxTokens: 8192 }] } } },
    agents: { defaults: { workspace, ...(runtime.payloadLayout === "agent-kit-v1" ? { skipBootstrap: true } : {}), thinkingDefault: "off", model: { primary: `nexus/${modelId}` }, timeoutSeconds: 600, maxConcurrent: 1, heartbeat: { every: "0m" }, memorySearch: { enabled: false }, compaction: { mode: "safeguard" } }, list: [{ id: runtime.agentId, default: true, workspace, ...(runtime.skills !== undefined ? { skills: runtime.skills } : {}), ...(runtime.skillsLimits !== undefined ? { skillsLimits: runtime.skillsLimits } : {}) }] },
    tools: { ...runtime.tools, exec: sandboxExecPolicy(path.dirname(workspace)), elevated: { enabled: false } },
    plugins: { enabled: true, allow: ["nexus-scheduler", ...runtime.plugins.map(plugin => plugin.id)], load: { paths: [schedulerPath, ...runtime.plugins.map(plugin => path.join(payloadRoot, plugin.path))] }, entries: { "nexus-scheduler": { enabled: true }, ...Object.fromEntries(runtime.plugins.map(plugin => [plugin.id, { enabled: true, config: plugin.config }])) } },
  };
}


// A credential-free profile is baked into the selected snapshot. Never derive it
// from the controller's latest template pointer when resuming an older tenant.
function assertNoInlineSecrets(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(apiKey|token|password|authorization|credentials|privateKey|secret)$/i.test(key)) throw Error("AGENT_KIT_INLINE_SECRET_FORBIDDEN");
    assertNoInlineSecrets(nested);
  }
}

export function readAgentKitProfile(filename, agentId, expectedVersion) {
  if (!fs.existsSync(filename)) return null;
  const profile = JSON.parse(fs.readFileSync(filename, "utf8"));
  assertNoInlineSecrets(profile);
  const runtime = normalizeRuntimeOptions(profile.runtime);
  if (profile.schemaVersion !== 1 || profile.templateId !== agentId || runtime.agentId !== agentId
    || runtime.payloadLayout !== "agent-kit-v1" || profile.version !== runtime.payloadVersion
    || !/^[a-f0-9]{64}$/.test(profile.archiveSha256) || !/^[a-f0-9]{40}$/.test(profile.sourceCommit)) throw Error("AGENT_KIT_PROFILE_INVALID");
  if (expectedVersion && profile.version !== expectedVersion) throw Error("AGENT_KIT_TENANT_VERSION_MISMATCH");
  return { ...profile, runtime };
}

export function createAgentKitProfile(archive, input, templateId) {
  assertNoInlineSecrets(input);
  const runtime = normalizeRuntimeOptions(input);
  if (runtime.agentId !== templateId || runtime.payloadLayout !== "agent-kit-v1") throw Error("AGENT_KIT_PROFILE_INVALID");
  const manifest = verifyAgentKitArchive(archive, runtime);
  const sourceCommit = manifest?.sources?.repositoryCommit;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw Error("AGENT_KIT_SOURCE_COMMIT_REQUIRED");
  return { schemaVersion: 1, templateId, version: runtime.payloadVersion, runtime,
    archiveSha256: createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), sourceCommit };
}

export function assertAgentKitNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (!(major > 24 || (major === 24 && minor >= 19))) throw Error("AGENT_KIT_NODE_REQUIRES_24_19");
}

export function agentKitFingerprint(profile, env = process.env) {
  if (!profile) return [];
  // Hashes only: changed or revoked tenant credentials cannot reuse a healthy
  // Gateway with stale process env. The profile/key values never enter a file.
  return [JSON.stringify(profile), ...profile.runtime.envKeys.map(key => `${key}=${env[key] ?? ""}`)];
}
