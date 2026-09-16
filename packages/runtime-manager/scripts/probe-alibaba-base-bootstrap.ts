// Probe whether the built-in FC base template can be bootstrapped into a working
// OpenClaw runtime at wake time, so a custom FC image (which requires a paid ACR EE
// instance in the same account/region) is not on the critical path.
//
// Three facts this must establish, because each one has already cost us a run:
//   1. base runs as uid 1000 `user` and has no /vercel, so the Vercel path
//      contract has to be recreated with sudo.
//   2. base ships node v20, but openclaw@2026.7.1 requires
//      >=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0 — node must be supplied.
//   3. the cost model depends on this surviving pause/resume, so the install
//      happens once per Agent rather than once per message.
import fs from "node:fs";
import path from "node:path";
import { Sandbox } from "e2b";
import { loadConfig } from "../src/config.js";
import { alibabaOptions } from "../src/alibaba-provider.js";

const config = loadConfig(), options = alibabaOptions(config);
const report: Record<string, unknown> = { region: config.alibaba!.region, startedAt: new Date().toISOString() };
const ids: string[] = [];
const ROOT = "/vercel/sandbox/nexus";
const RUNTIME = `${ROOT}/runtime`;
const NODE_DIR = `${ROOT}/node`;
const NODE_VERSION = "v24.21.0";
const PATH_PREFIX = `export PATH=${NODE_DIR}/bin:$PATH &&`;

// e2b throws CommandExitError with an empty message on non-zero exit, which hides
// the real failure. Normalize to a result so exitCode and stderr survive.
async function run(box: Sandbox, cmd: string, timeoutMs = 120_000) {
  try {
    const r = await box.commands.run(cmd, { timeoutMs });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  } catch (e: any) {
    if (typeof e?.exitCode === "number") return { exitCode: e.exitCode, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    throw e;
  }
}

const step = async (box: Sandbox, label: string, cmd: string, timeoutMs = 120_000) => {
  const at = Date.now();
  const r = await run(box, cmd, timeoutMs);
  report[`${label}Ms`] = Date.now() - at;
  if (r.exitCode !== 0) {
    report[`${label}Exit`] = r.exitCode;
    report[`${label}Stderr`] = r.stderr.slice(-1200);
    throw Error(`${label.toUpperCase()}_FAILED`);
  }
  return r;
};

try {
  let at = Date.now();
  const box = await Sandbox.create("base", { ...options, timeoutMs: 900_000 });
  ids.push(box.sandboxId);
  report.createMs = Date.now() - at;
  report.baseNode = (await run(box, "node --version || echo NO_NODE")).stdout.trim();

  await step(box, "layout",
    `sudo -n mkdir -p ${RUNTIME} ${NODE_DIR} ${ROOT}/payload /vercel/sandbox/agent-data && sudo -n chown -R user:user /vercel`);

  await step(box, "nodeInstall",
    `curl -fsSL https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz ` +
    `| tar -xJ -C ${NODE_DIR} --strip-components=1`, 300_000);

  report.runtimeNode = (await step(box, "nodeCheck", `${NODE_DIR}/bin/node --version`)).stdout.trim();

  await step(box, "openclawInstall",
    `${PATH_PREFIX} npm install --prefix ${RUNTIME} --omit=dev --no-audit --no-fund openclaw@2026.7.1`, 900_000);

  const version = await step(box, "version",
    `${PATH_PREFIX} node ${RUNTIME}/node_modules/openclaw/openclaw.mjs --version`);
  report.version = version.stdout.trim();

  report.installedSize = (await run(box, `du -sh ${ROOT} | cut -f1`)).stdout.trim();
  report.bootstrapTotalMs = Number(report.layoutMs) + Number(report.nodeInstallMs) + Number(report.openclawInstallMs);

  // The whole point: does this survive a pause/resume cycle?
  at = Date.now();
  if (!(await box.pause({ keepMemory: false }))) throw Error("PAUSE_NOT_CONFIRMED");
  report.pauseMs = Date.now() - at;

  at = Date.now();
  const resumed = await Sandbox.connect(box.sandboxId, { ...options, timeoutMs: 900_000 });
  report.resumeMs = Date.now() - at;

  const after = await step(resumed, "versionAfterResume",
    `${PATH_PREFIX} node ${RUNTIME}/node_modules/openclaw/openclaw.mjs --version`);
  report.versionAfterResume = after.stdout.trim();
  if (after.stdout.trim() !== report.version) throw Error("INSTALL_LOST_ON_RESUME");

  report.bootstrapPassed = true;
} catch (error: any) {
  report.bootstrapPassed = false;
  report.errorType = error?.constructor?.name;
  report.error = String(error?.message ?? "").replaceAll(config.alibaba!.apiKey, "[redacted]").slice(0, 2000);
  process.exitCode = 1;
} finally {
  report.testSandboxIds = ids;
  const cleanup = await Promise.allSettled(ids.map(id => Sandbox.kill(id, options)));
  report.cleanupPassed = cleanup.every(r => r.status === "fulfilled");
  fs.writeFileSync(path.join(config.dataDir, "alibaba-base-bootstrap.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
