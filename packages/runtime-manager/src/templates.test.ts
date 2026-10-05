import { describe, expect, it } from "vitest";
import { availableTemplates, requireTemplate, templateSecretNames, validateTenantSecrets } from "./templates.js";
import type { Config } from "./config.js";

const config = {
  snapshotId: "snap_dealclaw",
  templates: { "mirror-v": { version: "mirror-v.v1", snapshotId: "snap_mirror" } },
} as Config;

describe("signup template catalog", () => {
  it("exposes a template avatar without changing its version or snapshot", () => {
    const withAvatar = { ...config, templates: { makaron: { version: "makaron.v2.1.2", snapshotId: "snap_makaron", listed: false, avatarUrl: "https://mirror-v-portal.vercel.app/onboard/assets/makaron-avatar.png" } } };
    expect(requireTemplate(withAvatar, "makaron")).toMatchObject({ version: "makaron.v2.1.2", snapshotId: "snap_makaron", listed: false, avatarUrl: withAvatar.templates.makaron.avatarUrl });
    expect(requireTemplate(config, "mirror-v")).not.toHaveProperty("avatarUrl");
  });

  it("rejects credential-bearing or non-HTTPS template avatars", () => {
    for (const avatarUrl of ["data:image/png;base64,test", "javascript:alert(1)", "http://example.com/avatar.png", "https://user:password@example.com/avatar.png"]) {
      expect(() => availableTemplates({ ...config, templates: { makaron: { version: "makaron.v2.1.2", snapshotId: "snap_makaron", avatarUrl } } })).toThrow("INVALID_TEMPLATE_AVATAR_URL");
    }
  });
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

  it("names the channel app separately from the signup label only when configured", () => {
    const full = { ...config, templates: { ...config.templates, "mirror-v-full": { version: "mirror-v-full.v5", snapshotId: "snap_full", name: "Mirror V 全功能", appName: " Mirror V " } } };
    expect(requireTemplate(full, "mirror-v-full")).toMatchObject({ name: "Mirror V 全功能", appName: "Mirror V" });
    expect(requireTemplate(config, "mirror-v")).not.toHaveProperty("appName");
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

  it("pins the configured Makaron version and keeps a private trial unlisted", () => {
    const privateTrial = { ...config, templates: { ...config.templates, makaron: {
      version: "makaron.v2.0.0", snapshotId: "snap_makaron", listed: false,
    } } };
    expect(requireTemplate(privateTrial, "makaron", "makaron.v2.0.0")).toEqual({
      id: "makaron", version: "makaron.v2.0.0", snapshotId: "snap_makaron", listed: false,
      name: "Makaron", description: "与你一起创作图片、视频、音乐和动态设计",
    });
    expect(() => requireTemplate(config, "makaron")).toThrow("TEMPLATE_NOT_AVAILABLE");
    expect(() => requireTemplate(privateTrial, "makaron", "makaron.v1")).toThrow("TEMPLATE_NOT_AVAILABLE");
  });

  it("accepts only a tenant's own Makaron credential without runtime overrides", () => {
    expect(templateSecretNames("makaron")).toEqual(["MAKARON_API_KEY"]);
    expect(validateTenantSecrets("makaron", { MAKARON_API_KEY: " private-test-key " }))
      .toEqual({ MAKARON_API_KEY: "private-test-key" });
    for (const input of [
      {}, { MAKARON_API_KEY: "" }, { MAKARON_API_KEY: "key\n" },
      { MAKARON_API_KEY: "key", NEXUS_MODEL_KEY: "override" },
      { MAKARON_API_KEY: "key", OPENCLAW_STATE_DIR: "/other-tenant" },
      { XINGQING_PASSWORD: "key" },
    ]) expect(() => validateTenantSecrets("makaron", input)).toThrow("INVALID_SECRETS");
    expect(templateSecretNames("mirror-v")).toEqual([]);
  });
});
