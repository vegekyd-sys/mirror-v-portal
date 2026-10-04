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

export function prepareInboundInput(request,config,{workspace='/vercel/sandbox/agent-data/workspace',agentId='dealclaw'}={}) {
  const images=request.images??[];
  if(!Array.isArray(images)||images.length>4)throw Error('INVALID_SANDBOX_IMAGES');
  if(!images.length)return {input:request.text,instructions:''};
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
  const caption=[request.text||'已收到用户图片。仅确认收到，等待用户说明要怎么处理；不要自行生成。',
    request.imagesFromPreviousTurn?'【同一会话此前提供的图片；用户说上一张/这张图片时使用这些实际源文件】':'【本条消息的用户图片】',
    ...read.map(({image},index)=>`图片${index+1}: ${image.path}`)].join('\n');
  const input=vision?[{type:'message',role:'user',content:[{type:'input_text',text:caption},...read.map(({image,buffer})=>({type:'input_image',source:{type:'base64',media_type:image.mimeType,data:buffer.toString('base64')}}))]}]:caption;
  // boot derives this entry from the tenant's pinned agent-kit profile. Read the
  // actual invocation config, rather than a global template pointer or env flag.
  const mediaPlugin=config?.plugins?.entries?.['makaron-tools'];
  const nativeFiles=config?.plugins?.enabled!==false&&mediaPlugin?.enabled!==false&&mediaPlugin?.config?.mode==='project'&&mediaPlugin.config.mediaContextMode==='native-files';
  const makaronInstructions=nativeFiles
    ? '只有用户要求创作或编辑时才执行。马卡龙媒体工具使用真实文件输入：用 source.path 明确指定用户选定的编辑基底文件，用 references 中每个条目的 path 和 role 明确指定额外参考文件及主体、背景或风格用途。使用消息中列出的实际沙箱路径，不能凭文件名猜内容、自动借用工程里的其他图片或用文字重画来替代用户源图；纯文字新创作省略 source 和 references。后续编辑显式使用此前返回的真实 artifact 路径或已确认 URL。若此前逻辑任务已结束，开始用户明确要求的新任务时先 makaron_project({action:"new_run"})；复用旧产物时不得重新生成。'
    : '要用马卡龙创作或编辑源图时，先 makaron_project({action:"import",path:"inbound/<文件名>",kind:"image"}) 导入这份真实文件，再 makaron_project({action:"status"}) 读取最新 canonical context.media，按 import 返回的 snapshotId 匹配 media_index。不要猜 index=1、不要用描述重画来替代源图；使用源图进行编辑时把实际 media_index 传给 makaron_generate_image。';
  const instructions=[
    '用户图片已保存为消息中列出的真实沙箱文件。只在用户说明要处理时开始创作，图片单独到达时先确认收到；不要把图片输入当作生成授权。',
    vision?'本次 input_image 与列出的本地源文件是同一份实际图片。':'当前主模型没有声明直接看图能力。源文件真实存在，可用已有图片工具读取；无法查看时如实说明，不能凭文件名猜测内容。',
    ...(agentId==='makaron'?[makaronInstructions]:[]),
  ].join('\n');
  return {input,instructions};
}
