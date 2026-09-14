import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { VercelProvider } from '../src/provider.js';
const c = loadConfig(), store = new Store(c);
let provider = new VercelProvider(c);
const stamp = Date.now();
const evidence: any = { at: new Date().toISOString(), agents: [] };
const tenants: any[] = [];
try {
  for (const label of ['A','B']) {
    const tenant = await store.createTenant(`memory-${stamp}-${label.toLowerCase()}`, `记忆隔离验收 ${label}`);
    tenants.push(tenant);
    await store.pool.query("UPDATE elastic_tenants SET state='testing' WHERE id=$1", [tenant.id]);
    const ready = await provider.ensure(tenant, async name => {
      tenant.sandbox_name = name;
      await store.pool.query('UPDATE elastic_tenants SET sandbox_name=$2 WHERE id=$1', [tenant.id, name]);
    });
    const marker = `${label}-${randomBytes(12).toString('hex')}`;
    const output = await provider.execute(tenant, 'remember', `请记住我的业务偏好：对外报价统一使用项目编号 ${marker}。请调用文件工具写入普通业务笔记 memory/nexus-customer-preference.md（不是核心文件），供之后新会话读取。完成后简短确认。`, async()=>{});
    console.log('WRITE_OUTPUT',label,output); // File readback, not response wording, proves the write.
    const box = await provider.get(tenant, false);
    const memory = (await box.readFileToBuffer({path:'/vercel/sandbox/agent-data/workspace/memory/nexus-customer-preference.md'}))!.toString();
    assert.ok(memory.includes(marker), 'actual memory file');
    const row: any = { label, tenantId:tenant.id, sandboxName:ready.name, marker, beforeSession:box.currentSession().sessionId, writeOutput:output };
    const stopped = await provider.stop(tenant);
    assert.equal(stopped.stopped,true);
    assert.equal((await provider.get(tenant,false)).status,'stopped');
    row.snapshotId=stopped.snapshotId;
    evidence.agents.push(row);
    console.log('WRITE_STOP_OK', label, row.beforeSession);
  }
  // Discard all controller-side Sandbox handles before restoration.
  provider = new VercelProvider(c);
  for (let i=0;i<tenants.length;i++) {
    const tenant=tenants[i], row=evidence.agents[i], other=evidence.agents[1-i];
    await provider.ensure(tenant);
    const box=await provider.get(tenant,false);
    row.afterSession=box.currentSession().sessionId;
    assert.notEqual(row.beforeSession,row.afterSession,'new physical VM session');
    const memory=(await box.readFileToBuffer({path:'/vercel/sandbox/agent-data/workspace/memory/nexus-customer-preference.md'}))!.toString();
    assert.ok(memory.includes(row.marker));
    assert.ok(!memory.includes(other.marker),'other agent memory absent');
    // Fresh conversation: no marker or previous conversation is supplied.
    row.recallOutput=await provider.execute(tenant, `fresh-${stamp}`, '这是全新会话。请读取业务笔记 memory/nexus-customer-preference.md，告诉我对外报价使用什么项目编号。只回复编号；找不到就说不知道。',async()=>{});
    assert.ok(row.recallOutput.includes(row.marker),'fresh session recall');
    assert.ok(!row.recallOutput.includes(other.marker));
    const scan=await box.runCommand({cmd:'node',args:['-e',`const fs=require('fs'),p=require('path');let found=false;function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())walk(f);else if(e.isFile()&&fs.readFileSync(f).includes(Buffer.from(process.argv[1])))found=true;}}walk('/vercel/sandbox/agent-data');process.stdout.write(JSON.stringify({otherMarkerAbsent:!found}));`,other.marker]});
    assert.equal(scan.exitCode,0);
    row.isolation=JSON.parse(await scan.stdout());
    assert.equal(row.isolation.otherMarkerAbsent,true);
    row.finalStop=await provider.stop(tenant);
    assert.equal((await provider.get(tenant,false)).status,'stopped');
    await store.pool.query("UPDATE elastic_tenants SET state='sleeping',snapshot_id=$2 WHERE id=$1",[tenant.id,row.finalStop.snapshotId]);
    row.passed=true;
    console.log('RESTORE_RECALL_ISOLATION_OK',row.label,row.afterSession);
  }
  assert.notEqual(evidence.agents[0].sandboxName,evidence.agents[1].sandboxName);
  evidence.passed=true;
} finally {
  for (const t of tenants) {
    if(t.sandbox_name) {
      const result=await provider.stop(t).catch(()=>({stopped:false}));
      if(result.stopped) await store.pool.query("UPDATE elastic_tenants SET state='sleeping' WHERE id=$1",[t.id]);
    }
  }
  fs.mkdirSync(path.join(c.dataDir,'memory'),{recursive:true});
  fs.writeFileSync(path.join(c.dataDir,'memory',`acceptance-${stamp}.json`),JSON.stringify(evidence,null,2),{mode:0o600});
  await store.pool.end();
}
