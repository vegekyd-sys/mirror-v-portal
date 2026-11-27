// Issue the VSync hub identity of a customer's own Mirror V deployment (outside the
// Portal). Run on the Portal host. The agent id must be listed in config.vsync.deployments.
// The token is written to a mode-600 env file and never printed:
//   tsx scripts/vsync-token.ts <agent-id> [out-dir]   (default /opt/nexus/data/vsync-hub/issued)
// Hand the file to the installer out of band; it sets NEXUS_VSYNC_URL / _AGENT / _TOKEN.
// To withdraw it, add the agent id to config.vsync.revoked and restart the runtime manager.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { AGENT_ID, vsyncToken } from "../src/vsync-hub.js";

const [agent, outDir = "/opt/nexus/data/vsync-hub/issued"] = process.argv.slice(2);
const config = loadConfig();
if (!agent || !AGENT_ID.test(agent)) throw Error("usage: vsync-token.ts <agent-id: a-z0-9 and dashes> [out-dir]");
if (!config.vsync?.enabled) throw Error("config.vsync is not enabled");
if (!config.vsync.deployments?.includes(agent)) throw Error(`add "${agent}" to config.vsync.deployments first`);
if (config.vsync.revoked?.includes(agent)) throw Error(`"${agent}" is revoked`);
const url = `${(config.publicBaseUrl || "https://mirror-v-portal.vercel.app").replace(/\/$/, "")}/onboard/vsync/v1`;
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const file = path.join(outDir, `${agent}.env`);
fs.writeFileSync(file, `NEXUS_VSYNC_URL=${url}\nNEXUS_VSYNC_AGENT=${agent}\nNEXUS_VSYNC_TOKEN=${vsyncToken(config.encryptionKey, agent)}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(`wrote ${file} (mode 600)`);
