import fs from "node:fs";
import { prepareInboundInput, onboardingPreamble } from "./inbound-input.mjs";
import { randomUUID } from "node:crypto";
const rpc = "/tmp/nexus-schedule-rpc";
fs.mkdirSync(rpc, { recursive: true });
const nonce = randomUUID();
fs.writeFileSync(rpc + "/current.json", JSON.stringify({ nonce }));
const sent = new Set();
function terminalFrame(frame) {
  const raw = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart()).join("\n");
  try {
    const event = JSON.parse(raw);
    if (event.type === "response.failed" || event.type === "error") return "failed";
    if (event.type === "response.completed")
      return event.response?.status === "completed" ? "completed" : "failed";
  } catch {}
  return undefined;
}
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
  let inbound;
  try {
    const config = request.images?.length ? JSON.parse(fs.readFileSync("/vercel/sandbox/agent-data/openclaw.json", "utf8")) : undefined;
    try { request.text = onboardingPreamble(request.text ?? "", { sessionKey: request.sessionKey ?? "" }); } catch {}
    inbound = prepareInboundInput(request,config,{agentId:process.env.NEXUS_AGENT_ID || "dealclaw"});
  } catch (error) {
    const code = /^(?:INVALID_SANDBOX|SANDBOX_IMAGE|SANDBOX_FILE)[A-Z_]*$/.test(error?.message || "") ? error.message : "INBOUND_MEDIA_INPUT_REJECTED";
    process.stdout.write("data: " + JSON.stringify({type:"nexus.input_rejected",code}) + "\n\n");
    throw Error("INBOUND_MEDIA_INPUT_REJECTED");
  }
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
      input: inbound.input,
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
  responseFrames: for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop() || "";
    for (const frame of frames) {
      // Forward the actual terminal event before cancelling its body. The
      // gateway may report failure without closing HTTP; waiting for EOF then
      // hides that failure until the sandbox command times out.
      process.stdout.write(frame + "\n\n");
      const terminal = terminalFrame(frame);
      if (terminal) {
        pending = "";
        if (terminal === "failed") process.exitCode = 1;
        // ReadableStream's async iterator cancels the body on early return.
        // This ends only the already-terminal invocation, without a retry.
        break responseFrames;
      }
    }
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
