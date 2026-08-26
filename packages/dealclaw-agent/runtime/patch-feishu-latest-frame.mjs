#!/usr/bin/env node
/**
 * Build-time compatibility patch for @openclaw/feishu@2026.7.1.
 *
 * Keep at most one pending streaming-card update: the newest full snapshot.
 * This prevents a completed agent response from replaying stale intermediate
 * frames in the Feishu client when the CardKit update queue is behind.
 *
 * Deliberately scoped: it does not alter card headers, Feishu typing animation,
 * CardKit print_step, or the OpenClaw update-throttle parameters.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_PLUGIN_ROOT = '/opt/dealclaw/plugins/feishu/node_modules/@openclaw/feishu';
const args = process.argv.slice(2);
const fileArgIndex = args.indexOf('--file');
const explicitFile = fileArgIndex >= 0 ? args[fileArgIndex + 1] : undefined;

function resolveTarget() {
  if (explicitFile) return path.resolve(explicitFile);
  const pluginRoot = process.env.FEISHU_PLUGIN_ROOT || DEFAULT_PLUGIN_ROOT;
  const distDir = path.join(pluginRoot, 'dist');
  const candidates = fs.readdirSync(distDir)
    .filter(name => /^monitor\.account-.*\.js$/.test(name) && !name.includes('.bak'))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(`Expected one monitor.account bundle in ${distDir}; found ${candidates.join(', ') || 'none'}`);
  }
  return path.join(distDir, candidates[0]);
}

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Unsupported @openclaw/feishu bundle: missing ${label}`);
  return source.replace(before, after);
}

const stateBefore = `\tlet partialUpdateQueue = Promise.resolve();\n\tlet streamingStartPromise = null;`;
const stateAfter = `\tlet partialUpdateQueue = Promise.resolve();\n\tlet streamingFlushScheduled = false;\n\tlet latestStreamingCombined = null;\n\tlet streamingStartPromise = null;`;

const flushBefore = `\tconst flushStreamingCardUpdate = (combined) => {\n\t\tpartialUpdateQueue = partialUpdateQueue.then(async () => {\n\t\t\tif (streamingStartPromise) await streamingStartPromise;\n\t\t\tif (streaming?.isActive()) await streaming.update(combined);\n\t\t});\n\t};`;
const flushAfter = `\tconst flushStreamingCardUpdate = (combined) => {\n\t\tlatestStreamingCombined = combined;\n\t\tif (streamingFlushScheduled) return;\n\t\tstreamingFlushScheduled = true;\n\t\tpartialUpdateQueue = partialUpdateQueue.then(async () => {\n\t\t\ttry {\n\t\t\t\twhile (latestStreamingCombined !== null) {\n\t\t\t\t\tconst nextCombined = latestStreamingCombined;\n\t\t\t\t\tlatestStreamingCombined = null;\n\t\t\t\t\tif (streamingStartPromise) await streamingStartPromise;\n\t\t\t\t\tif (streaming?.isActive()) await streaming.update(nextCombined);\n\t\t\t\t}\n\t\t\t} finally {\n\t\t\t\tstreamingFlushScheduled = false;\n\t\t\t}\n\t\t});\n\t};`;

const resetBefore = `\t\tstreamingStartPromise = null;\n\t\tpartialUpdateQueue = Promise.resolve();\n\t\tstreamText = "";`;
const resetAfter = `\t\tstreamingStartPromise = null;\n\t\tpartialUpdateQueue = Promise.resolve();\n\t\tstreamingFlushScheduled = false;\n\t\tlatestStreamingCombined = null;\n\t\tstreamText = "";`;

const markers = [
  'let streamingFlushScheduled = false;',
  'let latestStreamingCombined = null;',
  'while (latestStreamingCombined !== null)',
  'streamingFlushScheduled = false;',
];

function patch(source) {
  if (markers.every(marker => source.includes(marker))) return { source, changed: false };
  let next = source;
  next = replaceOnce(next, stateBefore, stateAfter, 'streaming state declaration');
  next = replaceOnce(next, flushBefore, flushAfter, 'flushStreamingCardUpdate implementation');
  next = replaceOnce(next, resetBefore, resetAfter, 'resetStreamingState implementation');
  if (!markers.every(marker => next.includes(marker))) throw new Error('Patch verification failed');
  return { source: next, changed: true };
}

const target = resolveTarget();
const original = fs.readFileSync(target, 'utf8');
const { source, changed } = patch(original);
if (changed) fs.writeFileSync(target, source);
execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
console.log(`feishu_latest_frame_coalescing=${markers.every(marker => source.includes(marker)) ? 'ok' : 'missing'}`);
console.log(`changed=${changed ? 'yes' : 'no'}`);
console.log('syntax=ok');
