import fs from 'node:fs';
import path from 'node:path';

/** Embedded into the pinned HTTP bundle. Inspect typed public fields only, never tool payloads. */
export function createFinalMediaBridge(runId, write) {
  let assistantRefs = new Set(), finalRefs = [], finalPayloadSeen = false, failed = false, emitted = false;
  let lastPublicText = '', finalReplyText = '';
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
  const isPublic = (data) => data && data.isReasoning !== true && data.isCommentary !== true && data.isError !== true &&
    (data.phase === undefined || data.phase === 'final_answer');
  const publicMedia = (data) => isPublic(data)
    ? refs([...(Array.isArray(data.mediaUrls) ? data.mediaUrls : []),...(typeof data.mediaUrl === 'string' ? [data.mediaUrl] : [])]) : [];
  return {
    observe(evt) {
      if (evt?.runId !== runId || emitted) return;
      if (evt.stream === 'lifecycle' && evt.data?.phase === 'error') {
        failed = true; assistantRefs.clear(); finalRefs = []; lastPublicText = ''; return;
      }
      if (evt.stream !== 'assistant' || !isPublic(evt.data)) return;
      if (evt.data.replace === true) assistantRefs.clear();
      if (typeof evt.data.text === 'string') lastPublicText = evt.data.text.trim();
      for (const ref of publicMedia(evt.data)) assistantRefs.add(ref);
    },
    complete(payloads, meta) {
      // These are the resolved agent command's final outbound ReplyPayloads, not tool results.
      finalPayloadSeen = Array.isArray(payloads);
      finalRefs = finalPayloadSeen ? refs(payloads.flatMap(publicMedia)) : [];
      const texts = finalPayloadSeen ? payloads.filter(isPublic).map(p => typeof p.text === 'string' ? p.text.trim() : '').filter(Boolean) : [];
      finalReplyText = texts.join('\n\n');
      if (!failed || !meta || !['stop','end_turn','completed'].includes(meta.stopReason)) return false;
      if (meta.error || meta.timeoutPhase || (meta.livenessState !== undefined && meta.livenessState !== 'working') ||
        ['aborted','replayInvalid','yielded'].some(key => meta[key] !== undefined && meta[key] !== false) ||
        (meta.pendingToolCalls !== undefined && (!Array.isArray(meta.pendingToolCalls) || meta.pendingToolCalls.length))) return false;
      const hasFinalAssistant = [meta.finalAssistantVisibleText,meta.finalAssistantRawText].some(text => typeof text === 'string' && text.trim());
      const matchingText = lastPublicText && texts.includes(lastPublicText);
      const matchingMedia = finalRefs.some(ref => assistantRefs.has(ref));
      // Only a resolved, explicit successful terminal assistant may supersede an earlier attempt error.
      if (!hasFinalAssistant || (!matchingText && !matchingMedia)) return false;
      failed = false;
      return true;
    },
    finalText() { return finalReplyText; },
    emit(status) {
      if (emitted || failed || !finalPayloadSeen || status !== 'completed') return;
      emitted = true;
      // An intermediate stream path alone is insufficient proof of a final attachment.
      const mediaUrls = finalRefs.filter(ref => assistantRefs.has(ref));
      if (mediaUrls.length) write({type:'nexus.media',runId,phase:'final',mediaUrls});
    },
  };
}

// Exact source of the already deployed v2 bridge; required for a fail-closed upgrade.
export const legacyMediaBridgeSource = String.raw`function createFinalMediaBridge(runId, write) {
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
}`;

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
// 2026.9.1 computes the final text between reading usage and closing the stream.
const final91 = '\t\t\tconst usage = finalUsage;\n\t\t\tconst finalText = accumulatedText || bufferedReplaceableAssistantContent || finalizeRequested.text;\n\t\t\tclosed = true;';
const finalEmit = '\t\t// nexus-final-media-emit-v1\n\t\tnexusFinalMedia.emit(finalizeRequested.status);\n';
export const SUPPORTED_PROGRESS_VERSIONS = Object.freeze(['2026.7.1', '2026.9.1']);
const result = '\t\t\tconst resultAny = result;\n\t\t\tconst resultPayloadText = ';
function once(source, anchor, code) {
  if (source.split(anchor).length !== 2) throw Error(code);
}
function blocks(bridgeSource, progressVersion, stateVersion, payloadVersion, recover, finalAnchor = final) {
  const progress = `${guard}
        // nexus-public-progress-${progressVersion}
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
  const mediaState = `\tlet finalUsage;\n\t// nexus-final-media-state-${stateVersion}\n${bridgeSource}\n\tconst nexusFinalMedia = createFinalMediaBridge(responseId, event => writeSseEvent(res, event));\n\tlet finalizeStatus = null;`;
  const closeAt = finalAnchor.lastIndexOf('closed = true;');
  const indent = finalAnchor.slice(finalAnchor.lastIndexOf('\n', closeAt) + 1, closeAt);
  const mediaFinal = finalAnchor.slice(0, closeAt - indent.length) + finalEmit.replaceAll('\t\t', indent) + finalAnchor.slice(closeAt - indent.length);
  const resolution = recover ? `\t\t\tconst nexusRecovered = nexusFinalMedia.complete(resultAny.payloads, resultAny.meta);
\t\t\tif (nexusRecovered && finalizeRequested?.status === "failed") {
\t\t\t\tfinalizeStatus = "completed";
\t\t\t\tfinalizeRequested = { status: "completed", text: nexusFinalMedia.finalText() || finalizeRequested.text };
\t\t\t}` : '\t\t\tnexusFinalMedia.complete(resultAny.payloads);';
  const mediaResult = `\t\t\tconst resultAny = result;\n\t\t\t// nexus-final-media-payload-${payloadVersion}\n${resolution}\n\t\t\tconst resultPayloadText = `;
  return [progress,mediaState,mediaFinal,mediaResult];
}
export function patchProgress(source) {
  const finalAnchor = source.includes(final91) || source.includes(blocks(createFinalMediaBridge.toString(),'v3','v2','v2',true,final91)[2]) ? final91 : final;
  const anchors = [guard,state,finalAnchor,result];
  const current = blocks(createFinalMediaBridge.toString(),'v3','v2','v2',true,finalAnchor);
  if (source.includes('// nexus-public-progress-v3')) {
    for (const block of current) once(source,block,'UNSUPPORTED_INSTALLED_OPENRESPONSES_MEDIA_PATCH');
    return source;
  }
  if (source.includes('// nexus-public-progress-v2')) {
    const prior = blocks(legacyMediaBridgeSource,'v2','v1','v1',false);
    for (const block of prior) once(source,block,'UNSUPPORTED_INSTALLED_OPENRESPONSES_MEDIA_PATCH');
    for (let i=0;i<prior.length;i++) source = source.replace(prior[i],anchors[i]);
  }
  if (source.includes('// nexus-public-progress-v1')) {
    once(source,legacyBlock,'UNSUPPORTED_INSTALLED_OPENRESPONSES_PROGRESS_PATCH');
    source = source.replace(legacyBlock,'');
  }
  const codes = ['UNSUPPORTED_OPENRESPONSES_PROGRESS_ANCHOR','UNSUPPORTED_OPENRESPONSES_MEDIA_STATE_ANCHOR','UNSUPPORTED_OPENRESPONSES_MEDIA_FINAL_ANCHOR','UNSUPPORTED_OPENRESPONSES_MEDIA_RESULT_ANCHOR'];
  for (let i=0;i<anchors.length;i++) once(source,anchors[i],codes[i]);
  for (let i=0;i<anchors.length;i++) source = source.replace(anchors[i],current[i]);
  return source;
}
export function installProgress(root) {
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(!SUPPORTED_PROGRESS_VERSIONS.includes(pkg.version)) throw Error('UNSUPPORTED_OPENCLAW_PROGRESS_VERSION');
  const files=fs.readdirSync(path.join(root,'dist')).filter(x=>/^openresponses-http-.*\.js$/.test(x));
  if(files.length!==1) throw Error('AMBIGUOUS_OPENRESPONSES_BUNDLE');
  const file=path.join(root,'dist',files[0]);
  const before=fs.readFileSync(file,'utf8'),after=patchProgress(before);
  if(after!==before) {
    fs.writeFileSync(`${file}.nexus-progress.tmp`,after);
    fs.renameSync(`${file}.nexus-progress.tmp`,file);
  }
}
