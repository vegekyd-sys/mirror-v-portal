import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureSandboxExecApprovals, sandboxExecEnv } from "../runtime/sandbox-exec.mjs";

describe("tenant sandbox execution", () => {
  it("gives npm a writable persistent prefix and puts installed binaries before inherited tools", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-npm-env-"));
    try {
      const env = sandboxExecEnv(root, process.env.PATH);
      expect(fs.statSync(path.join(root, "npm/bin")).isDirectory()).toBe(true);
      expect(env.PATH.split(path.delimiter)[0]).toBe(path.join(root, "npm/bin"));
      expect(env.NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS).toBe("true");
      expect(env.NPM_CONFIG_IGNORE_SCRIPTS).toBe("false");
      expect(execFileSync("npm", ["config", "get", "prefix"], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" }).trim()).toBe(path.join(root, "npm"));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the owning approvals CLI for JSON and SQLite stores while preserving socket and allowlist state", () => {
    const prior = { version: 1, socket: { path: "/socket", token: "fixture" }, defaults: { security: "deny", ask: "always" }, agents: { a: { security: "deny", ask: "always", allowlist: [{ pattern: "/old" }] } } };
    const calls: string[][] = [];
    let stored: any;
    const run = (_cmd: string, args: string[], options: any) => {
      calls.push(args);
      expect(options.env.OPENCLAW_STATE_DIR).toBe("/tenant/state");
      if (args.includes("get")) return JSON.stringify({ path: "/state/openclaw.sqlite#exec_approvals_config", file: prior });
      const filename = args[args.indexOf("--file") + 1];
      expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
      stored = JSON.parse(fs.readFileSync(filename, "utf8"));
      return "{}";
    };
    expect(ensureSandboxExecApprovals("/runtime/openclaw.mjs", { OPENCLAW_STATE_DIR: "/tenant/state" }, run)).toBe(true);
    expect(calls.map(args => args[2])).toEqual(["get", "set"]);
    expect(stored.socket).toEqual(prior.socket);
    expect(stored.defaults).toEqual({ security: "full", ask: "off", askFallback: "full" });
    expect(stored.agents.a).toEqual({ security: "full", ask: "off", askFallback: "full", allowlist: [{ pattern: "/old" }] });
    expect(fs.existsSync(calls[1][calls[1].indexOf("--file") + 1])).toBe(false);
    expect(ensureSandboxExecApprovals("/runtime/openclaw.mjs", {}, () => JSON.stringify({ file: stored }))).toBe(false);
  });

});
