import fs from 'node:fs';
import path from 'node:path';

/** Embedded into the pinned HTTP bundle. Inspect typed public fields only, never tool payloads. */
export function createFinalMediaBridge(runId, write) {
  let assistantRefs = new Set(), finalRefs = [], finalPayloadSeen = false, failed = false, emitted = false;
  const refs = (value) => {
    if (!Array.isArray(value) || value.length > 1000) return [];
    const unique = new Set();
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const ref = item.trim();
      if (!ref || ref.length > 8000 || /[\x00-\x1f\x7f]/.test(ref) || /^(?:data|javascript|vbscript):/i.test(ref)) continue;
      unique.add(ref);
      if (unique.size > 20) return [];
    }
    return [...unique];
  };
  const publicMedia = (data) => {
    if (!data || data.isReasoning === true || data.isCommentary === true || data.isError === true ||
      (data.phase !== undefined && data.phase !== 'final_answer')) return [];
    return refs([...(Array.isArray(data.mediaUrls) ? data.mediaUrls : []),...(typeof data.mediaUrl === 'string' ? [data.mediaUrl] : [])]);
  };
  return {
    observe(evt) {
      if (evt?.runId !== runId || emitted) return;
      if (evt.stream === 'lifecycle' && evt.data?.phase === 'error') {
        failed = true; assistantRefs.clear(); finalRefs = []; return;
      }
      if (evt.stream !== 'assistant' || evt.data?.isReasoning === true || evt.data?.isCommentary === true ||
        (evt.data?.phase !== undefined && evt.data.phase !== 'final_answer')) return;
      if (evt.data?.replace === true) assistantRefs.clear();
      for (const ref of publicMedia(evt.data)) assistantRefs.add(ref);
    },
    complete(payloads) {
      // These are the agent command's final outbound ReplyPayloads, not tool results.
      finalPayloadSeen = Array.isArray(payloads);
      finalRefs = finalPayloadSeen ? refs(payloads.flatMap(publicMedia)) : [];
    },
    emit(status) {
      if (emitted || failed || !finalPayloadSeen || status !== 'completed') return;
      emitted = true;
      // An intermediate stream path alone is insufficient proof of a final attachment.
      const mediaUrls = finalRefs.filter(ref => assistantRefs.has(ref));
      if (mediaUrls.length) write({type:'nexus.media',runId,phase:'final',mediaUrls});
    },
  };
}

const guard = '\t\tif (evt.runId !== responseId) return;\n\t\tif (closed) return;';
const legacyBlock = `
        // nexus-public-progress-v1
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
        }`;
const state = '\tlet finalUsage;\n\tlet finalizeStatus = null;';
const final = '\t\tconst usage = finalUsage;\n\t\tclosed = true;';
const result = '\t\t\tconst resultAny = result;\n\t\t\tconst resultPayloadText = ';
function once(source, anchor, code) {
  if (source.split(anchor).length !== 2) throw Error(code);
}
export function patchProgress(source) {
  const progress = `${guard}
        // nexus-public-progress-v2
        nexusFinalMedia.observe(evt);
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
        }`;
  const mediaState = `\tlet finalUsage;\n\t// nexus-final-media-state-v1\n${createFinalMediaBridge.toString()}\n\tconst nexusFinalMedia = createFinalMediaBridge(responseId, event => writeSseEvent(res, event));\n\tlet finalizeStatus = null;`;
  const mediaFinal = '\t\tconst usage = finalUsage;\n\t\t// nexus-final-media-emit-v1\n\t\tnexusFinalMedia.emit(finalizeRequested.status);\n\t\tclosed = true;';
  const mediaResult = '\t\t\tconst resultAny = result;\n\t\t\t// nexus-final-media-payload-v1\n\t\t\tnexusFinalMedia.complete(resultAny.payloads);\n\t\t\tconst resultPayloadText = ';
  if (source.includes('// nexus-public-progress-v2')) {
    for (const block of [progress,mediaState,mediaFinal,mediaResult]) once(source,block,'UNSUPPORTED_INSTALLED_OPENRESPONSES_MEDIA_PATCH');
    return source;
  }
  if (source.includes('// nexus-public-progress-v1')) {
    once(source,legacyBlock,'UNSUPPORTED_INSTALLED_OPENRESPONSES_PROGRESS_PATCH');
    source = source.replace(legacyBlock,'');
  }
  once(source,guard,'UNSUPPORTED_OPENRESPONSES_PROGRESS_ANCHOR');
  once(source,state,'UNSUPPORTED_OPENRESPONSES_MEDIA_STATE_ANCHOR');
  once(source,final,'UNSUPPORTED_OPENRESPONSES_MEDIA_FINAL_ANCHOR');
  once(source,result,'UNSUPPORTED_OPENRESPONSES_MEDIA_RESULT_ANCHOR');
  return source.replace(guard,progress).replace(state,mediaState).replace(final,mediaFinal).replace(result,mediaResult);
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
