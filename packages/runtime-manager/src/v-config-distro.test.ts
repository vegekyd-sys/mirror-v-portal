import { expect, test } from "vitest";
import { createVReleaseConfig } from "../runtime/v-config.mjs";
// The v-distro package's openclaw.json generator, vendored byte for byte (package-v-release.sh
// refuses a package whose config/openclaw-config.mjs differs, so this test sees the same code).
// @ts-expect-error plain .mjs without types
import { createConfig } from "../../../deploy/v-release/v-distro-config.mjs";

const env = { DEEPSEEK_API_KEY: "k", GOOGLE_API_KEY: "g", XAI_API_KEY: "x", V_OWNER_NAME: "o" };
const distro = createConfig({ profile: "sandbox", releaseDir: "/R", stateDir: "/d/state", workspace: "/w", env, codexCommand: "/c/codex", agentId: "mirror-v-full" });
const mirror = createVReleaseConfig({
  agentId: "mirror-v-full", workspace: "/w", dataDir: "/d", schedulerPath: "/s", workerPluginPath: "/wk",
  env, codexCommand: "/c/codex", deepseekTimeoutSeconds: 90, pluginIds: ["parallel"],
});

// Display names of models are cosmetic; everything else in a model entry must agree.
const unnamed = (cfg: any) => {
  const copy = structuredClone(cfg);
  for (const provider of Object.values<any>(copy.models.providers)) provider.models = provider.models.map(({ name: _name, ...model }: any) => model);
  return copy;
};
const flat = (value: any, prefix = "", out: Record<string, string> = {}) => {
  if (value && typeof value === "object" && !Array.isArray(value)) for (const key of Object.keys(value)) flat(value[key], prefix ? `${prefix}.${key}` : key, out);
  else out[prefix] = JSON.stringify(value);
  return out;
};

/**
 * Where the sandbox's openclaw.json differs from the v-distro "sandbox" profile, and why.
 * portal: the Portal architecture (scheduler, channel edge, sandbox paths and secrets).
 * mirror: a product choice made for Mirror V.
 * open:   V behaviour not (yet) in Mirror; changing it changes every tenant, so it is decided on its own.
 * distro: the package's profile should change (reported to the A line).
 */
const DIFFERENCES: Record<string, [kind: "portal" | "mirror" | "open" | "distro", why: string]> = {
  "gateway.auth.token": ["portal", "the manager injects NEXUS_GATEWAY_TOKEN"],
  "gateway.port": ["portal", "the Portal's runtime contract listens on 18790"],
  "gateway.reload.mode": ["distro", "a hot reload closed V's Worker pool for good (2026-09-20); the sandbox boot restarts instead"],
  "models.providers.deepseek.apiKey": ["portal", "the platform's model key arrives as NEXUS_MODEL_KEY"],
  "models.providers.deepseek.agentRuntime.id": ["open", "V sets the Worker runtime on the provider too; Mirror sets it per model"],
  "agents.list": ["portal", "Mirror writes agents.list; 2026.9.1 migrates it to agents.entries on start"],
  "agents.entries.mirror-v-full.workspace": ["portal", "see agents.list"],
  "agents.defaults.timeoutSeconds": ["mirror", "a turn ends before the Portal's 10-minute delivery window"],
  "agents.defaults.maxConcurrent": ["mirror", "one owner on a 2-vCPU sandbox"],
  "agents.defaults.subagents.maxConcurrent": ["mirror", "same"],
  "agents.defaults.subagents.announceTimeoutMs": ["open", "V's subagent announce window"],
  "agents.defaults.thinkingDefault": ["open", "V thinks by default; Mirror sets thinking per model"],
  "agents.defaults.reasoningDefault": ["open", "V's default"],
  "agents.defaults.typingMode": ["portal", "typing state is drawn by the Portal's channel edge"],
  "agents.defaults.modelSelectionScope": ["open", "V's /model applies per session"],
  "agents.defaults.compaction.notifyUser": ["open", "V tells the user when it compacts; behind the Portal that would be an extra message"],
  "messages.visibleReplies": ["portal", "the Portal delivers exactly one reply per turn"],
  "messages.groupChat.historyLimit": ["portal", "group context is assembled by the Portal"],
  "messages.groupChat.visibleReplies": ["portal", "same"],
  "messages.queue.mode": ["open", "V lets a new message steer a running turn; the Portal queues turns per tenant"],
  "messages.queue.cap": ["open", "same"],
  "messages.queue.drop": ["open", "same"],
  "messages.queue.debounceMsByChannel.feishu": ["portal", "no Feishu channel inside the sandbox"],
  "commands.native": ["portal", "slash commands arrive through the Portal"],
  "commands.nativeSkills": ["portal", "same"],
  "commands.restart": ["portal", "the agent cannot restart its own runtime in a sandbox"],
  "skills.install.nodeManager": ["open", "V's skill installer setting"],
  "plugins.allow": ["portal", "nexus-scheduler and parallel added, v-session-relay left out (no cross-session channels)"],
  "plugins.load.paths": ["portal", "plugins live under /vercel/sandbox/nexus"],
  "plugins.entries.nexus-scheduler.enabled": ["portal", "portal_schedule: a sleeping sandbox runs no timers"],
  "plugins.entries.parallel.enabled": ["mirror", "free web search without a key"],
  "plugins.entries.v-session-relay.enabled": ["portal", "see plugins.allow"],
  "plugins.entries.v-session-relay.config.ownerName": ["portal", "same"],
  "plugins.entries.v-session-relay.config.workerGuard": ["portal", "same"],
  "plugins.entries.vlab-agent-worker-isolation.config.maxWorkers": ["mirror", "2-vCPU sandbox"],
  "plugins.entries.vlab-agent-worker-isolation.config.workerConfigPath": ["portal", "config lives in agent-data, not the state dir"],
  "plugins.entries.vlab-agent-worker-isolation.config.gatewayConfigPath": ["portal", "same"],
  "session.maintenance.maxDiskBytes": ["mirror", "sandbox disk and per-turn backups"],
  "tools.alsoAllow": ["portal", "portal_schedule / portal_environment"],
  "tools.deny": ["distro", "message has no channel behind the Portal (v21 lost an image to internal-ui); the sandbox profile should deny it too"],
  "tools.exec.pathPrepend": ["portal", "the agent's global npm bin in agent-data"],
  "tools.web.search.provider": ["mirror", "Parallel (free) instead of DeepSeek search"],
  "tools.web.fetch.provider": ["mirror", "same"],
};

test("the sandbox config matches the v-distro sandbox profile except where a reason is written down", () => {
  const a = flat(unnamed(distro));
  const m = flat(unnamed(mirror));
  const differing = [...new Set([...Object.keys(a), ...Object.keys(m)])].filter((key) => a[key] !== m[key]).sort();
  // A new difference needs a reason; a listed one that went away is removed from the list.
  expect(differing).toEqual(Object.keys(DIFFERENCES).sort());
});

test("model setup, Worker pool, Codex harness and memory are the distro's", () => {
  expect(unnamed(mirror).models.providers.deepseek.models).toEqual(unnamed(distro).models.providers.deepseek.models);
  expect(mirror.agents.defaults.model).toEqual(distro.agents.defaults.model);
  expect(mirror.agents.defaults.models).toEqual(distro.agents.defaults.models);
  expect(mirror.plugins.entries.codex).toEqual(distro.plugins.entries.codex);
  expect(mirror.memory).toEqual(distro.memory);
  expect(mirror.models.providers.deepseek.timeoutSeconds).toBe(distro.models.providers.deepseek.timeoutSeconds);
});
