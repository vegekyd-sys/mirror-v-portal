import fs from 'node:fs';
import path from 'node:path';

// Mirror V (OpenClaw 2026.9.1 + vlab-worker): live provisional text for DeepSeek reasoning turns.
//
// Upstream holds a reasoning Chat Completions message's visible text twice until the message
// ends, because only then is its phase known (commentary before a tool call vs final answer):
//  1. @openclaw/ai: the reasoning-tag partitioner turns strict after reasoning_content and
//     releases no text until flush (tool call or end of stream);
//  2. builtin runner: `if (isReasoningCompletionsText) return;` emits nothing until terminal.
// We keep phase ownership exactly as upstream and only add a text-only, throttled preview item
// (`item` kind `nexus_preview`) that the OpenResponses patch turns into `nexus.preview`.
// Every edit is an exact single anchor; any mismatch throws before a file is written.

const MARK = 'nexus-reasoning-preview-v1';

// (1) DeepSeek returns reasoning in reasoning_content, never as inline tags in content: keep its
// content on the visible partitioner path so text_delta is released while it streams.
const strictEdits = [
  ['\t\tif (forceStrict || reasoningTagTextPartitioner.hasPending()) reasoningTagTextPartitioner.markStrict();',
    '\t\tif (!nexusVisibleDeepSeekText && (forceStrict || reasoningTagTextPartitioner.hasPending())) reasoningTagTextPartitioner.markStrict();'],
  ['const routedDeltas = hasReasoningThinking ? reasoningTagTextPartitioner.push(contentDelta.text) : reasoningTagTextPartitioner.pushVisible(contentDelta.text);',
    'const routedDeltas = hasReasoningThinking && !nexusVisibleDeepSeekText ? reasoningTagTextPartitioner.push(contentDelta.text) : reasoningTagTextPartitioner.pushVisible(contentDelta.text);'],
];
export const completionsEdits = [
  // npm @openclaw/ai 2026.9.1 (runtimes up to r4).
  [['\tconst shouldFilterDeepSeekDsmlText = !directMode && compat.thinkingFormat === "deepseek";\n',
    `\tconst shouldFilterDeepSeekDsmlText = !directMode && compat.thinkingFormat === "deepseek";\n\t// ${MARK}: DeepSeek content carries no inline reasoning tags; stream it on the visible path.\n\tconst nexusVisibleDeepSeekText = shouldFilterDeepSeekDsmlText;\n`],
  ...strictEdits],
  // V's file since 2026-11-08 (dsml-spaced-calls-v1): DSML filtering also covers direct mode;
  // the preview keeps the earlier scope (DeepSeek, not direct).
  [['\t// dsml-spaced-calls-v1: direct calls hide DSML text too, but never recover tools from it\n\tconst shouldFilterDeepSeekDsmlText = compat.thinkingFormat === "deepseek";\n',
    `\t// dsml-spaced-calls-v1: direct calls hide DSML text too, but never recover tools from it\n\tconst shouldFilterDeepSeekDsmlText = compat.thinkingFormat === "deepseek";\n\t// ${MARK}: DeepSeek content carries no inline reasoning tags; stream it on the visible path.\n\tconst nexusVisibleDeepSeekText = !directMode && shouldFilterDeepSeekDsmlText;\n`],
  ...strictEdits],
];

// (2) The runner still returns before any phase-bearing emission; it only publishes a snapshot
// of the current text block, at most every 100 ms (snapshots are lossless to throttle).
const runner = [[
  ['\tif (isReasoningCompletionsText) return;\n',
    `\tif (isReasoningCompletionsText) {
\t\t// ${MARK}: phase stays terminal-owned; publish a provisional text snapshot only.
\t\tif (chunk && !skipLiveStream && !ctx.params.silentExpected && !suppressDeterministicApprovalOutput && !suppressMessageToolOnlySourceReplyOutput) {
\t\t\tconst nexusNow = Date.now();
\t\t\tif (!(nexusNow - (ctx.state.nexusPreviewAt ?? 0) < 100) || chunk.includes("\\n")) {
\t\t\t\tctx.state.nexusPreviewAt = nexusNow;
\t\t\t\ttry {
\t\t\t\t\temitAgentEvent({ runId: ctx.params.runId, stream: "item", data: { kind: "nexus_preview", text: ctx.state.streamBlockText, hideFromChannelProgress: true } });
\t\t\t\t} catch {}
\t\t\t}
\t\t}
\t\treturn;
\t}
`],
]];

// (3) vlab-worker relays a child's public stream to the Gateway bus; allow the preview item
// through with a text-only projection (same routing fields as every other relayed event).
const publish = [[
  ["    if (!publicStreams.has(event?.stream) && !publicPreamble) continue;\n",
    `    // ${MARK}: provisional visible text of a phase-pending reasoning message (text only).
    if (event.stream === 'item' && data.kind === 'nexus_preview') {
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 100000) continue;
      emit({
        runId: params.runId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        lifecycleGeneration: params.lifecycleGeneration,
        stream: 'item',
        data: { kind: 'nexus_preview', text: data.text, hideFromChannelProgress: true },
      });
      published++;
      continue;
    }
    if (!publicStreams.has(event?.stream) && !publicPreamble) continue;
`],
]];

/**
 * Apply one of several exact edit sets (one per known build of the file). A file that already
 * carries the mark must hold one set's results exactly; otherwise exactly one set's anchors must
 * each occur once. Anything else throws before a file is written.
 */
export function patchExact(source, variants, code) {
  const unique = (text) => source.split(text).length === 2;
  if (source.includes(MARK)) {
    if (variants.some((edits) => edits.every(([, to]) => unique(to)))) return source;
    throw Error(`UNSUPPORTED_INSTALLED_${code}`);
  }
  const matching = variants.filter((edits) => edits.every(([from]) => unique(from)));
  if (matching.length !== 1) throw Error(`UNSUPPORTED_${code}_ANCHOR`);
  for (const [from, to] of matching[0]) source = source.replace(from, () => to);
  return source;
}

function single(dir, pattern, code) {
  const files = fs.readdirSync(dir).filter((name) => pattern.test(name));
  if (files.length !== 1) throw Error(`AMBIGUOUS_${code}`);
  return path.join(dir, files[0]);
}

/** Patch all three files or none: every target is checked before the first write. */
export function installStreamPreview({ openclawRoot, workerDist }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(openclawRoot, 'package.json'), 'utf8'));
  if (pkg.version !== '2026.9.1') throw Error('UNSUPPORTED_OPENCLAW_STREAM_PREVIEW_VERSION');
  const aiDist = path.join(path.dirname(openclawRoot), '@openclaw', 'ai', 'dist');
  const runnerFile = path.join(openclawRoot, 'dist', 'builtin-openclaw-zQV8Wwjr.js');
  const targets = [
    [single(aiDist, /^openai-completions-stream-.*\.mjs$/, 'COMPLETIONS_STREAM'), completionsEdits, 'COMPLETIONS_STREAM'],
    [runnerFile, runner, 'REASONING_RUNNER'],
    [path.join(workerDist, 'gateway-public-stream.mjs'), publish, 'WORKER_PUBLIC_STREAM'],
  ].map(([file, edits, code]) => {
    const before = fs.readFileSync(file, 'utf8');
    return { file, before, after: patchExact(before, edits, code) };
  });
  for (const { file, before, after } of targets) {
    if (after === before) continue;
    fs.writeFileSync(`${file}.nexus-preview.tmp`, after);
    fs.renameSync(`${file}.nexus-preview.tmp`, file);
  }
  return targets.filter(({ before, after }) => before !== after).map(({ file }) => file);
}
