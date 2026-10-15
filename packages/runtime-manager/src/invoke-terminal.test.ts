import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";

const invoke = fileURLToPath(new URL("../runtime/invoke.mjs", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const bounded = <T>(promise: Promise<T>, ms = 2500): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("INVOKE_DID_NOT_TERMINATE")), ms); }),
  ]).finally(() => clearTimeout(timer));
};

// Run the actual invocation script against a real HTTP server. Only the
// hardcoded local gateway URL is redirected to an ephemeral loopback port.
// There is no mocked SSE parser, model, sandbox, credentials, or live request.
async function startInvoke(respond: (response: ServerResponse) => void) {
  const sockets = new Set<Socket>();
  let httpClosed!: () => void;
  const closed = new Promise<void>(resolve => { httpClosed = resolve; });
  let arrived!: () => void;
  const requestArrived = new Promise<void>(resolve => { arrived = resolve; });
  let bodyReceived!: (body: any) => void;
  const requestBody = new Promise<any>(resolve => { bodyReceived = resolve; });
  const server: Server = createServer((request, response) => {
    const body: Buffer[] = [];
    request.on("data", chunk => body.push(chunk));
    request.on("end", () => bodyReceived(JSON.parse(Buffer.concat(body).toString())));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    response.on("close", httpClosed);
    respond(response);
    arrived();
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("FIXTURE_SERVER_ADDRESS_MISSING");
  const directory = mkdtempSync(path.join(tmpdir(), "nexus-invoke-terminal-"));
  const preload = path.join(directory, "redirect-fetch.mjs");
  writeFileSync(preload, [
    "const originalFetch = globalThis.fetch;",
    "globalThis.fetch = (url, options) => {",
    "  if (url !== 'http://127.0.0.1:18790/v1/responses') throw Error('UNEXPECTED_FIXTURE_REQUEST');",
    `  return originalFetch(${JSON.stringify(`http://127.0.0.1:${address.port}/v1/responses`)}, options);`,
    "};",
  ].join("\n"));
  const child: ChildProcess = spawn(process.execPath, ["--import", preload, invoke], {
    env: {
      NEXUS_REQUEST_B64: Buffer.from(JSON.stringify({ text: "本地终态流验证", sessionKey: "isolated-terminal-fixture", caps: "media,images,files" })).toString("base64"),
      NEXUS_GATEWAY_TOKEN: "fixture-nonsecret",
      NEXUS_AGENT_ID: "makaron",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout!.on("data", chunk => stdout.push(chunk));
  child.stderr!.on("data", chunk => stderr.push(chunk));
  let exited = false;
  const exit = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => { exited = true; resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }); });
  });
  cleanups.push(async () => {
    if (!exited) child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { exit, closed, requestArrived, requestBody, hasExited: () => exited };
}

const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

describe("actual invoke terminal SSE handling", () => {
  it("sends user input without platform instructions or an install-capability prompt", async () => {
    const run = await startInvoke(response => response.write(sse({ type: "response.completed", response: { status: "completed" } })));
    const body = await bounded(run.requestBody);
    expect(body).not.toHaveProperty("instructions");
    expect(body.input).toBe("本地终态流验证");
    expect(JSON.stringify(body)).not.toMatch(/npm install|MEDIA:|nexus_schedule|Portal 运行环境/);
    expect((await bounded(run.exit)).code).toBe(0);
  });

  it("forwards a chunk-split multiline failure then cancels HTTP that never ends", async () => {
    const event = { type: "response.failed", response: { status: "failed", error: { code: "billing_error", message: "fixture failure" } } };
    const frame = `event: response.failed\r\n${JSON.stringify(event, null, 2).split("\n").map(line => `data: ${line}`).join("\r\n")}\r\n\r\n`;
    const run = await startInvoke(response => {
      response.write(frame.slice(0, 37));
      setTimeout(() => response.write(frame.slice(37)), 30);
      // Deliberately omit response.end(): the production failure did this.
    });
    const result = await bounded(run.exit);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(frame.slice(0, -4) + "\n\n");
    await bounded(run.closed);
  });

  it("forwards successful completion and stops without waiting for HTTP EOF", async () => {
    const frame = sse({ type: "response.completed", response: { id: "fixture-success", status: "completed" } });
    const run = await startInvoke(response => response.write(frame));
    const result = await bounded(run.exit);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(frame);
    await bounded(run.closed);
  });

  it.each([
    { type: "error", error: { code: "api_error" } },
    { type: "response.completed", response: { status: "failed" } },
    { type: "response.completed", response: { status: "incomplete" } },
  ])("keeps explicit unsuccessful terminal events unsuccessful: $type", async event => {
    const frame = sse(event);
    const run = await startInvoke(response => response.write(frame));
    const result = await bounded(run.exit);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(frame);
    await bounded(run.closed);
  });

  it("does not stop on nonterminal frames, error-like text, or malformed JSON", async () => {
    let response!: ServerResponse;
    const progress = [
      sse({ type: "response.output_item.done", item: { status: "completed" } }),
      sse({ type: "response.output_text.delta", delta: 'Words containing response.failed and {"type":"error"} are ordinary text.' }),
      "data: {invalid JSON}\n\n",
    ].join("");
    const run = await startInvoke(value => { response = value; response.write(progress); });
    await bounded(run.requestArrived);
    await delay(150);
    expect(run.hasExited()).toBe(false);
    const final = sse({ type: "response.completed", response: { status: "completed" } });
    response.write(final);
    const result = await bounded(run.exit);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(progress + final);
    await bounded(run.closed);
  });

  it("leaves an unexpected network disconnect as failure without a synthetic terminal success", async () => {
    const progress = sse({ type: "response.output_text.delta", delta: "still working" });
    const run = await startInvoke(response => {
      response.write(progress);
      setTimeout(() => response.destroy(), 30);
    });
    const result = await bounded(run.exit);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe(progress);
    expect(result.stdout).not.toContain("response.completed");
  });
});
