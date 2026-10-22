// OpenClaw 7.1 OpenResponses uses input_image.source, not image_url.
// Bytes come from the same actual sandbox file exposed to native tools/import.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const mimes={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'};
const maxBytes=10*1024*1024,totalBytes=12*1024*1024;

export function supportsInboundVision(config,agentId) {
  const agent=config?.agents?.list?.find(item=>item.id===agentId);
  const model=agent?.model??config?.agents?.defaults?.model;
  const primary=typeof model==='string'?model:model?.primary;
  if(typeof primary!=='string')return false;
  const separator=primary.indexOf('/');if(separator<0)return false;
  const provider=primary.slice(0,separator),modelId=primary.slice(separator+1);
  return !!config.models?.providers?.[provider]?.models?.find(item=>item.id===modelId)?.input?.includes('image');
}

function prepareImageInput(request,config,{workspace='/vercel/sandbox/agent-data/workspace',agentId='dealclaw'}={}) {
  const images=request.images??[];
  if(!Array.isArray(images)||images.length>4)throw Error('INVALID_SANDBOX_IMAGES');
  if(!images.length)return {input:request.text};
  const lexicalRoot=path.resolve(workspace),root=fs.realpathSync(workspace);let sum=0;
  const read=images.map(image=>{
    if(!image||typeof image.path!=='string'||typeof image.sha256!=='string'||!Object.hasOwn(mimes,image.mimeType)||!/^[a-f0-9]{64}$/.test(image.sha256)||!Number.isSafeInteger(image.bytes)||image.bytes<=0||image.bytes>maxBytes)throw Error('INVALID_SANDBOX_IMAGE');
    const filename=path.resolve(image.path),basename=`${image.sha256}.${mimes[image.mimeType]}`;
    const expected=path.join(root,'inbound',basename),lexicalExpected=path.join(lexicalRoot,'inbound',basename);
    // macOS /var may alias /private/var. Keep the configured workspace boundary
    // lexical, then verify the actual file resolves within that same workspace.
    if(filename!==lexicalExpected&&filename!==expected)throw Error('SANDBOX_IMAGE_PATH_INVALID');
    if(fs.lstatSync(path.join(root,'inbound')).isSymbolicLink()||fs.lstatSync(filename).isSymbolicLink())throw Error('SANDBOX_IMAGE_SYMLINK_FORBIDDEN');
    if(fs.realpathSync(filename)!==expected)throw Error('SANDBOX_IMAGE_PATH_INVALID');
    const stat=fs.statSync(filename);if(!stat.isFile()||stat.size!==image.bytes)throw Error('SANDBOX_IMAGE_SIZE_MISMATCH');
    const buffer=fs.readFileSync(filename);if(createHash('sha256').update(buffer).digest('hex')!==image.sha256)throw Error('SANDBOX_IMAGE_CHECKSUM_MISMATCH');
    sum+=buffer.length;if(sum>totalBytes)throw Error('SANDBOX_IMAGES_TOO_LARGE');
    return {image,buffer};
  });
  const vision=supportsInboundVision(config,agentId);
  const caption=[request.text||'',
    request.imagesFromPreviousTurn?'【同一会话此前提供的图片】':'【本条消息的用户图片】',
    `图片输入：${vision?'原图及本地文件':'本地文件（当前模型声明的输入类型为文本）'}`,
    ...read.map(({image},index)=>`图片${index+1}: ${image.path}`)].join('\n');
  const input=vision?[{type:'message',role:'user',content:[{type:'input_text',text:caption},...read.map(({image,buffer})=>({type:'input_image',source:{type:'base64',media_type:image.mimeType,data:buffer.toString('base64')}}))]}]:caption;
  return {input};
}


// Videos remain files. Do not put their bytes (or a thumbnail) into input_image.
export function prepareInboundInput(request,config,options={}) {
  const files=request.files??[];
  if(!Array.isArray(files)||files.length+(request.images?.length||0)>4)throw Error('INVALID_SANDBOX_FILES');
  if(!files.length)return prepareImageInput(request,config,options);
  const workspace=options.workspace||'/vercel/sandbox/agent-data/workspace';
  const lexicalRoot=path.resolve(workspace),root=fs.realpathSync(workspace),extensions={'video/mp4':'mp4','video/quicktime':'mov','video/webm':'webm'};
  let total=0;
  for(const file of files){
    if(!file||file.kind!=='video'||typeof file.path!=='string'||!Object.hasOwn(extensions,file.mimeType)||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<=0||file.bytes>64*1024*1024)throw Error('INVALID_SANDBOX_FILE');
    const filename=path.resolve(file.path),name=file.sha256+'.'+extensions[file.mimeType],expected=path.join(root,'inbound',name);
    if(filename!==expected&&filename!==path.join(lexicalRoot,'inbound',name))throw Error('SANDBOX_FILE_PATH_INVALID');
    if(fs.lstatSync(path.join(root,'inbound')).isSymbolicLink()||fs.lstatSync(filename).isSymbolicLink())throw Error('SANDBOX_FILE_SYMLINK_FORBIDDEN');
    if(fs.realpathSync(filename)!==expected)throw Error('SANDBOX_FILE_PATH_INVALID');
    const stat=fs.statSync(filename);if(!stat.isFile()||stat.size!==file.bytes)throw Error('SANDBOX_FILE_SIZE_MISMATCH');
    const bytes=fs.readFileSync(filename);if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('SANDBOX_FILE_CHECKSUM_MISMATCH');
    total+=file.bytes;if(total>64*1024*1024)throw Error('SANDBOX_FILES_TOO_LARGE');
  }
  const caption=[request.text||'',request.filesFromPreviousTurn?'【同一会话此前提供的视频】':'【本条消息的用户视频】','视频输入：真实本地文件',...files.map((file,index)=>`视频${index+1}: ${file.path} (MIME: ${file.mimeType}; bytes: ${file.bytes}; SHA-256: ${file.sha256})`)].join('\n');
  return prepareImageInput({...request,text:caption},config,options);
}

/**
 * While a payload's onboarding is unfinished, put a short platform note in front
 * of every owner turn: where onboarding stands, and the guide's instructions for
 * that very step, quoted. A workspace file in the system prompt alone was not
 * enough — on 2026-10-22 the model answered the first turn with a generic hello,
 * and after naming itself deleted BOOTSTRAP.md (OpenClaw's own convention for
 * that file), which ended onboarding for good.
 *
 * So the guide lives at onboarding/GUIDE.md, and only the progress file decides
 * when onboarding is over (step "done"). On the first step the opening is lifted
 * verbatim from the guide's first fenced block and the step is advanced here, so
 * the opening is never sent twice even if the model forgets to record progress.
 * Scheduled and other background turns are left alone.
 */
export function onboardingPreamble(text,{workspace='/vercel/sandbox/agent-data/workspace',sessionKey=''}={}) {
  if(/:scheduled:/.test(sessionKey))return text;
  const guidePath=path.join(workspace,'onboarding','GUIDE.md'),script=path.join(workspace,'scripts','onboard-progress.py');
  if(!fs.existsSync(guidePath)||!fs.existsSync(script))return text;
  const progressFile=path.join(workspace,'onboarding','progress.json');
  let progress={step:'start'};
  try{progress={...progress,...JSON.parse(fs.readFileSync(progressFile,'utf8'))};}catch{}
  if(progress.step==='done')return text;
  const guide=fs.readFileSync(guidePath,'utf8');
  const head='【平台提示：上手引导进行中。这段是系统给你的，不是主人说的，不要复述，也不要提到它】';
  if(progress.step==='start'){
    const opening=/```\n([\s\S]*?)\n```/.exec(guide)?.[1]?.trim();
    if(opening){
      try{
        fs.mkdirSync(path.dirname(progressFile),{recursive:true});
        fs.writeFileSync(progressFile,JSON.stringify({...progress,step:'choose',updated_at:new Date().toISOString()},null,1));
      }catch{}
      return [head,
        '这是你和主人的第一轮。如果下面主人的消息是在派活，先把活干完；然后在同一条回复里原样发出下面这段开场白，一字不改，不加任何前后缀。主人的消息只是平台的扫码通知、或者只是打招呼时，就只发这段开场白，不调用任何工具。',
        '———— 开场白 ————',opening,'———— 开场白结束 ————','','主人的消息：',text].join('\n');
    }
  }
  return [head,
    `当前步骤：${progress.step}。已选来源：${(progress.chosen??[]).join(' ')||'无'}；已完成：${(progress.done??[]).join(' ')||'无'}；已跳过：${(progress.skipped??[]).join(' ')||'无'}。`,
    '这一步的做法（摘自引导，照做）：','————',guideSection(guide,progress.step),'————',
    '主人在派活就先干完，再在同一条回复的最后接回这一步。做完这一步用 python3 scripts/onboard-progress.py set 写回进度。引导文件不要删除，起完名字也不代表引导结束。',
    '回复的最后一句必须是下一步要主人做的那一件事（编号选项、链接，或者「回我『好了』」）。不要问「你想让我做什么」，不要提文件名、脚本名、IDENTITY 这类内部名字，不用 markdown 粗体和标题。',
    '','主人的消息：',text].join('\n');
}

/** The guide section whose heading lists this step, e.g. "## 第 2 步 · 飞书文档（step = feishu → feishu_auth …）". */
export function guideSection(guide,step){
  const parts=guide.split(/\n(?=## )/);
  const steps=part=>(/step\s*=\s*([^）)\n]*)/.exec(part.split('\n')[0])?.[1]??'').split(/[^a-z_]+/).filter(Boolean);
  const hit=parts.find(part=>steps(part).includes(step))
    ??parts.find(part=>steps(part).some(name=>step.startsWith(name+'_')));
  return (hit??'（引导里没有这一步，按当前进度判断最合理的下一步，并用 onboard-progress.py 改正进度。）').replace(/\n---\s*$/,'').trim().slice(0,6000);
}
