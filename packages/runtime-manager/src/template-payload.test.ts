import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTemplatePayload, templateRecord, TEMPLATE_OPENCLAW_VERSION } from "./template-payload.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("template payloads", () => {
  it("packages only the files a manifest lists, plus its CLI wheel", () => {
    const payload = resolveTemplatePayload(root, "xingqing");
    expect(payload.manifest.version).toBe("xingqing-starter.v1");
    expect(payload.files).toContain("memory/base/xingqing-knowledge-base.md");
    expect(payload.files).toContain("MEMORY.md");
    expect(payload.wheels.map((wheel) => path.basename(wheel))).toEqual(["xingqing_cli-0.5.6-py3-none-any.whl"]);
    expect(payload.commands).toEqual(["xingqing-cli"]);
  });

  it("keeps the fixed starter allowlist for manifests without a file list", () => {
    const payload = resolveTemplatePayload(root, "mirror-v");
    expect(payload.files).toEqual(["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "payload-manifest.json"]);
    expect(payload.wheels).toEqual([]);
  });

  it("rejects unknown or unsafe template ids", () => {
    expect(() => resolveTemplatePayload(root, "missing")).toThrow("UNKNOWN_TEMPLATE");
    expect(() => resolveTemplatePayload(root, "../dealclaw-agent")).toThrow("UNKNOWN_TEMPLATE");
  });

  it("ships no internal paths or workspace references in the 星擎 base memory", async () => {
    const fs = await import("node:fs");
    const payload = resolveTemplatePayload(root, "xingqing");
    for (const file of payload.files) {
      const text = fs.readFileSync(path.join(payload.dir, file), "utf8");
      expect(text).not.toMatch(/memory\/projects|scripts\/|work\/|\/api\/|feishu\.cn|Base `|\.xingqing-cred/);
    }
  });

  it("records expiry and runtime, starting new templates unlisted", () => {
    const builtAt = new Date("2026-09-28T00:00:00Z");
    const fresh = templateRecord(undefined, { version: "xingqing-starter.v1", snapshotId: "snap_1", builtAt, tools: { "xingqing-cli": "0.5.6" } });
    expect(fresh).toMatchObject({ listed: false, builtAt: "2026-09-28T00:00:00.000Z", expiresAt: "2026-10-28T00:00:00.000Z" });
    expect(fresh.runtime).toEqual({ openclaw: TEMPLATE_OPENCLAW_VERSION, "xingqing-cli": "0.5.6" });
    const avatarUrl = "https://example.com/agent-new-agent-portrait-0123456789ab.png";
    const rebuilt = templateRecord({ version: "mirror-v.v1", snapshotId: "old", name: "Mirror V", avatarUrl }, { version: "mirror-v.v2", snapshotId: "snap_2", builtAt });
    expect(rebuilt).toMatchObject({ name: "Mirror V", avatarUrl, listed: true, snapshotId: "snap_2" });
    expect(templateRecord({ version: "x", snapshotId: "old", listed: false }, { version: "x", snapshotId: "new", builtAt }).listed).toBe(false);
  });
});
