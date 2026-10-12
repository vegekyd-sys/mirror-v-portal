// Turn V's voice entry (platform repo lab/, release gpt-live-dd5e4cdb) into an
// owner-neutral Mirror V voice entry. Every replacement must hit exactly the
// expected number of times, so a changed upstream fails here instead of shipping
// a half-patched page. Usage: node voice-mirror.mjs <dir containing lab/>
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "", "lab");
const edit = (file, pairs) => {
  const full = path.join(root, file);
  let text = fs.readFileSync(full, "utf8");
  for (const [from, to, count = 1] of pairs) {
    const hits = text.split(from).length - 1;
    if (hits !== count) throw Error(`${file}: expected ${count} x ${JSON.stringify(from.slice(0, 60))}, found ${hits}`);
    text = text.split(from).join(to);
  }
  fs.writeFileSync(full, text);
};
const agent = "(process.env.VOICE_AGENT_ID||'makaron')";

edit("realtime-direct-tools/session.mjs", [
  ["agentId:'makaron'", `agentId:${agent}`, 4],
  ["电话已接通。请用中文向天意简短打个招呼，然后听他说话。", "电话已接通。请用中文向主人简短打个招呼（主人的称呼以 USER.md 为准，不知道就不叫名字），然后听对方说话。"],
  ["你是 V，现在正在电话中和 Tianyi（天意）本人交流。默认个人服务是飞书，查日历是天意本人的飞书日程，不是微信。",
    "你是主人的 AI 伙伴（名字以工作区 IDENTITY.md 为准，没有就叫 V），现在正在电话中和主人本人交流。"],
]);
edit("realtime-direct-tools/backend.mjs", [
  ["agentId:'makaron'", `agentId:${agent}`, 3],
  ["天意本人在语音电话里交给 V 的任务。个人服务环境是飞书，时间使用 Asia/Shanghai。", "主人本人在语音电话里交给你的任务。时间使用 Asia/Shanghai。"],
]);
edit("realtime-direct-tools/tools.mjs", [
  ["搜索天意的 V/OpenClaw 个人记忆", "搜索主人的个人记忆"],
  ["export const TOOLS=[", "const ALL_TOOLS=["],
  ["\n];", "\n];\n// Mirror V has no Feishu calendar identity for its owner.\nexport const TOOLS=ALL_TOOLS.filter(t=>process.env.VOICE_DISABLE_FEISHU_CALENDAR!=='1'||t.name!=='feishu_calendar');"],
]);
edit("gpt-live-h5/persona.mjs", [
  ["Your long-term partnership is with Tianyi.", "Your long-term partnership is with your owner, the person who created you."],
  ["You are Tianyi's partner, not Tianyi's voice.", "You are your owner's partner, not your owner's voice."],
  ["Say that you are V and Tianyi's self-evolving AI partner across conversations, thinking, and work", "Say that you are your owner's self-evolving AI partner across conversations, thinking, and work (use the name in IDENTITY.md if one was given)"],
]);
edit("gpt-live-h5/personal-session.mjs", [
  ['export const GPT_LIVE_PERSONAL_SESSION_KEY = "agent:makaron:feishu:group:oc_adda79fa3d492cca82869c0c72bc62ae";',
    'export const GPT_LIVE_PERSONAL_SESSION_KEY = process.env.VOICE_SESSION_KEY || "agent:makaron:feishu:group:oc_adda79fa3d492cca82869c0c72bc62ae";'],
]);
edit("seeduplex-realtime-provider.mjs", [["天意，你好，我是 V，在呢。", "你好，我在呢。"]]);
edit("gpt-live-h5/server.mjs", [
  ['listen(port, "127.0.0.1"', 'listen(port, process.env.VOICE_LISTEN_HOST || "127.0.0.1"'],
  ['? "https://openclaw.tianyi.live" : ""', '&& process.env.VOICE_DISABLE_GPT_LIVE !== "1" ? "https://openclaw.tianyi.live" : ""'],
  ["models:[{id:'gpt-live',label:'GPT Live',available:true},...directVoice.models()]",
    "models:[...(process.env.VOICE_DISABLE_GPT_LIVE==='1'?[]:[{id:'gpt-live',label:'GPT Live',available:true}]),...directVoice.models()]"],
  ["if (params.model && !['gpt-live','seeduplex','grok'].includes(params.model))",
    "if (process.env.VOICE_DISABLE_GPT_LIVE==='1' && !['seeduplex','grok'].includes(params.model)) return json(res,400,{error:'这个语音模型尚未接入'});\n        if (params.model && !['gpt-live','seeduplex','grok'].includes(params.model))"],
]);
edit("gpt-live-h5/index.html", [
  ['<option value="gpt-live">GPT Live</option><option value="seeduplex" disabled>豆包 · 小何</option><option value="grok" disabled>Grok Voice</option>',
    '<option value="grok">Grok Voice</option><option value="seeduplex">豆包 · 小何</option>'],
]);
console.log(JSON.stringify({ patched: "mirror-voice", root }));
