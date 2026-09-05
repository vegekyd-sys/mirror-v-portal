#!/usr/bin/env node
/** Gate the shared Feishu reply footer without changing plugin config schema.
 * Pinned @openclaw/feishu@2026.7.1; fails closed on an unknown bundle shape.
 * Apply to BOTH the image fallback and PVC trusted install before gateway start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const fileIndex = args.indexOf('--file');
if (fileIndex >= 0 && !args[fileIndex + 1]) throw new Error('--file requires a path');
const pluginRoot = process.env.FEISHU_PLUGIN_ROOT || '/opt/dealclaw/plugins/feishu/node_modules/@openclaw/feishu';
const dist = path.join(pluginRoot, 'dist');
const files = fileIndex >= 0 ? [path.resolve(args[fileIndex + 1])] : fs.readdirSync(dist)
  .filter(name => /^monitor\.account-.*\.js$/.test(name))
  .map(name => path.join(dist, name));
if (files.length !== 1) throw new Error(`Expected one Feishu monitor bundle; found ${files.length}`);
const target = files[0];
const before = 'function resolveCardNote(agentId, identity, prefixCtx) {';
const gate = '\n\tif (process.env.DEALCLAW_FEISHU_SHOW_FOOTER?.trim().toLowerCase() === "false") return undefined;';
const v1 = `${before}\n\t// dealclaw-feishu-footer-toggle-v1${gate}`;
const v2 = `${before}\n\t// dealclaw-feishu-footer-toggle-v2${gate}`;
const after = `${before}\n\t// dealclaw-feishu-footer-toggle-v3${gate}`;
const originalReturn = '\treturn parts.join(" | ");';
const v2Return = `\tconst visibilityKeys = {
\t\t"Agent: ": "DEALCLAW_FEISHU_SHOW_AGENT",
\t\t"Model: ": "DEALCLAW_FEISHU_SHOW_MODEL",
\t\t"Provider: ": "DEALCLAW_FEISHU_SHOW_PROVIDER",
\t\t"Runtime: ": "DEALCLAW_FEISHU_SHOW_RUNTIME"
\t};
\tconst visibleParts = parts.filter(part => {
\t\tconst label = Object.keys(visibilityKeys).find(label => part.startsWith(label));
\t\treturn !label || process.env[visibilityKeys[label]]?.trim().toLowerCase() !== "false";
\t});
\treturn visibleParts.length ? visibleParts.join(" | ") : undefined;`;
const filteredReturn = v2Return.replace(
  '\t\treturn !label || process.env[visibilityKeys[label]]?.trim().toLowerCase() !== "false";',
  `\t\tif (!label) return true;
\t\tconst value = process.env[visibilityKeys[label]]?.trim().toLowerCase();
\t\tif (value === "true") return true;
\t\tif (value === "false") return false;
\t\treturn label === "Agent: ";`,
);
const original = fs.readFileSync(target, 'utf8');
if (original.split(before).length !== 2) throw new Error('Unsupported Feishu bundle: expected one resolveCardNote');
const start = original.indexOf(before);
const end = original.indexOf('\n}', start) + 2;
if (end < start) throw new Error('Unsupported Feishu bundle: unresolved footer function boundary');
const body = original.slice(start, end);
const alreadyPatched = body.includes(after) && body.includes(filteredReturn);
let next = original;
if (!alreadyPatched) {
  if (body.includes('dealclaw-feishu-footer-toggle-v3') ||
      (body.includes('dealclaw-feishu-footer-toggle-v2') && !(body.includes(v2) && body.includes(v2Return))) ||
      (body.includes('dealclaw-feishu-footer-toggle-v1') && !body.includes(v1))) {
    throw new Error('Incomplete footer patch');
  }
  const unpatched = body.replace(v2, before).replace(v2Return, originalReturn).replace(v1, before);
  if (unpatched.split(originalReturn).length !== 2) throw new Error('Unsupported Feishu bundle: expected parts return');
  // Upgrade the previous whole-footer patch in existing PVC installations too.
  const updated = unpatched.replace(before, after).replace(originalReturn, filteredReturn);
  next = original.slice(0, start) + updated + original.slice(end);
}
// Validate before writing so an unsupported bundle is never left half-patched.
execFileSync(process.execPath, ['--check', '--input-type=module'], { input: next, stdio: ['pipe', 'pipe', 'pipe'] });
if (!alreadyPatched) fs.writeFileSync(target, next);
console.log(`feishu_footer_toggle=ok changed=${alreadyPatched ? 'no' : 'yes'}`);
