// Single-owner mode for the V Browser plugin (vegekyd-sys/v-browser openclaw-plugin).
// A Mirror V instance has exactly one owner and its channel edge does not mark
// direct sessions, so pairing is allowed whenever the Gateway says the sender
// is the owner. Exact-match edits fail closed on an upstream change.
// Usage: node v-browser-mirror.mjs <openclaw-plugin dir>
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "");
const edit = (file, from, to) => {
  const full = path.join(dir, file);
  const text = fs.readFileSync(full, "utf8");
  if (text.split(from).length !== 2) throw Error(`${file}: anchor not found exactly once`);
  fs.writeFileSync(full, text.replace(from, to));
};
edit("index.js", "          if (!isTrustedDirectSession(context)) {",
  "          // mirror-v-single-owner: one owner per instance; the Gateway decides senderIsOwner.\n          if (!(config.singleOwner === true && context.senderIsOwner === true) && !isTrustedDirectSession(context)) {");
const manifestFile = path.join(dir, "openclaw.plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
manifest.configSchema.properties.singleOwner = {
  type: "boolean",
  description: "Mirror V: the instance has one owner; allow pairing outside direct sessions when the sender is the owner.",
};
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ patched: "v-browser-single-owner", dir }));
