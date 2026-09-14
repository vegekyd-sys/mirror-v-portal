const request = JSON.parse(
  Buffer.from(process.env.NEXUS_REQUEST_B64, "base64").toString(),
);
const response = await fetch("http://127.0.0.1:18790/v1/responses", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.NEXUS_GATEWAY_TOKEN}`,
    "x-openclaw-agent-id": "dealclaw",
    "x-openclaw-session-key": request.sessionKey,
  },
  body: JSON.stringify({
    model: "openclaw/dealclaw",
    input: request.text,
    instructions: "对于需要调用工具或多步骤处理的任务，在开始前和关键步骤之间用简短中文向用户说明正在做什么；这些是公开的执行进展，不要输出内部推理。完成后给出结果。",
    user: request.sessionKey,
    stream: true,
  }),
  signal: AbortSignal.timeout(600000),
});
if (!response.ok || !response.body) {
  console.error(`Runtime HTTP ${response.status}`);
  process.exit(1);
}
for await (const chunk of response.body) process.stdout.write(chunk);
