import fs from "node:fs";
import { randomUUID } from "node:crypto";
const rpc = "/tmp/nexus-schedule-rpc";
fs.mkdirSync(rpc, { recursive: true });
const nonce = randomUUID();
fs.writeFileSync(rpc + "/current.json", JSON.stringify({ nonce }));
const sent = new Set();
const timer = setInterval(() => {
  for (const name of fs.readdirSync(rpc)) {
    if (!name.endsWith(".request") || sent.has(name)) continue;
    try {
      const req = JSON.parse(fs.readFileSync(rpc + "/" + name, "utf8"));
      if (req.nonce !== nonce) continue;
      sent.add(name);
      process.stdout.write(
        "data: " +
          JSON.stringify({
            type: "nexus.schedule.request",
            id: req.id,
            args: req.args,
          }) +
          "\n\n",
      );
    } catch {}
  }
}, 250);
try {
  const request = JSON.parse(
    Buffer.from(process.env.NEXUS_REQUEST_B64, "base64").toString(),
  );
  const response = await fetch("http://127.0.0.1:18790/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.NEXUS_GATEWAY_TOKEN}`,
      "x-openclaw-agent-id": process.env.NEXUS_AGENT_ID || "dealclaw",
      "x-openclaw-session-key": request.sessionKey,
      // Tell the runtime which surface this turn came from. Absent it, every
      // turn looks like webchat and the agent describes itself accordingly.
      ...(request.channel ? { "x-openclaw-message-channel": request.channel } : {}),
      // Comma-separated; absent means the agent assumes text only.
      ...(request.caps ? { "x-openclaw-client-caps": request.caps } : {}),
    },
    body: JSON.stringify({
      model: `openclaw/${process.env.NEXUS_AGENT_ID || "dealclaw"}`,
      input: request.text,
      instructions: [
        "定时任务和心跳必须用 nexus_schedule 工具登记到 Nexus，不能改 OpenClaw 配置或本地 cron。对于需要调用工具或多步骤处理的任务，在开始前和关键步骤之间用简短中文向用户说明正在做什么；这些是公开的执行进展，不要输出内部推理。完成后给出结果。",
        // Knowing the channel accepts files is not the same as knowing how to
        // hand one over: the agent announced it was sending an image and then
        // emitted no directive at all. State the mechanism explicitly.
        request.caps?.includes("media") || request.caps?.includes("images")
          ? [
              "【附件投递 — 本运行环境的唯一方式】",
              "你运行在 Nexus 托管的沙箱里：这里没有配置任何 OpenClaw 消息通道，也没有 lark-cli、makaron-card-runner 或其他发送工具。`openclaw message send`、`lark-cli` 一律不可用，不要尝试、不要为此排查环境，也不要请用户去绑定它们。",
              "消息由沙箱之外的 Nexus 网关代你收发。要发送图片或文件，唯一的方式是：把 `MEDIA: <文件绝对路径>` 作为回复正文中单独的一行输出（前后不要加反引号或代码块）。",
              "例：",
              "这是刚生成的海报：",
              "MEDIA: /vercel/sandbox/agent-data/workspace/poster.jpg",
              "Nexus 会读取该文件并作为真正的附件发给用户。只描述图片而不输出这一行，用户什么都收不到。输出前先确认文件确实存在于沙箱文件系统中。",
            ].join("\n")
          : "本渠道只能发送纯文本，不支持图片或文件附件。不要声称已发送附件；需要交付文件时，改为给出可访问的链接。",
      ].join("\n\n"),
      user: request.sessionKey,
      stream: true,
    }),
    signal: AbortSignal.timeout(600000),
  });
  if (!response.ok || !response.body) {
    console.error(`Runtime HTTP ${response.status}`);
    process.exit(1);
  }
  // Preserve frame boundaries when multiplexing schedule RPC with model SSE.
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop() || "";
    for (const frame of frames) process.stdout.write(frame + "\n\n");
  }
  if (pending.trim()) process.stdout.write(pending + "\n\n");
} finally {
  clearInterval(timer);
  for (const name of sent) {
    try {
      fs.unlinkSync(rpc + "/" + name);
    } catch {}
  }
}
