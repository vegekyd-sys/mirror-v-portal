import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Sandbox } from "@vercel/sandbox";
import { loadConfig } from "../src/config.js";
import { resolveTemplatePayload, templateRecord, TEMPLATE_OPENCLAW_VERSION, TEMPLATE_SNAPSHOT_TTL_MS, type TemplatePayload } from "../src/template-payload.js";

const config = loadConfig();
const root = path.resolve("../..");
const templateId = process.argv[2] === "--template" ? process.argv[3] : "legacy";
// Any in-repo template with a payload manifest can be built; see src/template-payload.ts.
const template: TemplatePayload | undefined = templateId === "legacy" ? undefined : resolveTemplatePayload(root, templateId);
const payloadArchiveArg = process.argv.indexOf("--payload-archive");
const privatePayloadArchive = payloadArchiveArg >= 0 ? process.argv[payloadArchiveArg + 1] : undefined;
if (privatePayloadArchive && templateId !== "mirror-v") throw new Error("PRIVATE_PAYLOAD_TEMPLATE_UNSUPPORTED");
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
  // Template CLIs go into a private venv; boot.mjs puts tools/bin on PATH.
  // Only the private V001 archive path carries no manifest tools.
  if (template?.wheels.length && !privatePayloadArchive) {
    const tools = "/vercel/sandbox/nexus/tools";
    await run("tools-python", "dnf", ["install", "-y", "python3", "python3-pip"], true);
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
