// Loopback-only model instrumentation. Never log prompts, tokens, or reasoning.
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
const upstream = process.env.NEXUS_MODEL_BASE_URL.replace(/\/$/, "");
const log = "/tmp/nexus-model-timings.jsonl";
const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.end("ok");
    return;
  }
  const start = Date.now();
  const timing = {
    start,
    model: process.env.NEXUS_MODEL_ID,
    firstContentMs: null,
    firstReasoningMs: null,
    completedMs: null,
    status: 0,
  };
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    body.model = process.env.NEXUS_MODEL_ID;
    if (upstream.includes("api.deepseek.com")) {
      body.thinking = { type: "disabled" };
      delete body.reasoning_effort;
    }
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const response = await fetch(
      upstream.replace(/\/v1$/, "") + "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + process.env.NEXUS_MODEL_KEY,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(600000),
        ]),
      },
    );
    timing.status = response.status;
    res.writeHead(response.status, {
      "content-type":
        response.headers.get("content-type") || "text/event-stream",
    });
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    for await (const chunk of response.body) {
      buffer += decoder.write(Buffer.from(chunk));
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const e = JSON.parse(line.slice(5));
          const d = e.choices?.[0]?.delta;
          if (d?.content && timing.firstContentMs === null)
            timing.firstContentMs = Date.now() - start;
          if (d?.reasoning_content && timing.firstReasoningMs === null)
            timing.firstReasoningMs = Date.now() - start;
        } catch {}
      }
      if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
    }
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  } finally {
    timing.completedMs = Date.now() - start;
    fs.appendFileSync(log, JSON.stringify(timing) + "\n", { mode: 0o600 });
  }
});
server.listen(18791, "127.0.0.1");
