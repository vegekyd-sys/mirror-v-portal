import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePortalEnvironment } from "../runtime/portal-environment.mjs";
import { createPortalRuntimePlugin } from "../runtime/scheduler-plugin.mjs";

const config = { tools: { exec: { host: "gateway", security: "full", ask: "off", pathPrepend: ["/tenant/npm/bin"] } } };
function fixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "portal-environment-"));
  const workspace = path.join(data, "workspace");
  fs.mkdirSync(workspace);
  return { data, workspace, cleanup: () => fs.rmSync(data, { recursive: true, force: true }) };
}

describe("Portal environment facts", () => {
  it("updates one managed factual section while preserving owner notes and real permission configuration", () => {
    const f = fixture();
    try {
      const file = path.join(f.workspace, "TOOLS.md");
      const owner = "# Tools\n\n用户自定义：Nexus 项目的历史笔记不能改。\n";
      fs.writeFileSync(file, owner);
      const before = JSON.stringify(config);
      const facts = writePortalEnvironment({ ...f, config });
      const text = fs.readFileSync(file, "utf8");
      expect(text.startsWith(owner)).toBe(true);
      expect(text.slice(text.indexOf("<!-- portal-environment:start -->"))).not.toMatch(/必须|禁止|不能|不要|只用|一律/);
      expect(facts.platform).toBe("Portal");
      expect(facts.execution.security).toBe("full");
      expect(JSON.stringify(config)).toBe(before);
      writePortalEnvironment({ ...f, config });
      expect(fs.readFileSync(file, "utf8")).toBe(text);
      const changed = { tools: { exec: { host: "gateway", security: "deny", ask: "always" } } };
      expect(writePortalEnvironment({ ...f, config: changed }).execution.security).toBe("deny");
      expect(fs.readFileSync(file, "utf8").match(/<!-- portal-environment:start -->/g)).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  it("removes only exact old platform restrictions and preserves custom documents and symlinks", () => {
    const f = fixture();
    try {
      const file = path.join(f.workspace, "TOOLS.md");
      fs.writeFileSync(file, "# Tools\n个人规则：不要覆盖我的实验。\n- 消息由沙箱外的网关代收代发（飞书、微信等）。这里没有 lark-cli、没有飞书机器人凭据，`openclaw message send` 不可用，不要尝试。\n");
      writePortalEnvironment({ ...f, config });
      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain("个人规则：不要覆盖我的实验。");
      expect(text).not.toContain("不要尝试");
      fs.unlinkSync(file);
      const custom = path.join(f.data, "custom.md");
      fs.writeFileSync(custom, "owner document");
      fs.symlinkSync(custom, file);
      writePortalEnvironment({ ...f, config });
      expect(fs.readFileSync(custom, "utf8")).toBe("owner document");
    } finally { f.cleanup(); }
  });

  it("exposes Portal tools and keeps the existing schedule RPC acknowledgement protocol working", async () => {
    const f = fixture();
    const tools = new Map<string, any>();
    const options = new Map<string, any>();
    let watcher: ReturnType<typeof setInterval> | undefined;
    try {
      writePortalEnvironment({ ...f, config });
      const root = path.join(f.data, "rpc");
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "current.json"), JSON.stringify({ nonce: "fixture-nonce" }));
      createPortalRuntimePlugin({ root, environmentFile: path.join(f.data, "portal-environment.json") }).register({
        registerTool: (tool: any, opts: any) => { tools.set(tool.name, tool); options.set(tool.name, opts); },
      });
      expect(options.get("nexus_schedule")).toEqual({ optional: true });
      expect((await tools.get("portal_environment").execute()).details.platform).toBe("Portal");
      expect(tools.get("portal_schedule").description).not.toMatch(/Nexus|必须|不能|不要/);
      let received: any;
      watcher = setInterval(() => {
        const name = fs.readdirSync(root).find(name => name.endsWith(".request"));
        if (!name) return;
        received = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
        fs.renameSync(path.join(root, name), path.join(root, name + ".handled"));
        fs.writeFileSync(path.join(root, received.id + ".response"), JSON.stringify({ durable: true, id: "schedule-proof" }));
      }, 10);
      const args = { action: "add", kind: "heartbeat", schedule: { kind: "every", everySeconds: 60 } };
      const result = await tools.get("portal_schedule").execute("call", args);
      expect(received).toMatchObject({ nonce: "fixture-nonce", args });
      expect(result.details).toEqual({ durable: true, id: "schedule-proof" });
    } finally { if (watcher) clearInterval(watcher); f.cleanup(); }
  });
});
