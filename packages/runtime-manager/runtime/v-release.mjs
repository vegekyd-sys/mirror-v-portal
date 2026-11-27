// A "v-release" snapshot runs V's own patched OpenClaw build: the npm upstream
// plus the byte captures the platform repo keeps for each V release
// (vegekyd-sys/v-openclaw-platform release/captured/<tag>{,.worker}), plus V's
// hand-applied codex plugin changes. The builder writes V_RELEASE_MARKER; boot,
// quiesce and backup switch behaviour on its presence.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export const V_RELEASE_ROOT = "/vercel/sandbox/nexus/v";
export const V_RELEASE_MARKER = "/vercel/sandbox/nexus/v-release.json";

/** Long-lived processes a v-release runtime starts itself. They never pin a VM awake. */
export const V_RELEASE_DAEMONS = Object.freeze([
  /\/v\/worker\/dist\/worker\.mjs(?:\s|$)/,
  /\/v-memory-indexer\.mjs(?:\s|$)/,
  // The memory engine keeps this query helper warm after recall. It owns no
  // user job; queued/running turns still hold the manager's tenant lock.
  /^(?:\/\S+\/)?node\s+\/vercel\/sandbox\/nexus\/runtime\/node_modules\/openclaw\/dist\/extensions\/memory-core\/memory-search-knn\.child\.js(?:\s|$)/,
  // The boot-time index pass that runs just before the indexer.
  /\/openclaw\.mjs memory index --agent /,
  /\bcodex(?:-linux-x64)?\b.*\bapp-server\b/,
  // Virtual desktop, takeover page, V Browser broker, voice entry, desktop node.
  /\/start-desktop\.sh(?:\s|$)/,
  /^\S*(?:Xtigervnc|dbus-daemon|dbus-launch|xfce4-session|xfwm4|xfdesktop|xfce4-panel|xfsettingsd|xfconfd|at-spi\S*|panel-\S+|Thunar|tumblerd)\b/,
  /\/v\/desktop\/service\/server\.mjs(?:\s|$)/,
  /\/v\/vbrowser\/broker\/main\.mjs(?:\s|$)/,
  /\/v\/voice\/lab\/gpt-live-h5\/server\.mjs(?:\s|$)/,
  /openclaw\.mjs node run\b/,
  // The desktop node renames its processes after start.
  /^openclaw(?:-node)?(?:\s|$)/,
  /\/v-features\.mjs approve-node\b/,
  /openclaw\.mjs nodes (?:pending|approve|list)\b/,
  /\/opt\/google\/chrome\/|\bgoogle-chrome\b|chrome_crashpad_handler/,
]);

/** Under agent-data/: rebuilt from the snapshot or disposable, so never in a per-turn backup. */
export const V_RELEASE_BACKUP_EXCLUDES = Object.freeze([
  /^state\/npm(?:\/|$)/,
  /^state\/agents\/[^/]+\/agent\/codex-home\/(?:cache|log|logs_\d+\.sqlite[^/]*|models_cache\.json|shell_snapshots|tmp)(?:\/|$)/,
  /^state\/logs(?:\/|$)/,
  // Codex clones its plugin marketplace (a 25 MB git pack) into CODEX_HOME/.tmp on first use.
  /^state\/agents\/[^/]+\/agent\/codex-home\/\.tmp(?:\/|$)/,
  /^state\/cache(?:\/|$)/,
  // Chrome's re-downloadable caches and on-device models (tens of MB); cookies and logins stay.
  /^state\/browser\/[^/]+\/user-data\/(?:optimization_guide_model_store|component_crx_cache|Safe Browsing|segmentation_platform|GrShaderCache|ShaderCache|GraphiteDawnCache|extensions_crx_cache|BrowserMetrics)(?:\/|$)/,
  /^state\/browser\/[^/]+\/user-data\/[^/]+\/(?:Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|Service Worker\/CacheStorage|Service Worker\/ScriptCache)(?:\/|$)/,
]);

/** An agent's state DB and its WAL/shm sidecars (group 1). */
export const AGENT_DB = /^state\/agents\/[^/]+\/agent\/openclaw-agent\.sqlite(-wal|-shm)?$/;
// The memory search index: rebuilt from the workspace by `openclaw memory index`.
// meta/state rows stay so the rebuild keeps the same embedding provider settings.
const MEMORY_INDEX_TABLES = [
  "memory_index_chunks_vec", "memory_index_chunks_fts", "memory_index_paths_fts",
  "memory_index_chunk_provenance", "memory_index_chunk_recall_metadata",
  "memory_index_chunks", "memory_index_sources", "memory_embedding_cache",
];

/**
 * Write a consistent copy of a live agent DB without its memory index. Small DBs
 * and any failure return false, and the caller keeps the raw file instead.
 */
export async function compactAgentDb(src, dst, vec0, minBytes = 32 << 20) {
  let db;
  try {
    if (fs.statSync(src).size < minBytes) return false;
    // require, not import(): bundlers and test runners mangle the "node:sqlite" specifier.
    const { DatabaseSync, backup } = createRequire(import.meta.url)("node:sqlite");
    const live = new DatabaseSync(src, { readOnly: true });
    try { await backup(live, dst); } finally { live.close(); }
    db = new DatabaseSync(dst, { allowExtension: true });
    db.exec("PRAGMA journal_mode=DELETE");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (tables.has("memory_index_chunks_vec")) db.loadExtension(vec0);
    db.exec("BEGIN");
    for (const table of MEMORY_INDEX_TABLES) if (tables.has(table)) db.exec(`DELETE FROM "${table}"`);
    db.exec("COMMIT");
    db.exec("VACUUM");
    db.close();
    return true;
  } catch {
    try { db?.close(); } catch {}
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(dst + suffix, { force: true });
    return false;
  }
}

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

/**
 * V's Codex home routes `deepseek/...` turns to DeepSeek's native Responses API.
 * One retry each (V 2026-11-09, platform docs/evidence/codex-fallback-chain-20261107): a DeepSeek
 * outage reaches the OpenClaw fallback in ~11 s instead of ~32 s, and a single transient error still
 * heals inside Codex. Codex >= 0.169 also gets V's 2026-11-26 setting that keeps remote plugins
 * (and their MCP servers) from loading: V's incident was process exhaustion.
 */
export function codexHomeConfig({ codexVersion } = {}) {
  const [major = 0, minor = 0] = String(codexVersion ?? "").split(".").map(Number);
  const remotePluginSwitch = major > 0 || minor >= 169;
  return [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    "",
    "[model_providers.deepseek]",
    'name = "DeepSeek"',
    'base_url = "https://api.deepseek.com/v1"',
    'wire_api = "responses"',
    'env_key = "DEEPSEEK_API_KEY"',
    "request_max_retries = 1",
    "stream_max_retries = 1",
    "",
    ...(remotePluginSwitch ? ["[features]", "remote_plugin = false", ""] : []),
  ].join("\n");
}

/** The file this module wrote before 2026-11-27, byte for byte: replaced by the current one. */
const LEGACY_CODEX_HOME_CONFIG = [
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

/**
 * Write the Codex home config. A file this module wrote earlier is upgraded in place, keeping the
 * `[projects."<dir>"]` trust entries Codex appends on its own; one that differs otherwise (the
 * agent or the owner changed it) is left alone. Returns the file path.
 */
export function ensureCodexHome(stateDir, agentId, { codexVersion } = {}) {
  const home = path.join(stateDir, "agents", agentId, "agent", "codex-home");
  const file = path.join(home, "config.toml");
  fs.mkdirSync(home, { recursive: true });
  const want = codexHomeConfig({ codexVersion });
  let have = null;
  try { have = fs.readFileSync(file, "utf8"); } catch {}
  let next = null;
  if (have === null) next = want;
  else {
    const at = have.search(/^\[projects\."[^"\n]*"\]$/m);
    const head = at < 0 ? have : have.slice(0, at), tail = at < 0 ? "" : have.slice(at);
    const onlyProjects = tail.split("\n").every((line) => !line.trim() || /^\[projects\."[^"]*"\]$/.test(line) || /^trust_level = "\w+"$/.test(line));
    const ours = [LEGACY_CODEX_HOME_CONFIG, codexHomeConfig(), codexHomeConfig({ codexVersion: "0.169.0" })].some((text) => text.trimEnd() === head.trimEnd());
    if (ours && onlyProjects) next = tail ? `${want.trimEnd()}\n\n${tail}` : want;
  }
  if (next !== null && next !== have) {
    fs.writeFileSync(`${file}.tmp`, next, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  return file;
}

/** Version of the Codex CLI a snapshot installed (codexCommand lives inside its npm prefix). */
export function installedCodexVersion(codexCommand) {
  const marker = "/node_modules/@openai/codex-linux-x64/";
  if (!codexCommand?.includes(marker)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(codexCommand.slice(0, codexCommand.indexOf(marker)), "node_modules", "@openai", "codex", "package.json"), "utf8")).version;
  } catch { return undefined; }
}

export function isVReleaseDaemon(command) {
  return V_RELEASE_DAEMONS.some((pattern) => pattern.test(command));
}

/**
 * pid -> true when the process or one of its ancestors is a V daemon (Chrome's
 * helper `cat` pipes, the desktop session's children). Work an agent started
 * itself has a Worker or the Gateway as ancestor and still counts as busy.
 */
/** Daemons whose own helpers are part of them (Chrome's pipes, the desktop session, the node runner). */
export const V_RELEASE_DAEMON_TREES = Object.freeze([
  /\/opt\/google\/chrome\/|\bgoogle-chrome\b/,
  /^\S*(?:Xtigervnc|xfce4-session|dbus-daemon)\b/,
  /\/start-desktop\.sh(?:\s|$)/,
  /^openclaw(?:-node)?(?:\s|$)/,
  /openclaw\.mjs node run\b/,
]);

export function daemonTree(rows) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const memo = new Map();
  const visit = (pid, depth = 0) => {
    if (memo.has(pid)) return memo.get(pid);
    const row = byPid.get(pid);
    const result = !!row && depth < 12 && (isVReleaseDaemon(row.command) || (row.ppid !== pid && treeRoot(row.ppid, depth + 1)));
    memo.set(pid, result);
    return result;
  };
  // An ancestor passes daemon status down only if it is one of the tree daemons.
  const treeRoot = (pid, depth) => {
    const row = byPid.get(pid);
    if (!row || depth >= 12) return false;
    return V_RELEASE_DAEMON_TREES.some((pattern) => pattern.test(row.command)) || (row.ppid !== pid && treeRoot(row.ppid, depth + 1));
  };
  return (pid) => visit(pid);
}

export function isVReleaseBackupExcluded(rel) {
  return V_RELEASE_BACKUP_EXCLUDES.some((pattern) => pattern.test(rel));
}

/** Local ports with an ESTABLISHED TCP connection, from /proc (no ss/netstat in the image). */
export function establishedLocalPorts(read = (file) => fs.readFileSync(file, "utf8")) {
  const ports = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = read(file); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== "01") continue;
      ports.add(parseInt(cols[1].split(":").pop(), 16));
    }
  }
  return ports;
}

/**
 * Why a v-release VM must stay awake, or null. A person on a public page (takeover
 * viewer, voice call) holds a connection; a component that knows it is busy writes
 * /tmp/nexus-keepawake/<name> containing an epoch-ms deadline.
 */
export function vReleaseKeepAwake({ publicPorts = {}, idlePorts = [], now = Date.now(), dir = "/tmp/nexus-keepawake", established = establishedLocalPorts() } = {}) {
  for (const [name, port] of Object.entries(publicPorts)) {
    if (!idlePorts.includes(name) && established.has(port)) return `public-connection:${name}`;
  }
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch {}
  for (const name of entries) {
    const until = Number(fs.readFileSync(path.join(dir, name), "utf8").trim());
    if (Number.isFinite(until) && until > now) return `keep-awake:${name}`;
  }
  return null;
}

/** Established TCP connections owned by a process, by remote port (from /proc). */
export function processRemotePorts(pid) {
  const inodes = new Set();
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      try { const m = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/); if (m) inodes.add(m[1]); } catch {}
    }
  } catch { return []; }
  const ports = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length > 9 && cols[3] === "01" && inodes.has(cols[9])) ports.push(parseInt(cols[2].split(":").pop(), 16));
    }
  }
  return ports;
}

/** A desktop handoff link is open or being used: keep the desktop (and its Chrome) alive. */
export async function desktopHandoffBusy({ tokenFile, port = 23951, now = Date.now() } = {}) {
  let token;
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { return null; }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/state`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const state = await res.json();
    if (state.controlActive || state.viewers > 0) return "desktop-handoff:viewer";
    const live = (state.activeHandoffs ?? []).some((h) => h && !h.ended && now < (h.sessionExpiresAt ?? h.claimExpiresAt ?? 0));
    return live ? "desktop-handoff:open-link" : null;
  } catch { return null; }
}
