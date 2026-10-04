import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeInboundAttachments,readInboundImage,MAX_INBOUND_TOTAL_BYTES,InboundMediaError,type InboundAttachment} from './inbound-media.js';
import {prepareInboundInput,supportsInboundVision} from '../runtime/inbound-input.mjs';
import {createOpenClawConfig} from '../runtime/agent-config.mjs';
import {VercelProvider} from './provider.js';
import {RuntimeManager} from './manager.js';

// A real 1x1 PNG. The test compares actual bytes across persistence, sandbox and Responses.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhBkAAAAASUVORK5CYII=','base64');
const sha=createHash('sha256').update(png).digest('hex');
const attachment:InboundAttachment={kind:'image',mimeType:'image/png',storagePath:`inbound/tenant-a/${"b".repeat(64)}/${sha}.png`,sha256:sha,bytes:png.length,filename:'photo.png'};
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'inbound-image-'));const controller=path.join(root,'controller');const workspace=path.join(root,'workspace');fs.mkdirSync(path.dirname(path.join(controller,attachment.storagePath)),{recursive:true});fs.writeFileSync(path.join(controller,attachment.storagePath),png);fs.mkdirSync(path.join(workspace,'inbound'),{recursive:true});fs.writeFileSync(path.join(workspace,'inbound',sha+'.png'),png);return {root,controller,workspace,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};}
const config = {
  agents: {defaults: {model: {primary: 'nexus/anthropic/claude-sonnet-4.6'}}, list: [{id: 'makaron'}]},
  models: {providers: {nexus: {models: [{id: 'anthropic/claude-sonnet-4.6', input: ['text','image']}]}}},
};

describe('durable inbound user images',()=>{
  it('accepts credential-free receipts and rejects cross-tenant paths, encrypted credentials and oversized messages',()=>{
    expect(normalizeInboundAttachments([attachment],'tenant-a')).toEqual([attachment]);
    expect(()=>normalizeInboundAttachments([attachment],'tenant-b')).toThrow('INBOUND_ATTACHMENT_PATH_INVALID');
    expect(()=>normalizeInboundAttachments([{...attachment,storagePath:'inbound/tenant-a/../private/'+sha+'.png'}],'tenant-a')).toThrow();
    expect(()=>normalizeInboundAttachments([{...attachment,aesKey:'never-persist-me'}],'tenant-a')).toThrow('INVALID_INBOUND_ATTACHMENT');
    expect(()=>normalizeInboundAttachments([{...attachment,sha256:[sha]}],'tenant-a')).toThrow();
    expect(()=>normalizeInboundAttachments([{...attachment,bytes:MAX_INBOUND_TOTAL_BYTES}],'tenant-a')).toThrow();
    expect(()=>normalizeInboundAttachments([{...attachment,bytes:7*1024*1024},{...attachment,bytes:7*1024*1024}],'tenant-a')).toThrow('INBOUND_ATTACHMENTS_TOO_LARGE');
  });
  it('reads only the actual checked image and rejects modified bytes and ancestor symlinks',()=>{
    const f=fixture();try {
      const read=readInboundImage(f.controller,'tenant-a',attachment);expect(read.buffer.equals(png)).toBe(true);expect(read.image.path).toBe(`/vercel/sandbox/agent-data/workspace/inbound/${sha}.png`);
      fs.writeFileSync(path.join(f.controller,attachment.storagePath),Buffer.alloc(png.length));expect(()=>readInboundImage(f.controller,'tenant-a',attachment)).toThrow('INBOUND_ATTACHMENT_CHECKSUM_MISMATCH');
      const directory=path.join(f.controller,'inbound/tenant-a/'+ 'b'.repeat(64));fs.rmSync(directory,{recursive:true});fs.symlinkSync(f.workspace,directory);expect(()=>readInboundImage(f.controller,'tenant-a',attachment)).toThrow('INBOUND_ATTACHMENT_SYMLINK_FORBIDDEN');
    }finally{f.cleanup();}
  });
  it('sends the actual PNG through OpenClaw7.1 source.base64 plus the same tool/import file path',()=>{
    const f=fixture();try {
      const image={path:path.join(f.workspace,'inbound',sha+'.png'),mimeType:'image/png',sha256:sha,bytes:png.length};
      const prepared=prepareInboundInput({text:'这张图改成贴纸',images:[image]},config,{workspace:f.workspace,agentId:'makaron'});
      const content=prepared.input[0].content;expect(content[0].text).toContain(image.path);expect(content[1]).toEqual({type:'input_image',source:{type:'base64',media_type:'image/png',data:png.toString('base64')}});
      expect(prepared.instructions).toContain('snapshotId');expect(prepared.instructions).toContain('不要猜 index=1');expect(prepared.instructions).not.toContain('data:image/');
      const receipt=prepareInboundInput({text:'',images:[image]},config,{workspace:f.workspace,agentId:'makaron'});expect(receipt.input[0].content[0].text).toContain('不要自行生成');
      const followup=prepareInboundInput({text:'用上一张照片',images:[image],imagesFromPreviousTurn:true},config,{workspace:f.workspace,agentId:'makaron'});expect(followup.input[0].content[0].text).toContain('同一会话此前提供的图片');
    }finally{f.cleanup();}
  });
  it('uses the pinned native plugin config for image+text without injecting the indexed tool contract',()=>{
    const f=fixture();try {
      const nativeConfig=createOpenClawConfig({runtime:{agentId:'makaron',payloadLayout:'agent-kit-v1',modelInput:['text','image'],plugins:[{
        id:'makaron-tools',path:'plugins/makaron-tools',config:{mode:'project',mediaContextMode:'native-files'},
      }]},workspace:f.workspace,payloadRoot:path.join(f.root,'payload'),schedulerPath:path.join(f.root,'scheduler'),modelId:'anthropic/claude-sonnet-4.6'});
      const image={path:path.join(f.workspace,'inbound',sha+'.png'),mimeType:'image/png',sha256:sha,bytes:png.length};
      const prepared=prepareInboundInput({text:'保留这个孩子，将衣服改红，用另一张图的风格',images:[image]},nativeConfig,{workspace:f.workspace,agentId:'makaron'});
      const content=prepared.input[0].content;
      expect(content[0].text).toContain('保留这个孩子，将衣服改红，用另一张图的风格');expect(content[0].text).toContain(image.path);
      expect(content[1].source).toEqual({type:'base64',media_type:'image/png',data:png.toString('base64')});
      expect(prepared.instructions).toContain('source.path');expect(prepared.instructions).toContain('references');expect(prepared.instructions).toContain('path 和 role');
      expect(prepared.instructions).toContain('new_run');expect(prepared.instructions).toContain('不得重新生成');
      expect(prepared.instructions).not.toMatch(/context\.media|media_index|snapshotId|index=|<<<|action:"import"|Media\s*(?:List|Index)/i);
      const imageOnly=prepareInboundInput({text:'',images:[image]},nativeConfig,{workspace:f.workspace,agentId:'makaron'});
      expect(imageOnly.input[0].content[0].text).toContain('不要自行生成');expect(imageOnly.instructions).toContain('只有用户要求创作或编辑时才执行');
      const followup=prepareInboundInput({text:'用上一张照片',images:[image],imagesFromPreviousTurn:true},nativeConfig,{workspace:f.workspace,agentId:'makaron'});
      expect(followup.input[0].content[0].text).toContain('同一会话此前提供的图片');expect(followup.instructions).not.toContain('media_index');
      expect(prepareInboundInput({text:'hello'},nativeConfig,{workspace:f.workspace,agentId:'makaron'})).toEqual({input:'hello',instructions:''});
    }finally{f.cleanup();}
  });
  it('keeps indexed instructions for legacy/disabled/non-project plugins and omits Makaron instructions for other agents',()=>{
    const f=fixture();try {
      const image={path:path.join(f.workspace,'inbound',sha+'.png'),mimeType:'image/png',sha256:sha,bytes:png.length};
      for(const entry of [undefined,{enabled:true,config:{mode:'project',mediaContextMode:'indexed'}},{enabled:false,config:{mode:'project',mediaContextMode:'native-files'}},{enabled:true,config:{mode:'media',mediaContextMode:'native-files'}}]){
        const actual={...config,plugins:{entries:{'makaron-tools':entry}}};
        const prepared=prepareInboundInput({text:'编辑这张图片',images:[image]},actual,{workspace:f.workspace,agentId:'makaron'});
        expect(prepared.instructions).toContain('canonical context.media');expect(prepared.instructions).toContain('media_index');expect(prepared.instructions).not.toContain('source.path');
      }
      const native={...config,plugins:{entries:{'makaron-tools':{enabled:true,config:{mode:'project',mediaContextMode:'native-files'}}}}};
      const disabled=prepareInboundInput({text:'看这张图',images:[image]},{...native,plugins:{...native.plugins,enabled:false}},{workspace:f.workspace,agentId:'makaron'});
      expect(disabled.instructions).toContain('media_index');expect(disabled.instructions).not.toContain('source.path');
      const other=prepareInboundInput({text:'看这张图',images:[image]},native,{workspace:f.workspace,agentId:'mirror-v'});
      expect(other.instructions).not.toContain('makaron_project');expect(other.instructions).not.toContain('source.path');
    }finally{f.cleanup();}
  });
  it('preserves pure text exactly and gives real local paths without unsupported images to text-only providers',()=>{
    const f=fixture();try {
      expect(prepareInboundInput({text:'hello'},undefined)).toEqual({input:'hello',instructions:''});
      const textOnly=structuredClone(config);textOnly.models.providers.nexus.models[0].input=['text'];expect(supportsInboundVision(textOnly,'makaron')).toBe(false);
      const image={path:path.join(f.workspace,'inbound',sha+'.png'),mimeType:'image/png',sha256:sha,bytes:png.length};
      const prepared=prepareInboundInput({text:'photo',images:[image]},textOnly,{workspace:f.workspace,agentId:'mirror-v'});expect(typeof prepared.input).toBe('string');expect(prepared.input).toContain(image.path);expect(prepared.instructions).toContain('没有声明直接看图');
      fs.unlinkSync(image.path);fs.symlinkSync(path.join(f.controller,attachment.storagePath),image.path);expect(()=>prepareInboundInput({text:'photo',images:[image]},config,{workspace:f.workspace,agentId:'makaron'})).toThrow('SANDBOX_IMAGE_SYMLINK_FORBIDDEN');
    }finally{f.cleanup();}
  });
  it('materializes bytes before dispatch and keeps all image bytes out of invocation env/events',async()=>{
    const f=fixture();let payload:any;const files:any[]=[];const events:any[]=[];
    const sandbox={writeFiles:async(items:any[])=>{files.push(...items);},runCommand:async(options:any)=>{if(options.env?.NEXUS_REQUEST_B64){payload=JSON.parse(Buffer.from(options.env.NEXUS_REQUEST_B64,'base64').toString());options.stdout.write('data: {"type":"response.output_text.delta","delta":"received"}\n\n');options.stdout.write('data: {"type":"response.completed","response":{"id":"free-test","status":"completed"}}\n\n');}return {exitCode:0};},readFileToBuffer:async({path:p}:any)=>p==='/tmp/nexus-state.tgz'?Buffer.from('test-backup'):null};
    try {
      const p=new VercelProvider({dataDir:f.controller,encryptionKey:'0'.repeat(64)} as any);vi.spyOn(p,'get').mockResolvedValue(sandbox as any);
      await p.execute({id:'tenant-a',template_id:'makaron'} as any,'session','photo',async(kind,data)=>{events.push({kind,data});},{channel:'weixin',attachments:[attachment]});
      expect(files).toHaveLength(1);expect(files[0].content.equals(png)).toBe(true);expect(payload.images[0]).toEqual(readInboundImage(f.controller,'tenant-a',attachment).image);
      expect(payload.caps).toBeUndefined(); // inbound image support does not claim outbound WeChat upload
      expect(JSON.stringify(payload)).not.toContain(png.toString('base64'));expect(JSON.stringify(events)).not.toContain(png.toString('base64'));expect(events[0].kind).toBe('inbound-materialized');
      fs.unlinkSync(path.join(f.controller,attachment.storagePath));await expect(p.execute({id:'tenant-a'} as any,'session','photo',async()=>{}, {attachments:[attachment]})).rejects.toBeInstanceOf(InboundMediaError);
    }finally{f.cleanup();}
  });
  it('forwards latest same-conversation image context and keeps pre-request media errors recoverable',async()=>{
    const run:any={id:'r',tenant_id:'tenant-a',session_key:'chat-a',channel:'weixin',text:'用上一张图片',status:'queued',created_at:new Date(),attachments:[]};const tenant:any={id:'tenant-a',state:'sleeping'};const queries:any[]=[];let context:any;
    const db={query:async(sql:string,args?:any[])=>{queries.push({sql,args});return {rows:[],rowCount:0};}};
    const store:any={run:async()=>run,tenant:async()=>tenant,locked:async(_id:string,fn:any)=>fn(db),event:async()=>{},tenantSecretEnv:async()=>({}),previousAttachments:vi.fn(async()=>[attachment])};
    const provider:any={ensure:async()=>({name:'test',wakeMs:1,reused:false}),execute:async(_t:any,_s:any,_x:any,_e:any,c:any)=>{context=c;throw new InboundMediaError('INBOUND_ATTACHMENT_CHECKSUM_MISMATCH');}};
    const manager=new RuntimeManager(store,provider);await manager.process(run.id);
    expect(store.previousAttachments).toHaveBeenCalledWith(run);expect(context).toEqual({channel:'weixin',attachments:[attachment],attachmentsFromPreviousTurn:true});
    expect(queries.find(x=>x.sql.includes('status=$2')).args[1]).toBe('failed');expect(queries.find(x=>x.sql.includes('last_error=$3')).args[1]).toBe('ready');
    run.inherit_attachments=false;store.previousAttachments.mockClear();await manager.process(run.id);expect(store.previousAttachments).not.toHaveBeenCalled();expect(context.attachments).toEqual([]);
  });
});
