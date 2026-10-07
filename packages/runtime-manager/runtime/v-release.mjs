// A "v-release" snapshot runs V's own patched OpenClaw build: the npm upstream
// plus the byte captures the platform repo keeps for each V release
// (vegekyd-sys/v-openclaw-platform release/captured/<tag>{,.worker}), plus V's
// hand-applied codex plugin changes. The builder writes V_RELEASE_MARKER; boot,
// quiesce and backup switch behaviour on its presence.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const V_RELEASE_ROOT = "/vercel/sandbox/nexus/v";
export const V_RELEASE_MARKER = "/vercel/sandbox/nexus/v-release.json";

/** Long-lived processes a v-release runtime starts itself. They never pin a VM awake. */
export const V_RELEASE_DAEMONS = Object.freeze([
  /\/v\/worker\/dist\/worker\.mjs(?:\s|$)/,
  /\/v-memory-indexer\.mjs(?:\s|$)/,
  /\bcodex(?:-linux-x64)?\b.*\bapp-server\b/,
]);

/** Under agent-data/: rebuilt from the snapshot or disposable, so never in a per-turn backup. */
export const V_RELEASE_BACKUP_EXCLUDES = Object.freeze([
  /^state\/npm(?:\/|$)/,
  /^state\/agents\/[^/]+\/agent\/codex-home\/(?:cache|log|logs_\d+\.sqlite[^/]*|models_cache\.json|shell_snapshots|tmp)(?:\/|$)/,
  /^state\/logs(?:\/|$)/,
]);

export function readVRelease(file = V_RELEASE_MARKER) {
  if (!fs.existsSync(file)) return null;
  const marker = JSON.parse(fs.readFileSync(file, "utf8"));
  if (marker.schemaVersion !== 1 || typeof marker.release !== "string" || !/^\d{4}\.\d+\.\d+$/.test(marker.upstream))
    throw Error("V_RELEASE_MARKER_INVALID");
  return marker;
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * Overlay one capture onto an installed package's dist. Fail closed: a modified
 * file must replace exactly the upstream bytes it was captured against. A file
 * that already holds the captured bytes is left alone, so re-running is safe.
 */
export function applyCapture(captureDir, distDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(captureDir, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(distDir, "..", "package.json"), "utf8"));
  if (manifest.upstream && pkg.version !== manifest.upstream) throw Error(`V_RELEASE_BASE_VERSION_MISMATCH:${pkg.version}`);
  if (manifest.removedFromBase?.length) throw Error("V_RELEASE_REMOVED_FILES_UNSUPPORTED");
  const counts = { modified: 0, added: 0, alreadyApplied: 0 };
  for (const entry of manifest.files) {
    const rel = entry.path.replace(/^\.\//, "");
    if (!rel || rel.split("/").some((part) => !part || part === "..")) throw Error("V_RELEASE_PATH_INVALID");
    const src = path.join(captureDir, "dist", rel), dst = path.join(distDir, rel);
    if (sha256(src) !== entry.sha256) throw Error(`V_RELEASE_CAPTURE_BYTES_MISMATCH:${rel}`);
    if (fs.existsSync(dst) && sha256(dst) === entry.sha256) { counts.alreadyApplied++; continue; }
    if (entry.kind === "modified") {
      if (!fs.existsSync(dst) || sha256(dst) !== entry.baseSha256) throw Error(`V_RELEASE_BASE_BYTES_MISMATCH:${rel}`);
      counts.modified++;
    } else if (entry.kind === "added") {
      if (fs.existsSync(dst)) throw Error(`V_RELEASE_ADDED_FILE_EXISTS:${rel}`);
      counts.added++;
    } else throw Error(`V_RELEASE_UNKNOWN_KIND:${entry.kind}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, `${dst}.v-release.tmp`);
    fs.renameSync(`${dst}.v-release.tmp`, dst);
  }
  return { release: manifest.release, ...counts };
}

/** The codex plugin is installed by OpenClaw itself into the state dir; patch every installed copy. */
export function applyCodexCapture(stateDir, captureDir = path.join(V_RELEASE_ROOT, "codex")) {
  const projects = path.join(stateDir, "npm", "projects");
  if (!fs.existsSync(projects) || !fs.existsSync(captureDir)) return [];
  return fs.readdirSync(projects)
    .filter((name) => name.startsWith("openclaw-codex-"))
    .map((name) => path.join(projects, name, "node_modules", "@openclaw", "codex", "dist"))
    .filter((dist) => fs.existsSync(dist))
    .map((dist) => applyCapture(captureDir, dist));
}

/** V's Codex home routes `deepseek/...` turns to DeepSeek's native Responses API. */
export function codexHomeConfig() {
  return [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    "",
    "[model_providers.deepseek]",
    'name = "DeepSeek"',
    'base_url = "https://api.deepseek.com/v1"',
    'wire_api = "responses"',
    'env_key = "DEEPSEEK_API_KEY"',
    "",
  ].join("\n");
}

export function ensureCodexHome(stateDir, agentId) {
  const home = path.join(stateDir, "agents", agentId, "agent", "codex-home");
  const file = path.join(home, "config.toml");
  fs.mkdirSync(home, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, codexHomeConfig(), { mode: 0o600 });
  return file;
}

export function isVReleaseDaemon(command) {
  return V_RELEASE_DAEMONS.some((pattern) => pattern.test(command));
}

export function isVReleaseBackupExcluded(rel) {
  return V_RELEASE_BACKUP_EXCLUDES.some((pattern) => pattern.test(rel));
}
