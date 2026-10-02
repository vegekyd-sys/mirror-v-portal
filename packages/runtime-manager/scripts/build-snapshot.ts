import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Sandbox } from "@vercel/sandbox";
import { createAgentKitProfile } from "../runtime/agent-config.mjs";
import { MEDIA_BINARY_PACKAGES } from "../runtime/media-binaries.mjs";
import { loadConfig } from "../src/config.js";
import { resolveTemplatePayload, templateRecord, TEMPLATE_OPENCLAW_VERSION, TEMPLATE_SNAPSHOT_TTL_MS, type TemplatePayload } from "../src/template-payload.js";

const config = loadConfig();
const root = path.resolve("../..");
const templateId = process.argv[2] === "--template" ? process.argv[3] : "legacy";
const payloadArchiveArg = process.argv.indexOf("--payload-archive");
const privatePayloadArchive = payloadArchiveArg >= 0 ? process.argv[payloadArchiveArg + 1] : undefined;
const profileArg = process.argv.indexOf("--agent-kit-runtime");
const profileFilename = profileArg >= 0 ? process.argv[profileArg + 1] : undefined;
if (profileArg >= 0 && (!profileFilename || !privatePayloadArchive || templateId === "legacy")) throw Error("AGENT_KIT_RUNTIME_REQUIRED");
const agentKit = profileFilename ? createAgentKitProfile(path.resolve(privatePayloadArchive!),
  JSON.parse(fs.readFileSync(path.resolve(profileFilename), "utf8")).runtime ?? JSON.parse(fs.readFileSync(path.resolve(profileFilename), "utf8")), templateId) : undefined;
// Verify the full archive/profile before allocating a billed cloud builder.
const template: TemplatePayload | undefined = templateId === "legacy" || agentKit ? undefined : resolveTemplatePayload(root, templateId);
if (privatePayloadArchive && !agentKit && templateId !== "mirror-v") throw new Error("PRIVATE_PAYLOAD_TEMPLATE_UNSUPPORTED");
if (payloadArchiveArg >= 0 && !privatePayloadArchive) throw new Error("PAYLOAD_ARCHIVE_REQUIRED");
// A payload can come from two places, and they nest differently:
//   - the in-repo payload, produced by git archive at packages/dealclaw-agent/payload/
//   - an external archive (config.payloadArchive) already rooted at the workspace,
//     e.g. an agent exported from another host. Kept out of git: these run to
//     hundreds of MB and carry an agent's accumulated memory.
const external = templateId === "legacy" ? config.payloadArchive : undefined;
let archive: string;
let stripComponents: number;
let payloadVersion: string | undefined;
if (external) {
  archive = path.isAbsolute(external) ? external : path.join(config.dataDir, external);
  if (!fs.existsSync(archive)) throw new Error(`PAYLOAD_ARCHIVE_MISSING: ${archive}`);
  stripComponents = 1; // entries are ./AGENTS.md, ./memory/...
  console.log(JSON.stringify({ phase: "payload-external", archive, bytes: fs.statSync(archive).size }));
} else if (agentKit) {
  archive = path.resolve(privatePayloadArchive!);
  payloadVersion = agentKit.version;
  stripComponents = 0;
  console.log(JSON.stringify({ phase: "payload-agent-kit", bytes: fs.statSync(archive).size, version: payloadVersion, archiveSha256: agentKit.archiveSha256, sourceCommit: agentKit.sourceCommit }));
} else if (privatePayloadArchive) {
  archive = path.resolve(privatePayloadArchive);
  if (!fs.existsSync(archive)) throw new Error("PAYLOAD_ARCHIVE_MISSING");
  const privateManifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "payload-manifest.json"], { encoding: "utf8" }));
  if (privateManifest.name !== "mirror-v" || !/^mirror-v\.v001-full\.[a-z0-9.-]+$/.test(privateManifest.version))
    throw new Error("PRIVATE_PAYLOAD_MANIFEST_INVALID");
  payloadVersion = privateManifest.version;
  stripComponents = 0;
  console.log(JSON.stringify({ phase: "payload-v001", bytes: fs.statSync(archive).size, version: payloadVersion }));
} else if (templateId === "legacy") {
  archive = path.join(config.dataDir, "dealclaw-payload.tar");
  stripComponents = 3;
  execFileSync("git", ["archive", "--format=tar", "--output", archive, "HEAD", "packages/dealclaw-agent/payload"], { cwd: root });
} else {
  archive = path.join(config.dataDir, `${templateId}-payload.tar`);
  // The VLab release is a git archive without .git. Package the manifest's
  // explicit public allowlist so stale files or private memories can never join it.
  execFileSync("tar", ["-cf", archive, "-C", template!.dir, ...template!.files]);
  stripComponents = 0;
}
const name = `${config.sandboxPrefix}-build-${Date.now()}`;
fs.writeFileSync(
  path.join(config.dataDir, "builder.json"),
  JSON.stringify({ name }),
);
const sbx = await Sandbox.create({
  ...config.vercel,
  name,
  image: "vercel/sandbox/node:24",
  persistent: false,
  resources: { vcpus: 4 },
  timeout: 1_200_000,
  tags: { purpose: "nexus-runtime-build" },
});
console.log(JSON.stringify({ phase: "builder-created", name: sbx.name }));
let snapshotted = false;
try {
  const run = async (
    label: string,
    cmd: string,
    args: string[],
    sudo = false,
  ) => {
    console.log(JSON.stringify({ phase: label }));
    const r = await sbx.runCommand({
      cmd,
      args,
      sudo,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    if (r.exitCode) throw new Error(`${label} failed with exit ${r.exitCode}`);
  };
  await run("directories", "mkdir", [
    "-p",
    "/vercel/sandbox/nexus/runtime",
    "/vercel/sandbox/nexus/payload",
  ]);
  await sbx.writeFiles([
    { path: "/vercel/sandbox/payload.tar", content: fs.readFileSync(archive) },
  ]);
  await run("payload", "tar", [
    "-xf",
    "/vercel/sandbox/payload.tar",
    `--strip-components=${stripComponents}`,
    "-C",
    "/vercel/sandbox/nexus/payload",
  ]);
  await run("openclaw", "npm", [
    "install",
    "--prefix",
    "/vercel/sandbox/nexus/runtime",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    `openclaw@${TEMPLATE_OPENCLAW_VERSION}`,
  ]);
  if (agentKit) {
    await sbx.writeFiles([{ path: "/vercel/sandbox/nexus/agent-kit-runtime.json", content: Buffer.from(JSON.stringify(agentKit)) }]);
    await run("verify-node", "node", ["-e", 'const [a,b]=process.versions.node.split(".").map(Number); if (!(a>24 || a===24 && b>=19)) throw Error("AGENT_KIT_NODE_REQUIRES_24_19"); console.log(JSON.stringify({node:process.versions.node}));']);
    if (agentKit.runtime.mediaBinaries) await run("media-packages", "npm", ["install", "--prefix", "/vercel/sandbox/nexus/runtime", "--omit=dev", "--no-audit", "--no-fund", ...MEDIA_BINARY_PACKAGES]);
  }
  // Template CLIs go into a private venv; boot.mjs puts tools/bin on PATH.
  // Only the private V001 archive path carries no manifest tools.
  if (template?.wheels.length && !privatePayloadArchive) {
    const tools = "/vercel/sandbox/nexus/tools";
    // The node:24 builder image is Ubuntu without Python; use the distro packages.
    await run("tools-python", "bash", ["-c", "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-venv"], true);
    await run("tools-directories", "mkdir", ["-p", `${tools}/wheels`, `${tools}/bin`]);
    await sbx.writeFiles(template.wheels.map((wheel) => ({
      path: `${tools}/wheels/${path.basename(wheel)}`,
      content: fs.readFileSync(wheel),
    })));
    await run("tools-venv", "python3", ["-m", "venv", `${tools}/venv`]);
    await run("tools-install", `${tools}/venv/bin/pip`, [
      "install", "--no-cache-dir", "--disable-pip-version-check",
      ...template.wheels.map((wheel) => `${tools}/wheels/${path.basename(wheel)}`),
    ]);
    for (const command of template.commands) {
      await run(`link-${command}`, "ln", ["-sf", `${tools}/venv/bin/${command}`, `${tools}/bin/${command}`]);
      await run(`verify-${command}`, `${tools}/bin/${command}`, ["--version"]);
    }
    await run("remove-tool-wheels", "rm", ["-rf", `${tools}/wheels`]);
  }
  for (const filename of [
    "boot.mjs",
    "invoke.mjs",
    "quiesce.mjs",
    "model-proxy.mjs",
    "backup.mjs",
    "progress-patch.mjs",
    "scheduler-plugin.mjs",
    "agent-config.mjs",
    "media-binaries.mjs",
    "verify-agent-kit.mjs",
  ]) {
    await sbx.writeFiles([
      {
        path: `/vercel/sandbox/nexus/${filename}`,
        content: fs.readFileSync(
          path.join(root, "packages/runtime-manager/runtime", filename),
        ),
      },
    ]);
  }
  await run("verify-runtime", "node", [
    "/vercel/sandbox/nexus/runtime/node_modules/openclaw/openclaw.mjs",
    "--version",
  ]);
  if (agentKit) {
    if (agentKit.runtime.mediaBinaries) await run("media-binaries", "node", ["/vercel/sandbox/nexus/media-binaries.mjs", "/vercel/sandbox/nexus/runtime"]);
    await run("verify-agent-kit-native", "node", ["/vercel/sandbox/nexus/verify-agent-kit.mjs", "/vercel/sandbox/nexus", templateId]);
    const proof = await sbx.readFileToBuffer({ path: "/vercel/sandbox/nexus/agent-kit-native-evidence.json" });
    if (!proof) throw Error("AGENT_KIT_NATIVE_EVIDENCE_MISSING");
    fs.writeFileSync(path.join(config.dataDir, `${templateId}-native-evidence.json`), proof, { mode: 0o600 });
  }
  await run("remove-build-archive", "rm", [
    "-f",
    "/vercel/sandbox/payload.tar",
  ]);
  const builtAt = new Date();
  const snapshot = await sbx.snapshot({ expiration: TEMPLATE_SNAPSHOT_TTL_MS });
  snapshotted = true;
  const file = path.join(config.dataDir, "config.json");
  // Keep the previous template pointers restorable before changing them.
  const backup = `${file}.before-${templateId}-${builtAt.toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (templateId === "legacy") saved.snapshotId = snapshot.snapshotId;
  else saved.templates = {
    ...saved.templates,
    [templateId]: templateRecord(saved.templates?.[templateId], {
      version: payloadVersion || template!.manifest.version,
      snapshotId: snapshot.snapshotId,
      builtAt,
      tools: privatePayloadArchive ? undefined : template!.manifest.tools?.versions,
      ...(agentKit ? { agentKit: { archiveSha256: agentKit.archiveSha256, sourceCommit: agentKit.sourceCommit, requiredEnvKeys: agentKit.runtime.envKeys } } : {}),
    }),
  };
  fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      phase: "snapshot-ready",
      templateId,
      snapshotId: snapshot.snapshotId,
      configBackup: backup,
      listed: saved.templates?.[templateId]?.listed ?? true,
    }),
  );
} finally {
  if (!snapshotted) await sbx.stop().catch(() => undefined);
}
