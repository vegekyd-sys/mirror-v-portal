import type * as lark from '@larksuiteoapi/node-sdk';
import type { Store, Run } from './store.js';
/** Same native Typing reaction as V. Persist the ID for cleanup after restart. */
export class TypingReaction {
  private pending = new Map<string, Promise<void>>();
  constructor(readonly store: Store) {}
  start(run: Run, api: lark.Client) {
    if (!run.message_id || this.pending.has(run.id)) return;
    const task = this.add(run, api).catch(async () => {
      await this.store.event(run.tenant_id,'typing-error',{},run.id).catch(()=>{});
    });
    this.pending.set(run.id,task);
  }
  private async add(run: Run, api: lark.Client) {
    const prior=await this.store.pool.query("SELECT data FROM elastic_events WHERE run_id=$1 AND kind='typing-added' LIMIT 1",[run.id]);
    if(prior.rows.length) return;
    const result=await api.im.messageReaction.create({path:{message_id:run.message_id!},data:{reaction_type:{emoji_type:'Typing'}}});
    if(result.code!==0 || !result.data?.reaction_id) throw Error('TYPING_ADD_FAILED');
    await this.store.event(run.tenant_id,'typing-added',{reactionId:result.data.reaction_id,at:Date.now()},run.id);
  }
  async stop(run: Run, api: lark.Client) {
    await this.pending.get(run.id);
    try {
      const result=await this.store.pool.query("SELECT data FROM elastic_events WHERE run_id=$1 AND kind='typing-added' AND NOT EXISTS (SELECT 1 FROM elastic_events WHERE run_id=$1 AND kind='typing-removed') LIMIT 1",[run.id]);
      const id=result.rows[0]?.data?.reactionId;
      if(!id || !run.message_id) return;
      const removed=await api.im.messageReaction.delete({path:{message_id:run.message_id,reaction_id:id}});
      if(removed.code!==0) throw Error('TYPING_REMOVE_FAILED');
      await this.store.event(run.tenant_id,'typing-removed',{at:Date.now()},run.id);
    } finally { this.pending.delete(run.id); }
  }
}
