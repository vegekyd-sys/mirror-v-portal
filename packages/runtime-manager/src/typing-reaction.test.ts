import {test,expect,vi} from 'vitest';
import {TypingReaction} from './typing-reaction.js';
test('typing start is deduplicated and completion waits for add before removing',async()=>{
 let reaction: any;
 let release!:()=>void;
 const pending=new Promise<void>(r=>{release=r;});
 const events:string[]=[];
 const store:any={pool:{query:async()=>({rows:reaction?[{data:{reactionId:reaction}}]:[]})},event:async(_t:string,k:string,d:any)=>{events.push(k);if(k==='typing-added') reaction=d.reactionId;}};
 const api:any={im:{messageReaction:{create:vi.fn(async()=>{await pending;return {code:0,data:{reaction_id:'r1'}};}),delete:vi.fn(async()=>({code:0}))}}};
 const typing=new TypingReaction(store),run:any={id:'run',tenant_id:'tenant',message_id:'message'};
 typing.start(run,api);typing.start(run,api);
 const stopped=typing.stop(run,api);
 release();await stopped;
 expect(api.im.messageReaction.create).toHaveBeenCalledTimes(1);
 expect(api.im.messageReaction.delete).toHaveBeenCalledWith({path:{message_id:'message',reaction_id:'r1'}});
 expect(events).toEqual(['typing-added','typing-removed']);
});
