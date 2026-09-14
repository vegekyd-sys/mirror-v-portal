import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/store.js';
const c=loadConfig(),s=new Store(c);
const id=process.env.NEXUS_PROFILE_TENANT_ID;
if(!id) throw Error('NEXUS_PROFILE_TENANT_ID required');
await s.init();
try {
 const parent=(await s.pool.query("SELECT message_id,session_key FROM elastic_runs WHERE tenant_id=$1 AND channel='feishu' ORDER BY created_at DESC LIMIT 1",[id])).rows[0];
 const run=await s.enqueue(id,`progress-${Date.now()}`,parent.session_key,'【小脸与过程流式验收】请先用一句中文告诉我你将验证什么，再调用 exec 工具运行 node -e \'setTimeout(()=>console.log("nexus-progress-ok"),12000)\'，等到真实输出后，再用文件工具读取 nexus-profile-proof.txt，最后简短汇报两个结果。过程请自然说明正在执行哪一步，不要只给最终结果。','feishu',parent.message_id);
 console.log('RUN',run.id);
 for(let i=0;i<180;i++) {
  const state=await s.run(run.id);
  if(['failed','uncertain'].includes(state.status)) throw Error(state.error || state.status);
  if(state.delivery==='sent') {
   // Outbox reaction cleanup follows delivery; give the API response time to persist.
   await new Promise(r=>setTimeout(r,1500));
   const events=(await s.pool.query("SELECT kind,data,created_at FROM elastic_events WHERE run_id=$1 AND kind<>'delta' ORDER BY seq",[run.id])).rows;
   const tool=events.find(e=>e.kind==='tool-progress' && e.data.phase==='start');
   const first=events.find(e=>e.kind==='feishu-first-content');
   const final=events.find(e=>e.kind==='runtime-completed');
   const updates=events.filter(e=>e.kind==='feishu-stream-update');
   const proof={runId:run.id,events,output:state.output};
   fs.writeFileSync(path.join(c.dataDir,'progress-verification.json'),JSON.stringify(proof,null,2),{mode:0o600});
   assert.ok(events.some(e=>e.kind==='typing-added'),'Typing reaction added');
   assert.ok(events.some(e=>e.kind==='typing-removed'),'Typing reaction removed');
   assert.ok(tool,'real tool lifecycle received');
   assert.ok(first && final && new Date(first.created_at)<new Date(final.created_at),'card before final');
   assert.ok(updates.some(e=>new Date(e.created_at)<new Date(final.created_at)),'live card updates');
   assert.ok(state.output.includes('nexus-progress-ok'),'actual command result');
   assert.ok(!events.some(e=>e.kind==='feishu-stream-error'),'no card fallback');
   console.log('PASS',JSON.stringify({runId:run.id,firstCard:first.created_at,toolStart:tool.created_at,completed:final.created_at,updates:updates.length}));
   break;
  }
  await new Promise(r=>setTimeout(r,1000));
  if(i===179) throw Error('VERIFY_TIMEOUT');
 }
} finally {await s.close();}
