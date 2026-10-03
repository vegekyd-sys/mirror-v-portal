import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error runtime module is shipped without declarations
import { createFinalMediaBridge, installProgress, patchProgress } from '../runtime/progress-patch.mjs';
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
 return {event:(evt)=>listener(evt),close:()=>{closed=true;},complete:(result)=>{
  finalUsage={input_tokens:1};
\t\t\tconst resultAny = result;
\t\t\tconst resultPayloadText = Array.isArray(resultAny.payloads)?resultAny.payloads.map(p=>p.text||'').join(''):'';
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
test('the exact installed v1 block upgrades to v2 once, while malformed v1 patches fail closed',()=>{
 const old=fixture.replace(guard,guard+legacy), patched=patchProgress(old);
 expect(patched).not.toContain('// nexus-public-progress-v1');expect(patched).toContain('// nexus-public-progress-v2');
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
  installProgress(root);const installed=fs.readFileSync(file,'utf8');expect(installed).toContain('nexus-public-progress-v2');installProgress(root);expect(fs.readFileSync(file,'utf8')).toBe(installed);
  fs.writeFileSync(file,'unsupported');expect(()=>installProgress(root)).toThrow();expect(fs.readFileSync(file,'utf8')).toBe('unsupported');
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'2026.9.1'}));expect(()=>installProgress(root)).toThrow('UNSUPPORTED_OPENCLAW_PROGRESS_VERSION');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
