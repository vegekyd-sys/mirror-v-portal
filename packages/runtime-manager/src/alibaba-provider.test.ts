import { expect, test, vi } from "vitest";
import { Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import { AlibabaSandbox, alibabaOptions, shellQuote } from "./alibaba-provider.js";

test("shell arguments cannot expand quotes, substitutions or newlines", () => {
  const input = "a'\n$(printf injected)`printf bad`;hello";
  expect(execFileSync("sh", ["-c", `printf %s ${shellQuote(input)}`], { encoding: "utf8" })).toBe(input);
});
test("explicit Alibaba endpoints and missing credentials fail closed", () => {
  expect(() => alibabaOptions({} as any)).toThrow("ALIBABA_SANDBOX_KEY_REQUIRED");
  expect(alibabaOptions({ alibaba: { apiKey: "test", region: "ap-southeast-1" } } as any).apiUrl)
    .toBe("https://api.ap-southeast-1.e2b.fc.aliyuncs.com");
});
test("pause must be confirmed, and never falls back to destructive kill", async () => {
  const raw = { pause: vi.fn(async () => true), getInfo: vi.fn(async () => ({ state: "running" })), kill: vi.fn() };
  await expect(new AlibabaSandbox(raw as any).stop()).rejects.toThrow("ALIBABA_PAUSE_NOT_CONFIRMED");
  expect(raw.kill).not.toHaveBeenCalled();
  raw.getInfo.mockResolvedValue({ state: "paused" });
  expect(await new AlibabaSandbox(raw as any).stop()).toEqual({ status: "stopped" });
});
test("remote command forwards incremental output before completion and drains async consumers", async () => {
  const observed: string[] = [];
  const sink = new Writable({ write(chunk, _, done) { setTimeout(() => { observed.push(chunk.toString()); done(); }, 5); } });
  const raw = { commands: { run: vi.fn(async (_command, opts) => ({
    kill: vi.fn(), wait: async () => {
      await opts.onStdout("first"); expect(observed).toEqual(["first"]);
      await opts.onStdout("last"); return { exitCode: 0, stdout: "firstlast", stderr: "" };
    },
  })) } };
  const result = await new AlibabaSandbox(raw as any).runCommand({ cmd: "node", args: ["invoke.mjs"], stdout: sink });
  expect(result.exitCode).toBe(0); expect(observed).toEqual(["first", "last"]);
  sink.end();
});
