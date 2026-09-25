import { describe, expect, it } from "vitest";
import { availableTemplates, requireTemplate } from "./templates.js";
import type { Config } from "./config.js";

const config = {
  snapshotId: "snap_dealclaw",
  templates: { "mirror-v": { version: "mirror-v.v1", snapshotId: "snap_mirror" } },
} as Config;

describe("signup template catalog", () => {
  it("only offers configured snapshots and hides their ids", () => {
    expect(availableTemplates(config).map((template) => template.id)).toEqual(["dealclaw", "mirror-v"]);
    expect(requireTemplate(config, "mirror-v", "mirror-v.v1").snapshotId).toBe("snap_mirror");
    expect(availableTemplates({ ...config, templates: {} }).map((template) => template.id)).toEqual(["dealclaw"]);
  });

  it("rejects unknown and stale template versions", () => {
    expect(() => requireTemplate(config, "unknown")).toThrow("TEMPLATE_NOT_AVAILABLE");
    expect(() => requireTemplate(config, "mirror-v", "mirror-v.v0")).toThrow("TEMPLATE_NOT_AVAILABLE");
  });

  it("uses a dedicated DealClaw snapshot for new tenants without changing the legacy one", () => {
    const dedicated = { ...config, templates: { ...config.templates, dealclaw: { version: "dealclaw-starter.v1", snapshotId: "snap_new_dealclaw" } } };
    expect(requireTemplate(dedicated, "dealclaw")).toMatchObject({ version: "dealclaw-starter.v1", snapshotId: "snap_new_dealclaw" });
    expect(dedicated.snapshotId).toBe("snap_dealclaw");
  });
});
