import { describe, expect, it } from "vitest";
import { availableTemplates, requireTemplate, templateSecretNames, validateTenantSecrets } from "./templates.js";
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

  it("lists newly configured agents with their display metadata", () => {
    const expanded = { ...config, templates: { ...config.templates, xinqing: { version: "xinqing.v1", snapshotId: "snap_xinqing", name: "新晴", description: "陪伴与交流" } } };
    expect(availableTemplates(expanded).find((template) => template.id === "xinqing")).toMatchObject({ name: "新晴", description: "陪伴与交流" });
  });

  it("keeps unlisted templates selectable by id but marks them hidden", () => {
    const hidden = { ...config, templates: { ...config.templates, xingqing: { version: "xingqing-starter.v1", snapshotId: "snap_xq", listed: false } } };
    expect(availableTemplates(hidden).find((template) => template.id === "xingqing")).toMatchObject({ name: "星擎助手", listed: false });
    expect(availableTemplates(hidden).find((template) => template.id === "mirror-v")?.listed).toBe(true);
    expect(requireTemplate(hidden, "xingqing", "xingqing-starter.v1").snapshotId).toBe("snap_xq");
  });

  it("only accepts runtime secrets a template declares", () => {
    expect(templateSecretNames("xingqing")).toEqual(["XINGQING_USERNAME", "XINGQING_PASSWORD"]);
    expect(templateSecretNames("mirror-v")).toEqual([]);
    expect(validateTenantSecrets("xingqing", { XINGQING_USERNAME: " acme ", XINGQING_PASSWORD: "pw" }))
      .toEqual({ XINGQING_USERNAME: "acme", XINGQING_PASSWORD: "pw" });
    expect(() => validateTenantSecrets("mirror-v", {})).toThrow("TEMPLATE_HAS_NO_SECRETS");
    expect(() => validateTenantSecrets("xingqing", { XINGQING_USERNAME: "acme" })).toThrow("INVALID_SECRETS");
    expect(() => validateTenantSecrets("xingqing", { XINGQING_USERNAME: "acme", XINGQING_PASSWORD: "pw", NEXUS_MODEL_KEY: "x" })).toThrow("INVALID_SECRETS");
    expect(() => validateTenantSecrets("xingqing", { XINGQING_USERNAME: "acme", NEXUS_MODEL_KEY: "x" })).toThrow("INVALID_SECRETS");
    expect(() => validateTenantSecrets("xingqing", { XINGQING_USERNAME: "acme", XINGQING_PASSWORD: "a\nb" })).toThrow("INVALID_SECRETS");
  });
});
