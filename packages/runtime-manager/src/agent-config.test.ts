import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeRuntimeOptions, createOpenClawConfig, seedWorkspace, verifyAgentKit, verifyAgentKitArchive } from "../runtime/agent-config.mjs";

const makaron = normalizeRuntimeOptions({
  agentId: "makaron", displayName: "Makaron", payloadVersion: "makaron.v1.0.0", payloadLayout: "agent-kit-v1",
  modelInput: ["text", "image"], mediaBinaries: true,
  envKeys: ["MAKARON_API_KEY"], plugins: [{ id: "makaron-tools", path: "plugins/makaron-tools", config: { apiKeyEnv: "MAKARON_API_KEY" } }],
  tools: { alsoAllow: ["makaron-tools", "image"], deny: ["cron", "gateway", "image_generate", "video_generate", "music_generate", "tts"], exec: { security: "full", ask: "off" } },
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-makaron-test-"));
  const payload = path.join(root, "payload");
  const files = { "workspace/AGENTS.md": "Makaron media agent", "workspace/skills/image/SKILL.md": "image skill", "plugins/makaron-tools/openclaw.plugin.json": JSON.stringify({ id: "makaron-tools" }), "plugins/makaron-tools/index.js": "export default {register(){}};" };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(payload, rel)), { recursive: true });
    fs.writeFileSync(path.join(payload, rel), content);
  }
  fs.writeFileSync(path.join(payload, "payload-manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "makaron", agentId: "makaron", layout: "agent-kit-v1", version: "makaron.v1.0.0", workspace: "workspace", plugins: [{ id: "makaron-tools", path: "plugins/makaron-tools" }],
    files: Object.entries(files).map(([rel, content]) => ({ path: rel, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") })),
  }));
  return { root, payload, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("versioned OpenClaw agent profile", () => {
  it("keeps the DealClaw defaults, scheduler and current tool restrictions", () => {
    const cfg = createOpenClawConfig({ workspace: "/private/workspace", payloadRoot: "/immutable/payload", schedulerPath: "/scheduler", modelId: "deepseek-flash" });
    expect(cfg.agents.list).toEqual([{ id: "dealclaw", default: true, workspace: "/private/workspace" }]);
    expect(cfg.plugins.allow).toEqual(["nexus-scheduler"]);
    expect(cfg.tools).toEqual({ profile: "coding", alsoAllow: ["portal_schedule", "portal_environment"], deny: ["cron", "gateway", "sessions_spawn", "sessions_send"], exec: { host: "gateway", security: "full", ask: "off", pathPrepend: ["/private/npm/bin"] }, elevated: { enabled: false } });
    expect(cfg.gateway.auth.token).toBe("${NEXUS_GATEWAY_TOKEN}");
    expect(cfg.models.providers.nexus.models[0].input).toEqual(["text"]);
    expect(cfg.agents.defaults.skipBootstrap).toBeUndefined();
    expect(normalizeRuntimeOptions().mediaBinaries).toBe(false);
  });
  it("loads the Makaron native plugin into a distinct agent without embedding runtime keys", () => {
    const cfg = createOpenClawConfig({ runtime: makaron, workspace: "/tenant/workspace", payloadRoot: "/immutable/payload", schedulerPath: "/scheduler", modelId: "test-model" });
    expect(cfg.agents.list[0].id).toBe("makaron");
    expect(cfg.plugins.load.paths).toContain("/immutable/payload/plugins/makaron-tools");
    expect(cfg.plugins.entries["makaron-tools"].config.apiKeyEnv).toBe("MAKARON_API_KEY");
    expect(cfg.tools.alsoAllow).toContain("makaron-tools");
    expect(cfg.tools.alsoAllow).toContain("image");
    expect(cfg.tools.exec).toEqual({ host: "gateway", security: "full", ask: "off", pathPrepend: ["/tenant/npm/bin"] });
    expect(cfg.models.providers.nexus.models[0].input).toEqual(["text", "image"]);
    expect(cfg.agents.defaults.skipBootstrap).toBe(true);
    expect(cfg.tools.deny).not.toContain("sessions_spawn");
    expect(cfg.tools.deny).toEqual(["cron", "gateway", "image_generate", "video_generate", "music_generate", "tts"]);
    expect(JSON.stringify(cfg)).not.toContain("mk_live_");
  });
  it("rejects cross-runtime paths, duplicate plugin identity, and privileged env replacement", () => {
    expect(() => normalizeRuntimeOptions({ plugins: [{ id: "makaron-tools", path: "../private" }] })).toThrow("INVALID_PAYLOAD_PATH");
    expect(() => normalizeRuntimeOptions({ plugins: [{ id: "nexus-scheduler", path: "plugins/a" }] })).toThrow("INVALID_RUNTIME_PLUGIN_ID");
    expect(() => normalizeRuntimeOptions({ envKeys: ["OPENCLAW_STATE_DIR"] })).toThrow("INVALID_RUNTIME_ENV_KEYS");
    expect(() => normalizeRuntimeOptions({ agentId: "../v" })).toThrow("INVALID_RUNTIME_AGENT_ID");
    expect(() => normalizeRuntimeOptions({ modelInput: ["audio"] as any })).toThrow("INVALID_RUNTIME_MODEL_INPUT");
    expect(() => normalizeRuntimeOptions({ mediaBinaries: "yes" as any })).toThrow("INVALID_RUNTIME_MEDIA_BINARIES");
    expect(() => normalizeRuntimeOptions({ tools: { exec: { security: "unexpected", ask: "off" } as any } })).toThrow("INVALID_RUNTIME_EXEC");
    expect(() => normalizeRuntimeOptions({ skills: "image" as any })).toThrow("INVALID_RUNTIME_SKILLS");
    expect(() => normalizeRuntimeOptions({ skills: ["../private"] })).toThrow("INVALID_RUNTIME_SKILLS");
    expect(() => normalizeRuntimeOptions({ skillsLimits: { maxSkillsPromptChars: -1 } })).toThrow("INVALID_RUNTIME_SKILLS_LIMITS");
    expect(() => normalizeRuntimeOptions({ skillsLimits: { maxSkillsPromptChars: "64000" } as any })).toThrow("INVALID_RUNTIME_SKILLS_LIMITS");
  });
  it("keeps the canonical skill allowlist in the selected agent without changing legacy defaults", () => {
    const runtime = normalizeRuntimeOptions({ ...makaron, skills: ["video-edit", "anchor", "video-edit", "storyboard"], skillsLimits: { maxSkillsPromptChars: 64000 } });
    const cfg = createOpenClawConfig({ runtime, workspace: "/tenant/workspace", payloadRoot: "/immutable/payload", schedulerPath: "/scheduler", modelId: "test-model" });
    expect(runtime.skills).toEqual(["video-edit", "anchor", "storyboard"]);
    expect(cfg.agents.list[0].skills).toEqual(["video-edit", "anchor", "storyboard"]);
    expect(cfg.agents.list[0].skills).not.toContain("remotion-video-director");
    expect(normalizeRuntimeOptions().skills).toBeUndefined();
    expect(cfg.agents.list[0].skillsLimits).toEqual({ maxSkillsPromptChars: 64000 });
    expect(normalizeRuntimeOptions().skillsLimits).toBeUndefined();
    const empty = createOpenClawConfig({ runtime: { ...makaron, skills: [] }, workspace: "/tenant/workspace", payloadRoot: "/immutable/payload", schedulerPath: "/scheduler", modelId: "test-model" });
    expect(empty.agents.list[0].skills).toEqual([]);
  });
  it("rejects a skill catalog mismatch before payload seeding or billed archive creation", () => {
    const f = fixture();
    try {
      const manifestPath = path.join(f.payload, "payload-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.craft = { topLevelSkillCount: 2, topLevelSkills: [{ name: "anchor" }, { name: "image" }] };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => verifyAgentKit(f.payload, makaron)).toThrow("AGENT_KIT_SKILL_ALLOWLIST_MISMATCH");
      expect(() => verifyAgentKit(f.payload, { ...makaron, skills: ["anchor"] })).toThrow("AGENT_KIT_SKILL_ALLOWLIST_MISMATCH");
      expect(() => seedWorkspace(f.payload, path.join(f.root, "rejected"), { ...makaron, skills: ["image", "remotion-video-director"] })).toThrow("AGENT_KIT_SKILL_ALLOWLIST_MISMATCH");
      expect(fs.existsSync(path.join(f.root, "rejected"))).toBe(false);
      expect(verifyAgentKit(f.payload, { ...makaron, skills: ["image", "anchor"] })?.id).toBe("makaron");
      const archive = path.join(f.root, "kit-with-catalog.tar");
      execFileSync("tar", ["-cf", archive, "-C", f.payload, "."]);
      expect(() => verifyAgentKitArchive(archive, { ...makaron, skills: ["image"] })).toThrow("AGENT_KIT_SKILL_ALLOWLIST_MISMATCH");
    } finally { f.cleanup(); }
  });
  it("verifies the actual archive identity, byte hashes and plugin ID before runtime creation", () => {
    const f = fixture();
    try {
      const archive = path.join(f.root, "kit.tar");
      execFileSync("tar", ["-cf", archive, "-C", f.payload, "."]);
      expect(verifyAgentKitArchive(archive, makaron)?.id).toBe("makaron");
      fs.appendFileSync(path.join(f.payload, "workspace/AGENTS.md"), "modified");
      expect(() => verifyAgentKit(f.payload, makaron)).toThrow("AGENT_KIT_CHECKSUM_MISMATCH");
    } finally { f.cleanup(); }
  });
  it("never seeds a mismatched release or allows a symlink archive", () => {
    const f = fixture();
    try {
      expect(() => verifyAgentKit(f.payload, { ...makaron, payloadVersion: "makaron.v2" })).toThrow("AGENT_KIT_IDENTITY_MISMATCH");
      fs.symlinkSync("/private", path.join(f.payload, "workspace/escape"));
      const archive = path.join(f.root, "bad.tar");
      execFileSync("tar", ["-cf", archive, "-C", f.payload, "."]);
      expect(() => verifyAgentKitArchive(archive, makaron)).toThrow("AGENT_KIT_ARCHIVE_LINK_FORBIDDEN");
    } finally { f.cleanup(); }
  });
  it("seeds only workspace and preserves edited files and session state on reuse", () => {
    const f = fixture();
    try {
      const data = path.join(f.root, "data");
      expect(seedWorkspace(f.payload, data, makaron)).toBe(true);
      expect(fs.existsSync(path.join(data, "workspace/payload-manifest.json"))).toBe(false);
      expect(fs.existsSync(path.join(data, "workspace/plugins"))).toBe(false);
      fs.writeFileSync(path.join(data, "workspace/AGENTS.md"), "user edit");
      fs.mkdirSync(path.join(data, "state"));
      fs.writeFileSync(path.join(data, "state/session.json"), "persisted session");
      expect(seedWorkspace(f.payload, data, makaron)).toBe(false);
      expect(fs.readFileSync(path.join(data, "workspace/AGENTS.md"), "utf8")).toBe("user edit");
      expect(fs.readFileSync(path.join(data, "state/session.json"), "utf8")).toBe("persisted session");
      fs.writeFileSync(path.join(data, "seeded"), "dealclaw-2026-09-14");
      expect(() => seedWorkspace(f.payload, data, makaron)).toThrow("PAYLOAD_MIGRATION_REQUIRED");
    } finally { f.cleanup(); }
  });
  it("accepts an existing DealClaw legacy marker without overwriting its workspace", () => {
    const f = fixture();
    try {
      const data = path.join(f.root, "old");
      fs.mkdirSync(path.join(data, "workspace"), { recursive: true });
      fs.writeFileSync(path.join(data, "seeded"), "dealclaw-2026-09-14");
      fs.writeFileSync(path.join(data, "workspace/customer.md"), "retained");
      expect(seedWorkspace(f.payload, data, normalizeRuntimeOptions())).toBe(false);
      expect(fs.readFileSync(path.join(data, "workspace/customer.md"), "utf8")).toBe("retained");
    } finally { f.cleanup(); }
  });
  it("backs up and restores a Makaron session against its versioned workspace base", () => {
    const f = fixture();
    try {
      const runtimeRoot = path.join(f.root, "runtime");
      const payload = path.join(runtimeRoot, "nexus/payload");
      const data = path.join(runtimeRoot, "agent-data");
      fs.cpSync(f.payload, payload, { recursive: true });
      seedWorkspace(payload, data, makaron);
      fs.writeFileSync(path.join(runtimeRoot, "nexus/agent-kit-runtime.json"), JSON.stringify({schemaVersion:1, templateId:"makaron", version:makaron.payloadVersion, runtime:makaron, archiveSha256:"a".repeat(64), sourceCommit:"b".repeat(40)}));
      fs.writeFileSync(path.join(data, "workspace/AGENTS.md"), "changed by user");
      fs.unlinkSync(path.join(data, "workspace/skills/image/SKILL.md"));
      fs.writeFileSync(path.join(data, "workspace/project.md"), "creative decision");
      fs.mkdirSync(path.join(data, "state"));
      fs.writeFileSync(path.join(data, "state/session.json"), '{"messages":["keep subject"]}');
      const archive = path.join(f.root, "state.tgz");
      execFileSync(process.execPath, [fileURLToPath(new URL("../runtime/backup.mjs", import.meta.url))], { env: { ...process.env, NEXUS_BACKUP_ROOT: runtimeRoot, NEXUS_BACKUP_ARCHIVE: archive, NEXUS_AGENT_ID: "makaron" } });
      const restored = path.join(f.root, "restored");
      fs.cpSync(payload, path.join(restored, "nexus/payload"), { recursive: true });
      seedWorkspace(path.join(restored, "nexus/payload"), path.join(restored, "agent-data"), makaron);
      execFileSync("tar", ["-xzf", archive, "-C", restored]);
      const backup = JSON.parse(fs.readFileSync(path.join(restored, "agent-data/.nexus-backup.json"), "utf8"));
      expect(backup).toMatchObject({ agentId: "makaron", basePayload: "makaron.v1.0.0", payloadLayout: "agent-kit-v1" });
      expect(backup.removed).toContain("skills/image/SKILL.md");
      for (const rel of backup.removed) fs.rmSync(path.join(restored, "agent-data/workspace", rel), { recursive: true, force: true });
      expect(fs.readFileSync(path.join(restored, "agent-data/workspace/AGENTS.md"), "utf8")).toBe("changed by user");
      expect(fs.readFileSync(path.join(restored, "agent-data/workspace/project.md"), "utf8")).toBe("creative decision");
      expect(fs.readFileSync(path.join(restored, "agent-data/state/session.json"), "utf8")).toContain("keep subject");
      expect(seedWorkspace(path.join(restored, "nexus/payload"), path.join(restored, "agent-data"), makaron)).toBe(false);
    } finally { f.cleanup(); }
  });
});
