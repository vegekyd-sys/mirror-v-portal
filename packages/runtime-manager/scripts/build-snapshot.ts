import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Sandbox } from "@vercel/sandbox";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const root = path.resolve("../..");
const templateId = process.argv[2] === "--template" ? process.argv[3] : "legacy";
if (!["legacy", "dealclaw", "mirror-v"].includes(templateId)) throw new Error("UNKNOWN_TEMPLATE");
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
  const payloadPath = `packages/agent-templates/${templateId}/payload`;
  archive = path.join(config.dataDir, `${templateId}-payload.tar`);
  // The VLab release is a git archive without .git. Package an explicit
  // public allowlist so stale files or private memories can never join it.
  const files = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "payload-manifest.json"];
  execFileSync("tar", ["-cf", archive, "-C", path.join(root, payloadPath), ...files]);
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
    "openclaw@2026.7.1",
  ]);
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
  const snapshot = await sbx.snapshot({ expiration: 30 * 24 * 60 * 60 * 1000 });
  snapshotted = true;
  const file = path.join(config.dataDir, "config.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (templateId === "legacy") saved.snapshotId = snapshot.snapshotId;
  else {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, `packages/agent-templates/${templateId}/payload/payload-manifest.json`), "utf8"));
    saved.templates = { ...saved.templates, [templateId]: { version: payloadVersion || manifest.version, snapshotId: snapshot.snapshotId } };
  }
  fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      phase: "snapshot-ready",
      templateId,
      snapshotId: snapshot.snapshotId,
    }),
  );
} finally {
  if (!snapshotted) await sbx.stop().catch(() => undefined);
}
