import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { imageMime, mediaCommand, prepareFeishuMedia, safeMediaFilename, uploadKey } from "./feishu-media.js";

let directory: string, video: Buffer, audio: Buffer, png: Buffer;
beforeAll(async() => {
  directory=await fs.mkdtemp(path.join(os.tmpdir(),"feishu-format-test-"));
  await mediaCommand("ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=navy:s=64x48:r=10","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","0.6","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",path.join(directory,"clip.mp4")]);
  await mediaCommand("ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=550:sample_rate=48000","-t","0.6",path.join(directory,"music.wav")]);
  await mediaCommand("ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=red:s=64x48","-frames:v","1",path.join(directory,"image.png")]);
  [video,audio,png]=await Promise.all(["clip.mp4","music.wav","image.png"].map(file=>fs.readFile(path.join(directory,file))));
});
afterAll(async()=>{if(directory)await fs.rm(directory,{recursive:true,force:true});});

test("real MP4 is preserved and delivered with a decoded JPEG cover and millisecond duration",async()=>{
  const result=await prepareFeishuMedia({kind:"video",ref:"/workspace/采访.mp4",buffer:video});
  expect(result.msgType).toBe("media");expect(result.fileType).toBe("mp4");expect(result.duration).toBe(600);
  expect(result.buffer.equals(video)).toBe(true);expect(imageMime(result.cover!)).toBe("image/jpeg");
  await fs.writeFile(path.join(directory,"cover.jpg"),result.cover!);
  await mediaCommand("ffmpeg",["-hide_banner","-loglevel","error","-i",path.join(directory,"cover.jpg"),"-f","null","-"]);
  await mediaCommand("ffmpeg",["-hide_banner","-loglevel","error","-i",path.join(directory,"clip.mp4"),"-f","null","-"]);
});
test("real WAV becomes decodable OGG Opus and an audio message, retaining its full duration",async()=>{
  const result=await prepareFeishuMedia({kind:"audio",ref:"/workspace/音乐.wav",buffer:audio});
  expect(result.msgType).toBe("audio");expect(result.fileType).toBe("opus");expect(result.duration).toBe(600);
  expect(result.buffer.toString("ascii",0,4)).toBe("OggS");expect(result.filename).toBe("音乐.ogg");
  const filename=path.join(directory,"converted.ogg");await fs.writeFile(filename,result.buffer);
  const info=JSON.parse(await mediaCommand("ffprobe",["-v","error","-show_entries","stream=codec_name,sample_rate,channels:format=duration","-of","json",filename]));
  expect(info.streams[0].codec_name).toBe("opus");expect(info.streams[0].sample_rate).toBe("48000");expect(Number(info.format.duration)).toBeGreaterThanOrEqual(0.6);
  await mediaCommand("ffmpeg",["-hide_banner","-loglevel","error","-i",filename,"-f","null","-"]);
  const again=await prepareFeishuMedia({kind:"audio",ref:"music.ogg",buffer:result.buffer});
  expect(again.buffer.equals(result.buffer)).toBe(true);
});
test("real PNG uses native image; an SVG remains an honest file attachment",async()=>{
  expect((await prepareFeishuMedia({kind:"image",ref:"image.png",buffer:png})).msgType).toBe("image");
  const svg=await prepareFeishuMedia({kind:"image",ref:"design.svg",buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')});
  expect(svg.msgType).toBe("file");expect(svg.fileType).toBe("stream");
});
test("corrupt video fails closed with a fixed diagnostic and no stderr",async()=>{
  await expect(prepareFeishuMedia({kind:"video",ref:"private.mp4?token=secret",buffer:Buffer.from("broken")})).rejects.toThrow("FEISHU_MEDIA_DECODE_FAILED");
});
test("an untrusted playlist cannot make the media worker fetch a network URL or local controller file",async()=>{
  const playlist=Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://127.0.0.1/private.ts\n#EXT-X-ENDLIST\n');
  await expect(prepareFeishuMedia({kind:"video",ref:"fake.mp4",buffer:playlist})).rejects.toThrow("FEISHU_MEDIA_DECODE_FAILED");
});
test("SDK top-level and nested keys are supported; API errors and absent keys are rejected",()=>{
  expect(uploadKey({image_key:"top"},"image_key")).toBe("top");
  expect(uploadKey({code:0,data:{file_key:"nested"}},"file_key")).toBe("nested");
  expect(()=>uploadKey({code:999,msg:"secret",data:{file_key:"bad"}},"file_key")).toThrow("FEISHU_UPLOAD_999");
  expect(()=>uploadKey({code:0,data:{}},"image_key")).toThrow("FEISHU_UPLOAD_KEY_MISSING");
  expect(safeMediaFilename('https://example.com/%E5%9B%BE.png?secret=abc')).not.toContain("secret");
  expect(safeMediaFilename('中文"\r\n.png')).toBe("中文___.png");
});
