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
const after = `${before}\n\t// dealclaw-feishu-footer-toggle-v1\n\tif (process.env.DEALCLAW_FEISHU_SHOW_FOOTER?.trim().toLowerCase() === "false") return undefined;`;
const original = fs.readFileSync(target, 'utf8');
const alreadyPatched = original.includes(after);
if (original.split(before).length !== 2) throw new Error('Unsupported Feishu bundle: expected one resolveCardNote');
if (!alreadyPatched && original.includes('dealclaw-feishu-footer-toggle-v1')) throw new Error('Incomplete footer patch');
const next = alreadyPatched ? original : original.replace(before, after);
// Validate before writing so an unsupported bundle is never left half-patched.
execFileSync(process.execPath, ['--check', '--input-type=module'], { input: next, stdio: ['pipe', 'pipe', 'pipe'] });
if (!alreadyPatched) fs.writeFileSync(target, next);
console.log(`feishu_footer_toggle=ok changed=${alreadyPatched ? 'no' : 'yes'}`);
