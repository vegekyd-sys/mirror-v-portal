import {expect,test,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {VercelProvider} from './provider.js';

test.each(['图片已做好。','','No response from OpenClaw.'])('delivers actual sandbox bytes when OpenResponses stripped MEDIA: caption=%s',async(caption)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-media-sse-'));
 const ref='/vercel/sandbox/agent-data/workspace/artifacts/final.png';
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==','base64');
 const frames=[
  {type:'response.created',response:{id:'resp-current'}},
  {type:'response.output_text.delta',delta:caption},
  {type:'nexus.media',runId:'resp-other',phase:'final',mediaUrls:['/tmp/wrong.png']},
  {type:'nexus.media',runId:'resp-current',phase:'final',mediaUrls:[ref,ref]},
  {type:'response.completed',response:{id:'resp-current',status:'completed'}},
 ];
 const reads:string[]=[];const events:any[]=[];
 const sbx={name:'current',status:'running',update:async()=>{},writeFiles:async()=>{},
  runCommand:async(opts:any)=>{if(opts.args?.[0]?.endsWith('/invoke.mjs'))opts.stdout.write(frames.map(f=>`data: ${JSON.stringify(f)}\n\n`).join(''));return {exitCode:0};},
  readFileToBuffer:async({path:p}:any)=>{reads.push(p);return p===ref?image:p==='/tmp/nexus-state.tgz'?Buffer.from('saved-state'):null;},
 };
 const provider=new VercelProvider({dataDir:dir,encryptionKey:'0'.repeat(64),optimizeRuntime:false} as any);
 vi.spyOn(provider as any,'get').mockResolvedValue(sbx);
 try {
  const result=await provider.execute({id:'current',template_id:'makaron'} as any,'session','create image',async(kind,data)=>{events.push({kind,data});},{channel:'feishu'});
  expect(result.output).toBe(caption === 'No response from OpenClaw.' ? '' : caption);
  expect(result.media).toEqual([{ref,kind:'image',buffer:image}]);
  expect(reads.filter(p=>p===ref)).toHaveLength(1);
  expect(reads).not.toContain('/tmp/wrong.png');
  expect(events.some(e=>e.kind==='media-ready'&&e.data.count===1)).toBe(true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('response.completed with failed status cannot turn a failed response into successful delivery',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-media-failure-'));
 const sbx={update:async()=>{},writeFiles:async()=>{},runCommand:async(opts:any)=>{
  opts.stdout.write('data: {"type":"response.created","response":{"id":"resp-current"}}\n\n');
  opts.stdout.write('data: {"type":"response.completed","response":{"id":"resp-current","status":"failed"}}\n\n');
  return {exitCode:0};
 }};
 const provider=new VercelProvider({dataDir:dir,encryptionKey:'0'.repeat(64),optimizeRuntime:false} as any);
 vi.spyOn(provider as any,'get').mockResolvedValue(sbx);
 try {await expect(provider.execute({id:'current'} as any,'session','request',async()=>{})).rejects.toThrow('OPENCLAW_RESPONSE_FAILED');}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('unavailable announced media saves state and rejects delivery without invoking the agent again',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-media-unavailable-'));
 let invocations=0;
 const events:string[]=[];
 const sbx={update:async()=>{},writeFiles:async()=>{},runCommand:async(opts:any)=>{
  if(opts.args?.[0]?.endsWith('/invoke.mjs')) {
   invocations++;
   for(const frame of [
    {type:'response.created',response:{id:'resp-current'}},
    {type:'nexus.media',runId:'resp-current',phase:'final',mediaUrls:['/tmp/missing.png']},
    {type:'response.completed',response:{id:'resp-current',status:'completed'}},
   ]) opts.stdout.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  return {exitCode:0};
 },readFileToBuffer:async({path:p}:any)=>p==='/tmp/nexus-state.tgz'?Buffer.from('saved-state'):null};
 const provider=new VercelProvider({dataDir:dir,encryptionKey:'0'.repeat(64),optimizeRuntime:false} as any);
 vi.spyOn(provider as any,'get').mockResolvedValue(sbx);
 try {
  await expect(provider.execute({id:'current'} as any,'session','send image',async(kind)=>{events.push(kind);})).rejects.toThrow('OUTBOUND_MEDIA_UNAVAILABLE');
  expect(invocations).toBe(1);
  expect(fs.readFileSync(path.join(dir,'backups/current.tgz')).toString()).toBe('saved-state');
  expect(events).toContain('state-saved');
  expect(events).toContain('media-missing');
 } finally{fs.rmSync(dir,{recursive:true,force:true});}
});
