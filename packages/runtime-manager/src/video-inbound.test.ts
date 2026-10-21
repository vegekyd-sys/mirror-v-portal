import {test,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {Readable} from 'node:stream';import {createHash} from 'node:crypto';
import {parseFeishuVideos,downloadFeishuVideo,persistFeishuVideo,videoMime} from './feishu-inbound.js';
import {normalizeInboundAttachments,readInboundImage,MAX_INBOUND_VIDEO_BYTES} from './inbound-media.js';
import {prepareInboundInput} from '../runtime/inbound-input.mjs';
import {FeishuEdge} from './feishu.js';import {VercelProvider} from './provider.js';
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(20)]),hash=createHash('sha256').update(mp4).digest('hex');
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
function folder(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'video-ingress-'));dirs.push(d);return d;}
function api(){return {im:{messageResource:{get:vi.fn(async()=>({getReadableStream:()=>Readable.from([mp4])}))}}} as any;}
test('native media, video-as-file and localized post media use the file_key, not cover image_key',()=>{
  const c={file_key:'video',image_key:'cover',file_name:'clip.mp4'};
  expect(parseFeishuVideos('media',c)).toEqual([{fileKey:'video'}]);expect(parseFeishuVideos('file',c)).toEqual([{fileKey:'video'}]);
  expect(parseFeishuVideos('file',{...c,file_name:'document.pdf'})).toEqual([]);
  expect(parseFeishuVideos('post',{zh_cn:{content:[[{tag:'media',...c},{tag:'media',...c}]]},en_us:{content:[[{tag:'media',file_key:'other-language'}]]}})).toEqual([{fileKey:'video'}]);
});
test('real file-resource bytes persist with video identity, privacy and repeat-safe hash',async()=>{
  const a=api(),bytes=await downloadFeishuVideo(a,'message','video');expect(a.im.messageResource.get).toHaveBeenCalledWith({path:{message_id:'message',file_key:'video'},params:{type:'file'}});
  const d=folder(),receipt=await persistFeishuVideo(d,'tenant','message',bytes);expect(receipt.kind).toBe('video');expect(receipt.mimeType).toBe('video/mp4');
  expect(receipt.sha256).toBe(hash);expect(readInboundImage(d,'tenant',receipt).buffer.equals(mp4)).toBe(true);expect(fs.statSync(path.join(d,receipt.storagePath)).mode&0o777).toBe(0o600);
  expect(await persistFeishuVideo(d,'tenant','message',bytes)).toEqual(receipt);expect(()=>normalizeInboundAttachments([receipt],'other')).toThrow('PATH_INVALID');
  expect(()=>normalizeInboundAttachments([{...receipt,bytes:MAX_INBOUND_VIDEO_BYTES+1}],'tenant')).toThrow();
  expect(()=>normalizeInboundAttachments([{...receipt,kind:'image'}],'tenant')).toThrow();
});
test('video bytes cannot be replaced by an image, text or an unbounded stream',async()=>{
  expect(videoMime(Buffer.from('not-video'))).toBeUndefined();const a=api();a.im.messageResource.get.mockResolvedValue({getReadableStream:()=>Readable.from([Buffer.from('not-video')])});await expect(downloadFeishuVideo(a,'m','k')).rejects.toThrow('FORMAT_UNSUPPORTED');
  a.im.messageResource.get.mockResolvedValue({getReadableStream:()=>Readable.from([mp4,Buffer.alloc(MAX_INBOUND_VIDEO_BYTES)])});await expect(downloadFeishuVideo(a,'m','k')).rejects.toThrow('TOO_LARGE');
  const stalled=new Readable({read(){}});a.im.messageResource.get.mockResolvedValue({getReadableStream:()=>stalled});await expect(downloadFeishuVideo(a,'m','k',5)).rejects.toThrow('TIMEOUT');expect(stalled.destroyed).toBe(true);
});
test('responses receive the same real file path and inherited-video context, with no base64 video payload',()=>{
  const workspace=folder();fs.mkdirSync(workspace+'/inbound');const filename=workspace+'/inbound/'+hash+'.mp4';fs.writeFileSync(filename,mp4);const video={kind:'video',path:filename,mimeType:'video/mp4',sha256:hash,bytes:mp4.length};
  const r=prepareInboundInput({text:'把这个片子超分',files:[video]},undefined,{workspace});expect(typeof r.input).toBe('string');expect(r.input).toContain(filename);expect(r.input).toContain('本条消息的用户视频');expect(r.input).toContain('MIME: video/mp4');expect(r.input).toContain('bytes: '+mp4.length);expect(r.input).toContain('SHA-256: '+hash);expect(r.input).not.toContain(mp4.toString('base64'));
  expect(prepareInboundInput({text:'用上个视频',files:[video],filesFromPreviousTurn:true},undefined,{workspace}).input).toContain('同一会话此前提供的视频');
  fs.writeFileSync(filename,Buffer.alloc(mp4.length));expect(()=>prepareInboundInput({files:[video]},undefined,{workspace})).toThrow('CHECKSUM_MISMATCH');
});
test('new tenants receive video by default, enqueue once, and failure clears inherited media',async()=>{
  const directory=folder(),runs=new Map<string,any>();const store:any={config:{dataDir:directory},pool:{query:async(_sql:string,args:any[])=>({rows:runs.has(args[1])?[runs.get(args[1])]:[]})},event:vi.fn(async()=>{}),enqueue:vi.fn(async(...args:any[])=>{const r={id:'run',delivery:'pending',attachments:args[6],inheritAttachments:args[7]?.inheritAttachments,text:args[3]};runs.set(args[1],r);return r;})};
  const edge=new FeishuEdge(store);vi.spyOn(edge.typing,'start').mockImplementation(()=>{});const a=api(),event={sender:{sender_type:'user'},message:{message_id:'video-message',chat_id:'chat',message_type:'media',content:JSON.stringify({file_key:'video',image_key:'cover'})}};
  const r=await edge.receive({id:'tenant'} as any,a,event);expect(r.attachments[0].kind).toBe('video');expect(r.text).toContain('只有用户视频');
  await edge.receive({id:'tenant'} as any,a,event);expect(a.im.messageResource.get).toHaveBeenCalledTimes(1);expect(store.enqueue).toHaveBeenCalledTimes(1);
  a.im.messageResource.get.mockRejectedValue(Error('private token'));const failed=await edge.receive({id:'tenant'} as any,a,{...event,message:{...event.message,message_id:'failed-video'}});expect(failed.attachments).toEqual([]);expect(failed.inheritAttachments).toBe(false);expect(JSON.stringify(store.event.mock.calls)).not.toContain('private token');
});
test('provider materializes video bytes then sends only metadata under files, including follow-up inheritance',async()=>{
  const directory=folder(),receipt=await persistFeishuVideo(directory,'tenant','m',mp4);let payload:any;const writes:any[]=[];
  const sandbox:any={writeFiles:async(f:any[])=>writes.push(...f),runCommand:async(o:any)=>{if(o.env?.NEXUS_REQUEST_B64){payload=JSON.parse(Buffer.from(o.env.NEXUS_REQUEST_B64,'base64').toString());o.stdout.write('data: {"type":"response.output_text.delta","delta":"video received"}\n\n');o.stdout.write('data: {"type":"response.completed","response":{"id":"test","status":"completed"}}\n\n');}return {exitCode:0};},readFileToBuffer:async({path:p}:any)=>p==='/tmp/nexus-state.tgz'?Buffer.from('backup'):null};
  const provider=new VercelProvider({dataDir:directory,encryptionKey:'0'.repeat(64)} as any);vi.spyOn(provider,'get').mockResolvedValue(sandbox);
  await provider.execute({id:'tenant',template_id:'makaron'} as any,'s','接着处理',async()=>{},{channel:'feishu',attachments:[receipt],attachmentsFromPreviousTurn:true});
  expect(writes[0].content.equals(mp4)).toBe(true);expect(payload.images).toBeUndefined();expect(payload.files[0].kind).toBe('video');expect(payload.filesFromPreviousTurn).toBe(true);expect(JSON.stringify(payload)).not.toContain(mp4.toString('base64'));
});
