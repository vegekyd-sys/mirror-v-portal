// Snapshot-build step for a v-release template. Runs inside the builder sandbox
// after `npm install openclaw@<upstream>` and the release archive is unpacked
// at V_RELEASE_ROOT. Overlays V's captured bytes and writes the marker that
// boot.mjs, quiesce.mjs and backup.mjs key on.
import fs from "node:fs";
import path from "node:path";
import { applyCapture, V_RELEASE_ROOT, V_RELEASE_MARKER } from "./v-release.mjs";

const [runtimeRoot, codexCommand] = process.argv.slice(2);
const core = JSON.parse(fs.readFileSync(path.join(V_RELEASE_ROOT, "core", "manifest.json"), "utf8"));
const applied = applyCapture(path.join(V_RELEASE_ROOT, "core"), path.join(runtimeRoot, "node_modules", "openclaw", "dist"));
const worker = JSON.parse(fs.readFileSync(path.join(V_RELEASE_ROOT, "worker", "dist", "openclaw.plugin.json"), "utf8"));
if (worker.id !== "vlab-agent-worker-isolation") throw Error("V_RELEASE_WORKER_PLUGIN_MISSING");
const workerManifest = JSON.parse(fs.readFileSync(path.join(V_RELEASE_ROOT, "worker", "manifest.json"), "utf8"));
if (codexCommand && !fs.existsSync(path.join("/vercel/sandbox/nexus", codexCommand))) throw Error("V_RELEASE_CODEX_MISSING");
// Feature packages resolve their dependencies from the runtime's own copies.
const nodeModules = path.join(runtimeRoot, "node_modules");
const link = (target, at) => {
  if (!fs.existsSync(path.dirname(path.dirname(at)))) return false;
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.rmSync(at, { recursive: true, force: true });
  fs.symlinkSync(target, at);
  return true;
};
const features = {
  desktop: link(path.join(nodeModules, "typebox"), path.join(V_RELEASE_ROOT, "desktop", "plugin", "node_modules", "typebox")),
  vbrowser: link(path.join(nodeModules, "typebox"), path.join(V_RELEASE_ROOT, "vbrowser", "openclaw-plugin", "node_modules", "typebox"))
    && link(path.join(nodeModules, "ws"), path.join(V_RELEASE_ROOT, "vbrowser", "node_modules", "ws")),
  // The voice server loads <runtime root>/node_modules/ws next to dist/.
  voice: fs.existsSync(path.join(V_RELEASE_ROOT, "voice")) && link(path.join(nodeModules, "ws"), path.join(nodeModules, "openclaw", "node_modules", "ws")),
};
const marker = {
  schemaVersion: 1,
  release: core.release,
  upstream: core.upstream,
  worker: workerManifest.release,
  codexCapture: fs.existsSync(path.join(V_RELEASE_ROOT, "codex", "manifest.json"))
    ? JSON.parse(fs.readFileSync(path.join(V_RELEASE_ROOT, "codex", "manifest.json"), "utf8")).release : null,
  workers: { minWorkers: 1, maxWorkers: 3, sessionsPerWorker: 3 },
  ...(codexCommand ? { codexCommand } : {}),
  // Official external plugins OpenClaw installs on the converge start (no local path).
  plugins: [{ id: "parallel" }],
  features: Object.keys(features).filter((name) => features[name]),
  sources: fs.existsSync(path.join(V_RELEASE_ROOT, "features.json")) ? JSON.parse(fs.readFileSync(path.join(V_RELEASE_ROOT, "features.json"), "utf8")) : null,
};
fs.writeFileSync(V_RELEASE_MARKER, JSON.stringify(marker, null, 1));
console.log(JSON.stringify({ phase: "v-release-installed", ...applied, worker: marker.worker, codexCapture: marker.codexCapture, features: marker.features }));
