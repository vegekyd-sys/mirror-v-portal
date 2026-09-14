import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.js';import {Store} from '../src/store.js';import {VercelProvider} from '../src/provider.js';
const c=loadConfig(),s=new Store(c),p=new VercelProvider(c);
await s.init();
try {
 const id=process.env.NEXUS_RECOVER_RUN_ID;if(!id)throw Error('RUN_ID_REQUIRED');
 await s.locked((await s.run(id)).tenant_id,async db=>{
 const r=await s.run(id),t=await s.tenant(r.tenant_id,db);
 assert.equal(r.status,'uncertain');assert.equal(r.error,'RECOVERY_REVIEW_REQUIRED');
 const submitted=await db.query("SELECT 1 FROM elastic_events WHERE run_id=$1 AND kind IN ('waking','dispatch','delta','tool-progress','runtime-completed')",[id]);
 assert.equal(submitted.rowCount,0,'only never-submitted messages may be retried');
 console.log('LIFECYCLE',(await db.query("SELECT kind,created_at FROM elastic_events WHERE tenant_id=$1 AND run_id IS NULL ORDER BY seq DESC LIMIT 4",[t.id])).rows);
 const stopped=await p.stop(t);assert.equal(stopped.stopped,true);
 await db.query('BEGIN');
 try{
 await db.query("UPDATE elastic_tenants SET state='sleeping',last_error=NULL,snapshot_id=coalesce($2,snapshot_id) WHERE id=$1",[t.id,stopped.snapshotId || null]);
 await db.query("UPDATE elastic_runs SET status='queued',error=NULL,completed_at=NULL WHERE id=$1",[id]);
 await s.boss.send('agent-turn',{runId:id},{db:{executeSql:(sql,values)=>db.query(sql,values)},group:{id:t.id}});
 await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}
 await s.event(t.id,'unsubmitted-message-recovered',{},id);
 console.log('RECOVERED',id);
 });
}finally{await s.close();}
