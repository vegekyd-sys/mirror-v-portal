import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error runtime module is shipped without declarations
import { createCommentaryBridge, createFinalMediaBridge, installProgress, legacyMediaBridgeSource, patchProgress } from '../runtime/progress-patch.mjs';
const guard='\t\tif (evt.runId !== responseId) return;\n\t\tif (closed) return;';
const legacy=`
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
// Pinned 7.1 control flow: matching-run events precede final usage/result resolution.
const fixture=`function createHandler(responseId,write) {
 const res={};const writeSseEvent=(res,event)=>write(event);
 const isReplaceableAssistantStreamEvent=(evt)=>evt.data.replaceable===true;
 const resolveAssistantStreamSnapshotText=(evt)=>evt.data.text;
 let listener;const onAgentEvent=(fn)=>{listener=fn;return()=>{};};
 let closed=false,finalizeRequested;
\tlet finalUsage;
\tlet finalizeStatus = null;
 const maybeFinalize=()=>{
  if(closed || !finalizeRequested || !finalUsage)return;
\t\tconst usage = finalUsage;
\t\tclosed = true;
  writeSseEvent(res,{type:'response.completed',response:{id:responseId,status:finalizeRequested.status,usage}});
 };
 const requestFinalize=(status)=>{if(finalizeRequested)return;finalizeRequested={status};maybeFinalize();};
 onAgentEvent((evt)=>{
${guard}
  if(evt.stream==='assistant')return;
  if(evt.stream==='lifecycle' && ['end','error'].includes(evt.data.phase))requestFinalize(evt.data.phase==='error'?'failed':'completed');
 });
 return {event:(evt)=>listener(evt),close:()=>{closed=true;},reject:()=>{finalUsage={input_tokens:1};writeSseEvent(res,{type:'response.failed',response:{status:'failed'}});listener({runId:responseId,stream:'lifecycle',data:{phase:'error'}});},complete:(result)=>{
  finalUsage={input_tokens:1};
\t\t\tconst resultAny = result;
\t\t\tconst resultPayloadText = Array.isArray(resultAny.payloads)?resultAny.payloads.map(p=>p.text||'').join(''):'';
  if(result.unsatisfiedToolChoice===true){closed=true;writeSseEvent(res,{type:'response.failed',response:{status:'failed'}});return resultPayloadText;}
  if(result.meta?.stopReason==='tool_calls' && result.meta.pendingToolCalls?.length){closed=true;writeSseEvent(res,{type:'response.completed',response:{status:'incomplete'}});return resultPayloadText;}
  maybeFinalize();return resultPayloadText;
 }};
}`;
function handler(source=fixture) {
 const events:any[]=[];
 const create=new Function(`${patchProgress(source)}; return createHandler;`)();
 return {events,bridge:create('run-current',(event:any)=>events.push(event))};
}
const assistant=(mediaUrls:string[],extra={})=>({runId:'run-current',stream:'assistant',data:{mediaUrls,...extra}});
const end={runId:'run-current',stream:'lifecycle',data:{phase:'end'}};

test('patch exposes run-scoped public tool fields and final typed media, with exact-anchor idempotence',()=>{
 const patched=patchProgress(fixture);
 expect(patchProgress(patched)).toBe(patched);
 expect(patched.indexOf('evt.runId !== responseId')).toBeLessThan(patched.indexOf('nexusFinalMedia.observe(evt)'));
 expect(patched).not.toContain('evt.data.args');expect(patched).not.toContain('evt.data.result');
 for(const fragment of ['let finalUsage;','const usage = finalUsage;','const resultAny = result;',guard])expect(()=>patchProgress(fixture.replace(fragment,'changed'))).toThrow();
 expect(()=>patchProgress(`${fixture}\n${guard}`)).toThrow('UNSUPPORTED_OPENRESPONSES_PROGRESS_ANCHOR');
 expect(()=>patchProgress(patched.replace('nexusFinalMedia.emit(finalizeRequested.status);','changed;'))).toThrow('UNSUPPORTED_INSTALLED_OPENRESPONSES_MEDIA_PATCH');
});
test('the exact installed v1 block upgrades to v4 once, while malformed v1 patches fail closed',()=>{
 const old=fixture.replace(guard,guard+legacy), patched=patchProgress(old);
 expect(patched).not.toContain('// nexus-public-progress-v1');expect(patched).toContain('// nexus-public-progress-v4');
 expect(patchProgress(patched)).toBe(patched);
 expect(()=>patchProgress(old.replace('name.slice(0, 80)','name.slice(0, 81)'))).toThrow('UNSUPPORTED_INSTALLED_OPENRESPONSES_PROGRESS_PATCH');
});
test('real normalized MEDIA refs survive missing text directives only at final completion with usage',()=>{
 const {events,bridge}=handler();
 bridge.event(assistant(['/vercel/sandbox/agent-data/workspace/final.jpg']));
 bridge.event(end);expect(events).toEqual([]);
 bridge.complete({payloads:[{text:'这是成品',mediaUrls:['/vercel/sandbox/agent-data/workspace/final.jpg']}]});
 expect(events.map(event=>event.type)).toEqual(['nexus.media','response.completed']);
 expect(events[0]).toEqual({type:'nexus.media',runId:'run-current',phase:'final',mediaUrls:['/vercel/sandbox/agent-data/workspace/final.jpg']});
 bridge.event(end);bridge.complete({payloads:[{mediaUrl:'/vercel/sandbox/agent-data/workspace/final.jpg'}]});
 expect(events.filter(event=>event.type==='nexus.media')).toHaveLength(1);
});
test('intermediate, tool-result, reasoning, commentary, stale-run and absent-final-proof refs never become final attachments',()=>{
 const {events,bridge}=handler();
 bridge.event(assistant(['partial.jpg']));
 bridge.event({runId:'run-current',stream:'tool',data:{phase:'result',result:{mediaUrls:['tool.jpg']},args:{mediaUrls:['args.jpg']}}});
 bridge.event({runId:'other-run',stream:'assistant',data:{mediaUrls:['other.jpg']}});
 bridge.event(assistant(['thinking.jpg'],{isReasoning:true}));
 bridge.event(assistant(['progress.jpg'],{phase:'commentary'}));
 bridge.event(assistant(['old.jpg']));bridge.event(assistant(['final.jpg'],{replace:true}));
 bridge.event(end);
 bridge.complete({payloads:[{mediaUrls:['partial.jpg','tool.jpg','args.jpg','other.jpg','old.jpg','final.jpg']},{mediaUrls:['thinking.jpg'],isReasoning:true},{mediaUrl:'progress.jpg',isCommentary:true}]});
 expect(events.find(event=>event.type==='nexus.media').mediaUrls).toEqual(['final.jpg']);
 const absent=handler();absent.bridge.event(assistant(['draft.jpg']));absent.bridge.event(end);absent.bridge.complete({payloads:[{text:'final, no attachment'}]});
 expect(absent.events.some(event=>event.type==='nexus.media')).toBe(false);
});
test('explicit resend and singular final mediaUrl remain valid after tool activity, without forcing Claude phase',()=>{
 const {events,bridge}=handler();
 bridge.event(assistant(['resend.jpg','resend.jpg']));
 bridge.event({runId:'run-current',stream:'tool',data:{phase:'start',name:'read',args:{path:'private'}}});
 bridge.event(end);bridge.complete({payloads:[{mediaUrl:'resend.jpg'}]});
 expect(events.find(event=>event.type==='nexus.media').mediaUrls).toEqual(['resend.jpg']);
 expect(events.find(event=>event.type==='nexus.tool')).toEqual({type:'nexus.tool',phase:'start',name:'read',toolCallId:undefined});
});
test('failed, incomplete, disconnected and final payloads without matching assistant proof emit no media',()=>{
 for(const status of ['failed','incomplete']) {
  const emitted:any[]=[];const bridge=createFinalMediaBridge('run-current',(event:any)=>emitted.push(event));
  bridge.observe(assistant(['file.jpg']));bridge.complete([{mediaUrls:['file.jpg']}]);bridge.emit(status);expect(emitted).toEqual([]);
 }
 const failed=handler();failed.bridge.event(assistant(['file.jpg']));failed.bridge.event({runId:'run-current',stream:'lifecycle',data:{phase:'error'}});failed.bridge.complete({payloads:[{mediaUrl:'file.jpg'}]});
 expect(failed.events.some(event=>event.type==='nexus.media')).toBe(false);
 const disconnected=handler();disconnected.bridge.close();disconnected.bridge.event(assistant(['file.jpg']));disconnected.bridge.event(end);disconnected.bridge.complete({payloads:[{mediaUrl:'file.jpg'}]});expect(disconnected.events).toEqual([]);
 const noAssistant=handler();noAssistant.bridge.event(end);noAssistant.bridge.complete({payloads:[{mediaUrl:'not-publicly-attached.jpg'}]});expect(noAssistant.events.some(event=>event.type==='nexus.media')).toBe(false);
});
test('typed media schema filters control/data refs, deduplicates and limits output without exposing arbitrary fields',()=>{
 const emitted:any[]=[];const bridge=createFinalMediaBridge('run-current',(event:any)=>emitted.push(event));
 const refs=[' final.jpg ','final.jpg','bad\npath','data:image/png;base64,PRIVATE','javascript:alert(1)',42,'x'.repeat(8001)];
 bridge.observe({runId:'run-current',stream:'assistant',data:{mediaUrls:refs,secret:'PRIVATE',text:'not sent',args:{token:'PRIVATE'}}});bridge.complete([{mediaUrls:refs}]);bridge.emit('completed');
 expect(emitted).toEqual([{type:'nexus.media',runId:'run-current',phase:'final',mediaUrls:['final.jpg']}]);expect(JSON.stringify(emitted)).not.toContain('PRIVATE');
 const capped:any[]=[];const tooMany=createFinalMediaBridge('run-current',(event:any)=>capped.push(event));const many=Array.from({length:21},(_,i)=>`${i}.jpg`);
 tooMany.observe(assistant(many));tooMany.complete([{mediaUrls:many}]);tooMany.emit('completed');expect(capped).toEqual([]);
});
test('installer checks pinned version and upgrades its only bundle atomically; unsupported source remains intact',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-progress-test-'));fs.mkdirSync(path.join(root,'dist'));
 const file=path.join(root,'dist/openresponses-http-test.js');
 try {
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'2026.7.1'}));fs.writeFileSync(file,fixture.replace(guard,guard+legacy));
  installProgress(root);const installed=fs.readFileSync(file,'utf8');expect(installed).toContain('nexus-public-progress-v4');installProgress(root);expect(fs.readFileSync(file,'utf8')).toBe(installed);
  fs.writeFileSync(file,'unsupported');expect(()=>installProgress(root)).toThrow();expect(fs.readFileSync(file,'utf8')).toBe('unsupported');
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'2026.9.2'}));expect(()=>installProgress(root)).toThrow('UNSUPPORTED_OPENCLAW_PROGRESS_VERSION');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

const terminalMeta={stopReason:'stop',aborted:false,livenessState:'working',finalAssistantRawText:'Done. MEDIA: final.mp4'};
const attemptError={runId:'run-current',stream:'lifecycle',data:{phase:'error',error:'Context overflow: estimated context size exceeds safe threshold during tool loop.'}};
test('a resolved successful final assistant supersedes transient attempt failure without releasing partial media',()=>{
 const {events,bridge}=handler();
 bridge.event(assistant(['old-partial.jpg'],{text:'partial'}));bridge.event(attemptError);
 expect(events).toEqual([]);
 bridge.event(assistant(['final.mp4'],{text:'Done.'}));bridge.event(end);
 expect(events).toEqual([]);
 bridge.complete({payloads:[{text:'Done.',mediaUrls:['old-partial.jpg','final.mp4']}],meta:terminalMeta});
 expect(events.map(event=>event.type)).toEqual(['nexus.media','response.completed']);
 expect(events[0].mediaUrls).toEqual(['final.mp4']);
 expect(events[1].response.status).toBe('completed');
});
test('strict terminal recovery also handles public text without manufacturing a media attachment',()=>{
 for(const stopReason of ['stop','end_turn','completed']) {
  const {events,bridge}=handler();bridge.event(attemptError);bridge.event(assistant([],{text:'Done.'}));bridge.event(end);
  bridge.complete({payloads:[{text:'Done.'}],meta:{...terminalMeta,stopReason}});
  expect(events).toHaveLength(1);expect(events[0].response.status).toBe('completed');
 }
});
test('errors, aborts, timeouts, invalid replay, yield, client tools and unproven terminal replies remain failed',()=>{
 const badMeta=[{...terminalMeta,stopReason:'error'},{...terminalMeta,stopReason:'length'},{...terminalMeta,stopReason:undefined},{...terminalMeta,error:{kind:'incomplete_turn'}},{...terminalMeta,aborted:true},{...terminalMeta,timeoutPhase:'prompt'},{...terminalMeta,replayInvalid:true},{...terminalMeta,yielded:true},{...terminalMeta,livenessState:'blocked'},{...terminalMeta,pendingToolCalls:[{name:'client'}]},{...terminalMeta,pendingToolCalls:{}},{...terminalMeta,finalAssistantRawText:undefined}];
 for(const meta of badMeta) {
  const {events,bridge}=handler();bridge.event(attemptError);bridge.event(assistant(['final.mp4'],{text:'Done.'}));bridge.event(end);
  bridge.complete({payloads:[{text:'Done.',mediaUrls:['final.mp4']}],meta});
  expect(events.some(event=>event.type==='nexus.media')).toBe(false);expect(events.at(-1).response.status).toBe('failed');
 }
 const mismatched=handler();mismatched.bridge.event(attemptError);mismatched.bridge.event(assistant([],{text:'Still working'}));mismatched.bridge.event(end);mismatched.bridge.complete({payloads:[{text:'Done.'}],meta:terminalMeta});
 expect(mismatched.events.at(-1).response.status).toBe('failed');
 const reasoning=handler();reasoning.bridge.event(attemptError);reasoning.bridge.event(assistant(['final.mp4'],{text:'Done.',isReasoning:true}));reasoning.bridge.event(end);reasoning.bridge.complete({payloads:[{text:'Done.',mediaUrl:'final.mp4',isReasoning:true}],meta:terminalMeta});
 expect(reasoning.events.at(-1).response.status).toBe('failed');
});
test('final command rejection and explicit tool-choice or incomplete branches cannot be recovered',()=>{
 const rejected=handler();rejected.bridge.event(attemptError);rejected.bridge.event(assistant(['final.mp4'],{text:'Done.'}));rejected.bridge.reject();
 expect(rejected.events.some(event=>event.type==='response.failed')).toBe(true);expect(rejected.events.some(event=>event.type==='nexus.media')).toBe(false);
 for(const result of [{unsatisfiedToolChoice:true,payloads:[{text:'Done.',mediaUrl:'final.mp4'}],meta:terminalMeta},{payloads:[{text:'Done.',mediaUrl:'final.mp4'}],meta:{...terminalMeta,stopReason:'tool_calls',pendingToolCalls:[{id:'client-call',name:'client'}]}}]) {
  const {events,bridge}=handler();bridge.event(attemptError);bridge.event(assistant(['final.mp4'],{text:'Done.'}));bridge.event(end);bridge.complete(result);
  expect(events.some(event=>event.type==='nexus.media')).toBe(false);expect(events.at(-1).response.status).not.toBe('completed');
 }
});
// The exact v3 text deployed before commentary/preview items (2026-10-09).
function deployedV3(source:string) {
 return patchProgress(source)
  .replace('// nexus-public-progress-v4','// nexus-public-progress-v3')
  .replace('// nexus-final-media-state-v3','// nexus-final-media-state-v2')
  .replace(`\n${createCommentaryBridge.toString()}\n\tconst nexusCommentary = createCommentaryBridge(event => writeSseEvent(res, event));`,'')
  .replace('        if (evt.stream === "item") {\n          nexusCommentary.item(evt.data, typeof streamedAssistantText === "string" ? streamedAssistantText : "");\n          return;\n        }\n','')
  .replace('          if (["start", "update", "result"].includes(phase)) nexusCommentary.boundary(typeof streamedAssistantText === "string" ? streamedAssistantText : "");\n','');
}
function deployedV2(source:string) {
 return deployedV3(source)
  .replace(createFinalMediaBridge.toString(),legacyMediaBridgeSource)
  .replace('// nexus-public-progress-v3','// nexus-public-progress-v2')
  .replace('// nexus-final-media-state-v2','// nexus-final-media-state-v1')
  .replace('// nexus-final-media-payload-v2','// nexus-final-media-payload-v1')
  .replace('\t\t\tconst nexusRecovered = nexusFinalMedia.complete(resultAny.payloads, resultAny.meta);\n\t\t\tif (nexusRecovered && finalizeRequested?.status === "failed") {\n\t\t\t\tfinalizeStatus = "completed";\n\t\t\t\tfinalizeRequested = { status: "completed", text: nexusFinalMedia.finalText() || finalizeRequested.text };\n\t\t\t}', '\t\t\tnexusFinalMedia.complete(resultAny.payloads);');
}
test('known deployed v2 upgrades to v4 exactly and malformed v2 remains fail-closed',()=>{
 const old=deployedV2(fixture),patched=patchProgress(old);
 expect(patched).toBe(patchProgress(fixture));expect(patchProgress(patched)).toBe(patched);
 expect(()=>patchProgress(old.replace('failed = true; assistantRefs.clear();','failed = false; assistantRefs.clear();'))).toThrow('UNSUPPORTED_INSTALLED_OPENRESPONSES_MEDIA_PATCH');
});

test('2026.9.1 bundle: final text is computed between usage and close; patch is idempotent and emits media before closing', () => {
  const source = [
    '\tlet finalUsage;\n\tlet finalizeStatus = null;\n\tlet finalizeRequested = null;',
    '\t\t\tconst usage = finalUsage;\n\t\t\tconst finalText = accumulatedText || bufferedReplaceableAssistantContent || finalizeRequested.text;\n\t\t\tclosed = true;',
    '\tunsubscribe = onAgentEventForRun(responseId, (evt) => {\n\t\tif (evt.runId !== responseId) return;\n\t\tif (closed) return;\n\t});',
    '\t\t\tconst resultAny = result;\n\t\t\tconst resultPayloadText = resolveResponsePayloadText(result);',
  ].join('\n');
  const patched = patchProgress(source);
  expect(patched).toContain('// nexus-public-progress-v4');
  expect(patchProgress(patched)).toBe(patched);
  const emit = patched.indexOf('\t\t\tnexusFinalMedia.emit(finalizeRequested.status);');
  expect(emit).toBeGreaterThan(patched.indexOf('const finalText = accumulatedText'));
  expect(emit).toBeLessThan(patched.indexOf('\t\t\tclosed = true;'));
});

test('known deployed v3 upgrades to v4 exactly; v4 is idempotent and a modified v3 or v4 fails closed',()=>{
 const v3=deployedV3(fixture);
 expect(v3).toContain('// nexus-public-progress-v3');expect(v3).not.toContain('nexusCommentary');
 const v4=patchProgress(v3);
 expect(v4).toBe(patchProgress(fixture));expect(patchProgress(v4)).toBe(v4);
 expect(()=>patchProgress(v3.replace('name.slice(0, 80)','name.slice(0, 81)'))).toThrow('UNSUPPORTED_INSTALLED_OPENRESPONSES_MEDIA_PATCH');
 expect(()=>patchProgress(v4.replace("if (data.kind !== 'preamble'","if (data.kind === 'preamble'"))).toThrow('UNSUPPORTED_INSTALLED_OPENRESPONSES_MEDIA_PATCH');
});
test('public text items become nexus.preview / nexus.commentary before the tool event, text only',()=>{
 const {events,bridge}=handler();
 const item=(data:any)=>bridge.event({runId:'run-current',stream:'item',data});
 item({kind:'nexus_preview',text:'我先'});item({kind:'nexus_preview',text:'我先查一下'});
 item({kind:'preamble',phase:'update',progressText:'我先查一下。',itemId:'c1'});
 item({kind:'preamble',phase:'update',progressText:'我先查一下。',itemId:'c1'});
 item({kind:'preamble',phase:'end',progressText:'我先查一下。',itemId:'c1',args:{secret:'PRIVATE'}});
 bridge.event({runId:'run-current',stream:'tool',data:{phase:'start',name:'web_search',args:{q:'PRIVATE'}}});
 item({kind:'nexus_preview',text:'结论'});
 bridge.event({runId:'other-run',stream:'item',data:{kind:'preamble',phase:'end',progressText:'other'}});
 item({kind:'preamble',phase:'end',progressText:'hidden',isReasoning:true});
 expect(events.map(event=>event.type)).toEqual(['nexus.preview','nexus.preview','nexus.commentary','nexus.tool','nexus.preview']);
 expect(events[0]).toEqual({type:'nexus.preview',seq:1,text:'我先',delta:'我先',reset:true});
 expect(events[1]).toEqual({type:'nexus.preview',seq:1,text:'我先查一下',delta:'查一下'});
 expect(events[2]).toEqual({type:'nexus.commentary',text:'我先查一下。',itemId:'c1',previewSeq:1});
 expect(events[4]).toEqual({type:'nexus.preview',seq:2,text:'结论',delta:'结论',reset:true});
 expect(JSON.stringify(events)).not.toContain('PRIVATE');
});
test('commentary bridge: unfinished narration flushes at the tool boundary; narration already in output_text is retractable',()=>{
 const out:any[]=[];const bridge=createCommentaryBridge((event:any)=>out.push(event));
 bridge.item({kind:'nexus_preview',text:'Let me check'},'');
 bridge.item({kind:'preamble',phase:'update',progressText:'Let me check.',itemId:'a'},'');
 bridge.boundary('');
 expect(out.at(-1)).toEqual({type:'nexus.commentary',text:'Let me check.',itemId:'a',previewSeq:1});
 bridge.item({kind:'preamble',phase:'end',progressText:'Let me check.',itemId:'a'},'');
 expect(out.filter(event=>event.type==='nexus.commentary')).toHaveLength(1);
 // Non-reasoning turns stream narration as ordinary output_text before OpenClaw classifies it.
 const streamed='Fetched it.\nNow  the second page.';
 bridge.item({kind:'preamble',phase:'end',progressText:'Fetched it. Now the second page.',itemId:'b'},streamed);
 expect(out.at(-1)).toEqual({type:'nexus.commentary',text:'Fetched it. Now the second page.',itemId:'b',retract:streamed.length});
 bridge.item({kind:'preamble',phase:'end',progressText:'Different narration.',itemId:'c'},streamed+'Final answer');
 expect(out.at(-1).retract).toBeUndefined();
});
