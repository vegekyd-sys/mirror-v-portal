import fs from 'node:fs';
import path from 'node:path';
export function patchProgress(source) {
  const marker = '// nexus-public-progress-v1';
  if (source.includes(marker)) return source;
  const anchor = '\t\tif (evt.runId !== responseId) return;\n\t\tif (closed) return;';
  if (source.split(anchor).length !== 2) throw Error('UNSUPPORTED_OPENRESPONSES_PROGRESS_ANCHOR');
  return source.replace(anchor, `${anchor}
        ${marker}
        // Run-scoped public lifecycle only. Never forward arguments, results or reasoning.
        if (evt.stream === "tool") {
          const phase = evt.data?.phase;
          if (["start", "update", "result"].includes(phase)) writeSseEvent(res, {
            type: "nexus.tool", phase,
            name: typeof evt.data?.name === "string" ? evt.data.name.slice(0, 80) : "tool",
            toolCallId: typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId.slice(0, 160) : undefined
          });
          return;
        }
        if (evt.stream === "assistant" && isReplaceableAssistantStreamEvent(evt)) {
          const text = resolveAssistantStreamSnapshotText(evt);
          if (text) writeSseEvent(res, { type: "nexus.public_snapshot", text });
        }`);
}
export function installProgress(root) {
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(pkg.version !== '2026.7.1') throw Error('UNSUPPORTED_OPENCLAW_PROGRESS_VERSION');
  const files=fs.readdirSync(path.join(root,'dist')).filter(x=>/^openresponses-http-.*\.js$/.test(x));
  if(files.length!==1) throw Error('AMBIGUOUS_OPENRESPONSES_BUNDLE');
  const file=path.join(root,'dist',files[0]);
  const before=fs.readFileSync(file,'utf8'),after=patchProgress(before);
  if(after!==before) {
    fs.writeFileSync(`${file}.nexus-progress.tmp`,after);
    fs.renameSync(`${file}.nexus-progress.tmp`,file);
  }
}
