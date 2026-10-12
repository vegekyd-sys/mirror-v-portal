// Mirror V: the takeover page's 交还给 V wakes the conversation through the
// Portal (NEXUS_WAKE_URL) instead of an in-Gateway delivery: a Mirror Gateway has
// no channels, so `subagent.run({deliver:true})` fails with "Channel is required".
// The Portal queues the wake message as a normal turn in the original chat, and
// the reply goes out through the channel edge. Without NEXUS_WAKE_URL the plugin
// behaves exactly as on V. Usage: node desktop-mirror.mjs <v-desktop-handoff/plugin dir>
import fs from "node:fs";
import path from "node:path";

const file = path.join(path.resolve(process.argv[2] ?? ""), "index.js");
const text = fs.readFileSync(file, "utf8");
const from = "                  run({ sessionKey: h.sessionKey, message: WAKE_MESSAGE(h.id), deliver: true, idempotencyKey: `v-desktop-handoff-wake-${h.id}-${h.pageHandBackAt}` }),";
const to = "                  // mirror-v-portal-wake\n                  process.env.NEXUS_WAKE_URL\n                    ? fetch(process.env.NEXUS_WAKE_URL, { method: \"POST\", headers: { \"content-type\": \"application/json\" }, body: JSON.stringify({ sessionKey: h.sessionKey, text: WAKE_MESSAGE(h.id), requestKey: `v-desktop-handoff-wake-${h.id}-${h.pageHandBackAt}` }), signal: AbortSignal.timeout(25_000) })\n                        .then(async (r) => { if (!r.ok) throw new Error(`portal wake ${r.status}`); return r.json(); })\n                    : run({ sessionKey: h.sessionKey, message: WAKE_MESSAGE(h.id), deliver: true, idempotencyKey: `v-desktop-handoff-wake-${h.id}-${h.pageHandBackAt}` }),";
if (text.split(from).length !== 2) throw Error("desktop handoff wake anchor not found exactly once");
fs.writeFileSync(file, text.replace(from, to));
console.log(JSON.stringify({ patched: "desktop-portal-wake", file }));
