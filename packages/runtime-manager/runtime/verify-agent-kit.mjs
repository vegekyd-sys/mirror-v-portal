// Native registration acceptance; no model request, service credential, or media generation.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { readAgentKitProfile, seedWorkspace, verifyAgentKit, createOpenClawConfig, assertAgentKitNode } from "./agent-config.mjs";

const base = path.resolve(process.argv[2] || "/vercel/sandbox/nexus");
const agentId = process.argv[3] || "makaron";
const profile = readAgentKitProfile(path.join(base, "agent-kit-runtime.json"), agentId);
if (!profile) throw Error("AGENT_KIT_PROFILE_MISSING");
assertAgentKitNode();
const manifest = verifyAgentKit(path.join(base, "payload"), profile.runtime);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-native-registry-"));
try {
  const workspace = path.join(temporary, "workspace");
  seedWorkspace(path.join(base, "payload"), temporary, profile.runtime);
  const schedulerPath = path.join(temporary, "scheduler-plugin");
  fs.mkdirSync(schedulerPath);
  fs.copyFileSync(path.join(base, "scheduler-plugin.mjs"), path.join(schedulerPath, "index.mjs"));
  fs.writeFileSync(path.join(schedulerPath, "openclaw.plugin.json"), JSON.stringify({ id: "nexus-scheduler", name: "Nexus schedules", version: "1.0.0", contracts: { tools: ["nexus_schedule"] }, activation: { onStartup: true }, configSchema: { type: "object", additionalProperties: false } }));
  const config = createOpenClawConfig({ runtime: profile.runtime, workspace, payloadRoot: path.join(base, "payload"), schedulerPath, modelId: "registry-only" });
  const configPath = path.join(temporary, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  // Placeholders satisfy native configuration validation only. No gateway/planner starts.
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_STATE_DIR = path.join(temporary, "state");
  process.env.OPENCLAW_WORKSPACE_DIR = workspace;
  process.env.NEXUS_GATEWAY_TOKEN = "registry-only-placeholder";
  process.env.NEXUS_MODEL_KEY = "registry-only-placeholder";
  delete process.env.MAKARON_API_KEY;
  const openclaw = path.join(base, "runtime/node_modules/openclaw");
  const version = execFileSync(process.execPath, [path.join(openclaw, "openclaw.mjs"), "--version"], { encoding: "utf8" }).trim();
  if (!version.includes("2026.7.1")) throw Error("AGENT_KIT_OPENCLAW_VERSION_MISMATCH");
  execFileSync(process.execPath, [path.join(openclaw, "openclaw.mjs"), "config", "validate", "--json"], { stdio: "pipe", timeout: 90_000 });
  const { resolvePluginTools } = await import(pathToFileURL(path.join(openclaw, "dist/plugins/tools.js")));
  const tools = resolvePluginTools({ context: { config, workspaceDir: workspace, agentId, sessionKey: "registry-only" }, toolAllowlist: profile.runtime.plugins.map(p => p.id), existingToolNames: new Set(), toolDenylist: profile.runtime.tools.deny });
  const names = tools.map(tool => tool.name).filter(name => name.startsWith(`${agentId}_`)).sort();
  const expected = [...(manifest.contracts?.appTools || []), "makaron_discover", "makaron_call", "makaron_project", "makaron_materialize_artifact"].sort();
  if (!names.length || JSON.stringify(names) !== JSON.stringify(expected)) throw Error(`AGENT_KIT_NATIVE_TOOLS_MISMATCH:${names.length}/${expected.length}`);
  // OpenClaw 7.1's stable public wrapper re-exports the actual workspace resolver.
  const dist = path.join(openclaw, "dist");
  const wrapper = fs.readdirSync(dist).filter(file => /^workspace-.*\.js$/.test(file)).find(file => /export \{[^\n]*\bbuildWorkspaceSkillSnapshot(?:,|\s*\})/.test(fs.readFileSync(path.join(dist, file), "utf8")));
  if (!wrapper) throw Error("OPENCLAW_SKILL_SNAPSHOT_EXPORT_MISSING");
  const { buildWorkspaceSkillSnapshot } = await import(pathToFileURL(path.join(dist, wrapper)));
  const skills = buildWorkspaceSkillSnapshot(workspace, { config, agentId });
  const skillNames = skills.skills.map(skill => skill.name).sort();
  if (JSON.stringify(skillNames) !== JSON.stringify([...profile.runtime.skills].sort()) || /truncat/i.test(skills.prompt)) throw Error("AGENT_KIT_NATIVE_SKILLS_MISMATCH");
  const evidence = { schemaVersion: 1, mode: "native-openclaw-no-planner-no-network-no-credentials", agentId, payloadVersion: profile.version, sourceCommit: profile.sourceCommit, sourceTrees: manifest.sources?.sourceTrees,
    archiveSha256: profile.archiveSha256, node: process.versions.node, openclaw: version,
    tools: { count: names.length, names }, skills: { count: skillNames.length, names: skillNames, promptChars: skills.prompt.length, truncated: false }, configValid: true };
  fs.writeFileSync(path.join(base, "agent-kit-native-evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ phase: "agent-kit-native-verified", node: evidence.node, openclaw: version, tools: names.length, skills: skillNames.length, archiveSha256: profile.archiveSha256 }));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
// Some bundled SDK modules keep background timers; registration has finished.
process.exit(0);
