// V's desktop, browser and voice features for a v-release sandbox: a virtual
// desktop with the takeover page (v-desktop-handoff) and the computer tool (cua
// node), the owner's own Chrome through V Browser (broker + plugin), and the
// voice entry (Grok Voice / Doubao). Each is present only when the snapshot
// carries its package (V_RELEASE_ROOT/<feature>). Secrets are generated per
// tenant into agent-data on first boot; nothing secret is baked into a snapshot.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { V_RELEASE_ROOT } from "./v-release.mjs";

export const DESKTOP = Object.freeze({ display: ":99", rfbPort: 5900, publicPort: 23950, adminPort: 23951, runDir: "/tmp/.v-desktop-99" });
export const VBROWSER = Object.freeze({ publicPort: 23890, adminPort: 23891, slots: 4, firstCdpPort: 23901 });
export const VOICE = Object.freeze({ port: 26242, basePath: "/voice" });
/** The single owner identity the plugins resolve (one owner per Mirror instance). */
export const OWNER_CHANNELS = Object.freeze(["feishu", "weixin", "wecom", "dingtalk", "browser-trial", "webchat"]);

export function availableFeatures(root = V_RELEASE_ROOT) {
  return {
    desktop: fs.existsSync(path.join(root, "desktop", "service", "server.mjs")) && fs.existsSync("/usr/bin/Xtigervnc"),
    vbrowser: fs.existsSync(path.join(root, "vbrowser", "broker", "main.mjs")),
    voice: fs.existsSync(path.join(root, "voice", "lab", "gpt-live-h5", "server.mjs")),
  };
}

/** A random token kept in agent-data (so backups carry it), created once. */
export function secretFile(file, bytes = 24) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, randomBytes(bytes).toString("hex") + "\n", { mode: 0o600 });
  }
  return file;
}

/**
 * xfwm4's compositor renders through Mesa's software llvmpipe: every desktop start loads
 * libLLVM (52 MB) from a cold disk while the Gateway and Workers are loading too, and a
 * VNC desktop gains nothing from shadows and transparency. Turn it off in the session's
 * own xfconf (XDG_CONFIG_HOME = <state>/config), keeping any other xfwm4 settings.
 */
export function disableCompositing(stateDir) {
  const dir = path.join(stateDir, "config", "xfce4", "xfconf", "xfce-perchannel-xml");
  const file = path.join(dir, "xfwm4.xml");
  const off = '<property name="use_compositing" type="bool" value="false"/>';
  let xml = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (xml.includes(off)) return false;
  if (/<property name="use_compositing"[^>]*\/>/.test(xml)) xml = xml.replace(/<property name="use_compositing"[^>]*\/>/, off);
  else if (/<property name="general" type="empty">/.test(xml)) xml = xml.replace(/<property name="general" type="empty">/, `$&\n    ${off}`);
  else xml = `<?xml version="1.0" encoding="UTF-8"?>\n<channel name="xfwm4" version="1.0">\n  <property name="general" type="empty">\n    ${off}\n  </property>\n</channel>\n`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, xml);
  return true;
}

// Feature daemons start while the Gateway brings up its Worker pool on 4 vCPUs. Nobody waits
// on them for the first reply, so they yield the CPU to it. nice execs the command: the PID
// and command line (what quiesce matches) stay those of the daemon.
const BACKGROUND = ["-n", "10"];

export function desktopEnv(data) {
  return {
    DISPLAY: DESKTOP.display,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${DESKTOP.runDir}/bus`,
    XDG_RUNTIME_DIR: `${DESKTOP.runDir}/runtime`,
    DESKTOP_STATE_DIR: `${data}/desktop`,
    TMPDIR: "/tmp",
  };
}

/** Gateway config additions; the Worker config is derived from it automatically. */
export function featureConfig({ features, data, publicUrls = {} }) {
  const out = { plugins: { allow: [], loadPaths: [], entries: {} }, tools: { alsoAllow: [] } };
  if (features.desktop || features.vbrowser) {
    out.browser = {
      enabled: true,
      noSandbox: true,
      ...(features.desktop ? { executablePath: "/usr/bin/google-chrome", headless: false } : {}),
      ...(features.vbrowser ? { profiles: Object.fromEntries(Array.from({ length: VBROWSER.slots }, (_, i) => [
        `vbrowser-${String(i + 1).padStart(2, "0")}`, { driver: "extension", cdpPort: VBROWSER.firstCdpPort + i },
      ])) } : {}),
    };
    out.plugins.allow.push("browser");
    out.plugins.entries.browser = { enabled: true };
  }
  if (features.desktop) {
    out.desktop = { host: { enabled: true, port: DESKTOP.rfbPort, passwordFile: `${data}/desktop/vnc-password.txt` } };
    out.plugins.allow.push("cua-computer", "v-desktop-handoff");
    out.plugins.loadPaths.push(path.join(V_RELEASE_ROOT, "desktop", "plugin"));
    out.plugins.entries["cua-computer"] = { enabled: true };
    out.plugins.entries["v-desktop-handoff"] = {
      enabled: true,
      hooks: { allowConversationAccess: true },
      config: {
        adminUrl: `http://127.0.0.1:${DESKTOP.adminPort}`,
        adminTokenFile: `${data}/desktop-handoff/admin-token`,
        // One owner per instance: links are issued wherever the owner asks, and
        // the channel edge renders them (no Feishu credentials in the sandbox).
        controlAnywhere: true,
        cards: false,
        nativeCard: false,
        desktopDisplay: DESKTOP.display,
      },
    };
    out.tools.alsoAllow.push("computer");
  }
  if (features.vbrowser) {
    out.plugins.allow.push("v-browser-device");
    out.plugins.loadPaths.push(path.join(V_RELEASE_ROOT, "vbrowser", "openclaw-plugin"));
    out.plugins.entries["v-browser-device"] = {
      enabled: true,
      hooks: { allowConversationAccess: true },
      config: {
        brokerUrl: `http://127.0.0.1:${VBROWSER.adminPort}`,
        adminTokenFile: `${data}/vbrowser/broker-admin-token`,
        profilePrefix: "vbrowser-",
        leaseTtlMs: 300000,
        pairingTtlMs: 600000,
        singleOwner: true,
        ...(publicUrls.vbrowser ? { installUrl: `${publicUrls.vbrowser}/` } : {}),
      },
    };
  }
  return out;
}

const started = (name, child, log) => {
  child.unref();
  fs.writeFileSync(`/tmp/nexus-${name}.pid`, String(child.pid));
  return child;
};
const logFd = (name) => fs.openSync(`/tmp/nexus-${name}.log`, "a");

export async function startDesktop({ data, env }) {
  const stateDir = `${data}/desktop`;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  disableCompositing(stateDir);
  const child = spawn("nice", [...BACKGROUND, "bash", path.join(V_RELEASE_ROOT, "desktop", "desktop", "start-desktop.sh")], {
    // GDK_GL=disable: GTK would otherwise load Mesa's llvmpipe (libLLVM, 50 MB) for nothing.
    env: { ...env, ...desktopEnv(data), GDK_GL: "disable" }, detached: true, stdio: ["ignore", logFd("desktop"), logFd("desktop")],
  });
  started("desktop", child);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { execFileSync("xdpyinfo", ["-display", DESKTOP.display], { stdio: "ignore" }); return true; } catch {}
  }
  throw Error("V_DESKTOP_NOT_READY");
}

export function startHandoff({ data, env, publicUrl }) {
  const dir = `${data}/desktop-handoff`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = {
    bind: "0.0.0.0",
    publicPort: DESKTOP.publicPort,
    adminPort: DESKTOP.adminPort,
    publicBaseUrl: publicUrl || `http://127.0.0.1:${DESKTOP.publicPort}`,
    pathPrefix: "/desktop-handoff",
    novncDir: path.join(V_RELEASE_ROOT, "desktop", "service", "vendor", "novnc-1.3.0"),
    stateDir: dir,
    adminTokenFile: secretFile(`${dir}/admin-token`),
    title: "我的桌面",
    serverSideCursor: true,
    vnc: { host: "127.0.0.1", port: DESKTOP.rfbPort, passwordFile: `${data}/desktop/vnc-password.txt` },
    layout: { enabled: true, display: DESKTOP.display, base: "1280x800" },
  };
  fs.writeFileSync(`${dir}/config.json`, JSON.stringify(config, null, 1), { mode: 0o600 });
  return started("desktop-handoff", spawn("nice", [...BACKGROUND, "node", path.join(V_RELEASE_ROOT, "desktop", "service", "server.mjs"), `${dir}/config.json`], {
    env: { ...env, ...desktopEnv(data) }, detached: true, stdio: ["ignore", logFd("desktop-handoff"), logFd("desktop-handoff")],
  }));
}

export function startBroker({ data, env, base, publicUrl, gatewayPort = 18790 }) {
  const dir = `${data}/vbrowser`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const root = path.join(V_RELEASE_ROOT, "vbrowser");
  const zip = fs.readdirSync(path.join(root, "dist")).find((name) => /^v-browser-extension-.*\.zip$/.test(name));
  const wsUrl = publicUrl ? publicUrl.replace(/^http/, "ws") : `ws://127.0.0.1:${VBROWSER.publicPort}`;
  fs.writeFileSync(`${dir}/broker-public-ws-url`, wsUrl + "\n");
  return started("vbrowser-broker", spawn("nice", [...BACKGROUND, "node", path.join(root, "broker", "main.mjs")], {
    cwd: root,
    env: {
      ...env,
      V_BROWSER_BROKER_HOST: "0.0.0.0",
      V_BROWSER_BROKER_PORT: String(VBROWSER.publicPort),
      V_BROWSER_BROKER_ADMIN_HOST: "127.0.0.1",
      V_BROWSER_BROKER_ADMIN_PORT: String(VBROWSER.adminPort),
      V_BROWSER_BROKER_STATE_PATH: `${dir}/broker.json`,
      V_BROWSER_BROKER_ADMIN_TOKEN_FILE: secretFile(`${dir}/broker-admin-token`),
      V_BROWSER_UPSTREAM_BASE_URL: `ws://127.0.0.1:${gatewayPort}/browser/extension`,
      V_BROWSER_UPSTREAM_RELAY_TOKEN_FILE: `${data}/state/credentials/browser-extension-relay.secret`,
      V_BROWSER_OPENCLAW_RELAY_MODULE_DIR: `${base}/runtime/node_modules/openclaw/dist/extensions/browser/chrome-extension/modules`,
      V_BROWSER_PUBLIC_WS_URL_FILE: `${dir}/broker-public-ws-url`,
      V_BROWSER_PUBLIC_PATH_PREFIX: "",
      V_BROWSER_PROFILE_SLOTS: Array.from({ length: VBROWSER.slots }, (_, i) => `vbrowser-${String(i + 1).padStart(2, "0")}`).join(","),
      ...(zip ? { V_BROWSER_EXTENSION_PACKAGE_PATH: path.join(root, "dist", zip), V_BROWSER_EXTENSION_VERSION: zip.replace(/^v-browser-extension-|\.zip$/g, "") } : {}),
      V_BROWSER_AVATAR_PATH: path.join(root, "assets", "v-avatar.jpg"),
      V_BROWSER_PREVIEW_IMAGE_PATH: path.join(root, "assets", "v-browser-preview.png"),
    },
    detached: true, stdio: ["ignore", logFd("vbrowser-broker"), logFd("vbrowser-broker")],
  }));
}

export function startVoice({ data, env, base, agentId, publicUrl, accessToken }) {
  return started("voice", spawn("nice", [...BACKGROUND, "node", path.join(V_RELEASE_ROOT, "voice", "lab", "gpt-live-h5", "server.mjs")], {
    cwd: path.join(V_RELEASE_ROOT, "voice", "lab", "gpt-live-h5"),
    env: {
      ...env,
      OPENCLAW_CONFIG_PATH: `${data}/openclaw.json`,
      RTC_H5_RUNTIME_ROOT: `${base}/runtime/node_modules/openclaw`,
      RTC_H5_PORT: String(VOICE.port),
      RTC_H5_BASE_PATH: VOICE.basePath,
      RTC_H5_ACCESS_TOKEN: accessToken,
      RTC_H5_MAX_ACTIVE_SESSIONS: "2",
      RTC_H5_MAX_ACTIVE_SESSIONS_PER_IP: "2",
      GPT_LIVE_H5_PUBLIC_ORIGIN: publicUrl || `http://127.0.0.1:${VOICE.port}`,
      VOICE_LISTEN_HOST: "0.0.0.0",
      VOICE_AGENT_ID: agentId,
      VOICE_SESSION_KEY: `agent:${agentId}:voice`,
      VOICE_DISABLE_GPT_LIVE: "1",
      VOICE_DISABLE_FEISHU_CALENDAR: "1",
    },
    detached: true, stdio: ["ignore", logFd("voice"), logFd("voice")],
  }));
}

export function startCuaNode({ data, env, base, gatewayPort = 18790 }) {
  const dir = `${data}/node-cua`;
  fs.mkdirSync(`${dir}/state`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${dir}/openclaw.json`, JSON.stringify({
    gateway: { mode: "remote", remote: { transport: "direct", url: `ws://127.0.0.1:${gatewayPort}`, token: "${NEXUS_GATEWAY_TOKEN}" } },
    browser: { enabled: false },
    nodeHost: { browserProxy: { enabled: false } },
    plugins: { entries: { "cua-computer": { enabled: true } } },
  }, null, 1), { mode: 0o600 });
  return started("cua-node", spawn("nice", [...BACKGROUND, "node", `${base}/runtime/node_modules/openclaw/openclaw.mjs`, "node", "run", "--host", "127.0.0.1", "--port", String(gatewayPort), "--display-name", "Mirror desktop"], {
    env: { ...env, ...desktopEnv(data), OPENCLAW_CONFIG_PATH: `${dir}/openclaw.json`, OPENCLAW_STATE_DIR: `${dir}/state` },
    detached: true, stdio: ["ignore", logFd("cua-node"), logFd("cua-node")],
  }));
}

/**
 * Approve the desktop node's pairing and capability requests. Runs detached from
 * boot (each CLI call takes seconds) and stops once nothing is pending for a while.
 */
export async function approveDesktopNode({ env, base, deadlineMs = 120000 }) {
  const cli = (...args) => execFileSync("node", [`${base}/runtime/node_modules/openclaw/openclaw.mjs`, ...args], { env, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  const until = Date.now() + deadlineMs;
  let approved = 0, quiet = 0;
  while (Date.now() < until && quiet < 6) {
    let requests = [];
    try {
      const pending = JSON.parse(cli("nodes", "pending", "--json"));
      requests = (Array.isArray(pending) ? pending : pending.pending ?? pending.requests ?? [])
        .filter((request) => /Mirror desktop/.test(JSON.stringify(request)));
    } catch {}
    for (const request of requests) {
      try { cli("nodes", "approve", String(request.requestId ?? request.id)); approved++; } catch {}
    }
    quiet = requests.length ? 0 : quiet + 1;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { approved };
}

export function startNodeApprover({ env, base }) {
  return started("node-approver", spawn("nice", [...BACKGROUND, "node", new URL(import.meta.url).pathname, "approve-node"], {
    env: { ...env, NEXUS_BASE: base }, detached: true, stdio: ["ignore", logFd("node-approver"), logFd("node-approver")],
  }));
}

if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2] === "approve-node") {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...(await approveDesktopNode({ env: process.env, base: process.env.NEXUS_BASE })) }));
}
