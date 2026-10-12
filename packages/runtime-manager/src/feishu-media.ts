import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { MediaFile } from "./provider.js";
import type { ImageMime } from "./inbound-media.js";

export const MAX_FEISHU_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_FEISHU_IMAGE_BYTES = 10 * 1024 * 1024;
// Reject playlists/concat descriptors: model-created files cannot make FFmpeg fetch URLs or arbitrary files.
const MEDIA_INPUT_OPTIONS = ["-protocol_whitelist","file,pipe","-format_whitelist","mov,ogg,mp3,wav,flac,aac,matroska,avi,amr,aiff"];
export interface PreparedFeishuMedia {
  buffer: Buffer;
  filename: string;
  msgType: "image" | "media" | "audio" | "file";
  fileType?: "mp4" | "opus" | "stream";
  duration?: number;
  cover?: Buffer;
}

export function imageMime(buffer: Buffer): ImageMime | undefined {
  if (buffer.length >= 3 && buffer.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0,6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.toString("ascii",0,4) === "RIFF" && buffer.toString("ascii",8,12) === "WEBP") return "image/webp";
}
function nativeImage(buffer: Buffer) {
  return !!imageMime(buffer) || (buffer.length >= 4 && (buffer.toString("ascii",0,2) === "BM" ||
    buffer.subarray(0,4).equals(Buffer.from([73,73,42,0])) || buffer.subarray(0,4).equals(Buffer.from([77,77,0,42]))));
}
export function safeMediaFilename(ref: string) {
  let value = ref;
  try { value = new URL(ref).pathname; } catch {}
  return (path.posix.basename(value.replace(/\\/g,"/")) || "file").replace(/[\p{Cc}"\\]/gu,"_").slice(0,180);
}
export function uploadKey(response: any, key: "image_key" | "file_key") {
  if (response?.code !== undefined && response.code !== 0) throw Error(`FEISHU_UPLOAD_${Number(response.code) || "FAILED"}`);
  const value = response?.[key] ?? response?.data?.[key];
  if (typeof value !== "string" || !value || value.length > 1024) throw Error("FEISHU_UPLOAD_KEY_MISSING");
  return value;
}
/** Errors contain a fixed diagnostic code, never stderr, URLs, or SDK response bodies. */
export async function mediaCommand(binary: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve,reject) => {
    const child = spawn(binary,args,{stdio:["ignore","pipe","pipe"],env:{PATH:process.env.PATH,LANG:"C"}});
    let stdout = "", stderrBytes = 0, complete = false;
    const finish = (error?: Error) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(stdout);
    };
    const timer = setTimeout(() => {child.kill("SIGKILL"); finish(Error("FEISHU_MEDIA_PREPARE_TIMEOUT"));},timeoutMs);
    child.stdout.on("data",chunk => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 1024 * 1024) {child.kill("SIGKILL"); finish(Error("FEISHU_MEDIA_PROBE_TOO_LARGE"));}
    });
    child.stderr.on("data",chunk => {stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) {child.kill("SIGKILL"); finish(Error("FEISHU_MEDIA_DIAGNOSTIC_TOO_LARGE"));}});
    child.on("error",() => finish(Error("FEISHU_MEDIA_BINARY_UNAVAILABLE")));
    child.on("close",code => finish(code === 0 ? undefined : Error("FEISHU_MEDIA_DECODE_FAILED")));
  });
}
interface Probe {format?: {duration?: string;format_name?: string}; streams?: {codec_type?: string;codec_name?: string}[]}
async function probe(filename: string) {
  let result: Probe;
  try {result = JSON.parse(await mediaCommand(process.env.NEXUS_FFPROBE_PATH || "ffprobe",["-v","error",...MEDIA_INPUT_OPTIONS,"-show_entries","format=duration,format_name:stream=codec_type,codec_name","-of","json",filename],10_000));}
  catch (error) {if (error instanceof SyntaxError) throw Error("FEISHU_MEDIA_PROBE_INVALID"); throw error;}
  const seconds = Number(result.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isSafeInteger(Math.round(seconds * 1000))) throw Error("FEISHU_MEDIA_DURATION_INVALID");
  return {...result,duration:Math.round(seconds * 1000)};
}
function assertSize(buffer: Buffer, image = false) {
  if (!buffer.length || buffer.length > (image ? MAX_FEISHU_IMAGE_BYTES : MAX_FEISHU_FILE_BYTES)) throw Error("FEISHU_MEDIA_TOO_LARGE");
}
async function readPreparedFile(filename: string) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || !stat.size || stat.size > MAX_FEISHU_FILE_BYTES) throw Error("FEISHU_MEDIA_TOO_LARGE");
  return fs.readFile(filename);
}
/** Native image/video/audio preparation. No network calls; original bytes remain in the durable vault. */
export async function prepareFeishuMedia(file: MediaFile): Promise<PreparedFeishuMedia> {
  assertSize(file.buffer);
  const filename = safeMediaFilename(file.ref);
  if (file.kind === "image" && nativeImage(file.buffer)) {
    assertSize(file.buffer,true);
    return {buffer:file.buffer,filename,msgType:"image"};
  }
  // SVG and unknown image formats are real file attachments, never mislabeled as native images.
  if (file.kind === "file" || file.kind === "image") return {buffer:file.buffer,filename,msgType:"file",fileType:"stream"};
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"nexus-feishu-media-"));
  await fs.chmod(directory,0o700);
  try {
    const input = path.join(directory,"source");
    await fs.writeFile(input,file.buffer,{mode:0o600,flag:"wx"});
    const source = await probe(input);
    const ffmpeg = process.env.NEXUS_FFMPEG_PATH || "ffmpeg";
    if (file.kind === "audio") {
      if (!source.streams?.some(stream => stream.codec_type === "audio")) throw Error("FEISHU_AUDIO_STREAM_MISSING");
      let buffer = file.buffer;
      if (!(source.format?.format_name === "ogg" && source.streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "opus"))) {
        const output = path.join(directory,"audio.ogg");
        await mediaCommand(ffmpeg,["-hide_banner","-loglevel","error","-y",...MEDIA_INPUT_OPTIONS,"-i",input,"-vn","-sn","-dn","-ar","48000","-ac","2","-c:a","libopus","-b:a","128k","-fs",String(MAX_FEISHU_FILE_BYTES+1),"-f","ogg",output]);
        const converted = await probe(output);
        if (!converted.streams?.some(stream => stream.codec_name === "opus")) throw Error("FEISHU_AUDIO_CONVERSION_INVALID");
        if (converted.duration + 150 < source.duration) throw Error("FEISHU_MEDIA_TRUNCATION_REJECTED");
        buffer = await readPreparedFile(output);
      }
      assertSize(buffer);
      return {buffer,filename:`${path.parse(filename).name || "audio"}.ogg`,msgType:"audio",fileType:"opus",duration:source.duration};
    }
    const video = source.streams?.find(stream => stream.codec_type === "video");
    if (!video) throw Error("FEISHU_VIDEO_STREAM_MISSING");
    let playable = input, buffer = file.buffer;
    const audio = source.streams?.find(stream => stream.codec_type === "audio");
    if (!source.format?.format_name?.includes("mp4") || video.codec_name !== "h264" || (audio && audio.codec_name !== "aac")) {
      playable = path.join(directory,"video.mp4");
      await mediaCommand(ffmpeg,["-hide_banner","-loglevel","error","-y",...MEDIA_INPUT_OPTIONS,"-i",input,"-map","0:v:0","-map","0:a?","-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-c:a","aac","-fs",String(MAX_FEISHU_FILE_BYTES+1),"-movflags","+faststart",playable]);
      const converted = await probe(playable);
      if (converted.duration + 150 < source.duration) throw Error("FEISHU_MEDIA_TRUNCATION_REJECTED");
      buffer = await readPreparedFile(playable);
    }
    assertSize(buffer);
    const coverPath = path.join(directory,"cover.jpg");
    await mediaCommand(ffmpeg,["-hide_banner","-loglevel","error","-y",...MEDIA_INPUT_OPTIONS,"-i",playable,"-frames:v","1","-vf","scale=min(640\\,iw):-2","-q:v","3",coverPath]);
    const cover = await fs.readFile(coverPath);
    assertSize(cover,true);
    if (imageMime(cover) !== "image/jpeg") throw Error("FEISHU_VIDEO_COVER_INVALID");
    return {buffer,filename:`${path.parse(filename).name || "video"}.mp4`,msgType:"media",fileType:"mp4",duration:source.duration,cover};
  } finally {await fs.rm(directory,{recursive:true,force:true});}
}
