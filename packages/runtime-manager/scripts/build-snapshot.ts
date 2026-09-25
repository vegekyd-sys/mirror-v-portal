import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Sandbox } from "@vercel/sandbox";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const root = path.resolve("../..");
const templateId = process.argv[2] === "--template" ? process.argv[3] : "dealclaw";
if (!["dealclaw", "mirror-v"].includes(templateId)) throw new Error("UNKNOWN_TEMPLATE");
// A payload can come from two places, and they nest differently:
//   - the in-repo payload, produced by git archive at packages/dealclaw-agent/payload/
//   - an external archive (config.payloadArchive) already rooted at the workspace,
//     e.g. an agent exported from another host. Kept out of git: these run to
//     hundreds of MB and carry an agent's accumulated memory.
const external = templateId === "dealclaw" ? config.payloadArchive : undefined;
let archive: string;
let stripComponents: number;
if (external) {
  archive = path.isAbsolute(external) ? external : path.join(config.dataDir, external);
  if (!fs.existsSync(archive)) throw new Error(`PAYLOAD_ARCHIVE_MISSING: ${archive}`);
  stripComponents = 1; // entries are ./AGENTS.md, ./memory/...
  console.log(JSON.stringify({ phase: "payload-external", archive, bytes: fs.statSync(archive).size }));
} else {
  const payloadPath = templateId === "dealclaw"
    ? "packages/dealclaw-agent/payload"
    : "packages/agent-templates/mirror-v/payload";
  archive = path.join(config.dataDir, `${templateId}-payload.tar`);
  stripComponents = templateId === "dealclaw" ? 3 : 4;
  // Only version-controlled payload, never local customer data or environment files.
  execFileSync(
    "git",
    ["archive", "--format=tar", "--output", archive, "HEAD", payloadPath],
    { cwd: root },
  );
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
  if (templateId === "dealclaw") saved.snapshotId = snapshot.snapshotId;
  else {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "packages/agent-templates/mirror-v/payload/payload-manifest.json"), "utf8"));
    saved.templates = { ...saved.templates, [templateId]: { version: manifest.version, snapshotId: snapshot.snapshotId } };
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
