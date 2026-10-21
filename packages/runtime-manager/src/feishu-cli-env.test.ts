import { randomBytes, createCipheriv } from "node:crypto";
import { expect, test } from "vitest";
import { feishuCliEnv, FEISHU_CLI_CONFIG_DIR } from "./provider.js";

const key = randomBytes(32).toString("hex");
function seal(value: string) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]).toString("base64");
}

test("hands the owner's bound Feishu app to lark-cli for templates that read documents", () => {
  const env = feishuCliEnv({ template_id: "mirror-v-full", app_id: "cli_bound", secret: seal("app-secret") }, key);
  expect(env).toMatchObject({
    LARKSUITE_CLI_APP_ID: "cli_bound",
    LARKSUITE_CLI_APP_SECRET: "app-secret",
    LARKSUITE_CLI_BRAND: "feishu",
    LARKSUITE_CLI_CONFIG_DIR: FEISHU_CLI_CONFIG_DIR,
  });
  // Config and tokens live in agent-data: kept across sleep and backups, outside the git workspace.
  expect(FEISHU_CLI_CONFIG_DIR.startsWith("/vercel/sandbox/agent-data/")).toBe(true);
  expect(FEISHU_CLI_CONFIG_DIR.includes("/workspace")).toBe(false);
});

test("other templates and tenants without a Feishu app get nothing", () => {
  expect(feishuCliEnv({ template_id: "dealclaw", app_id: "cli_x", secret: seal("s") }, key)).toEqual({});
  expect(feishuCliEnv({ template_id: "makaron", app_id: "cli_x", secret: seal("s") }, key)).toEqual({});
  expect(feishuCliEnv({ template_id: "mirror-v-full", app_id: null, secret: null }, key)).toEqual({});
});

test("no variable can shadow the runtime's own NEXUS_* / OPENCLAW_* settings", () => {
  const env = feishuCliEnv({ template_id: "mirror-v-full", app_id: "cli_bound", secret: seal("s") }, key);
  expect(Object.keys(env).every((k) => k.startsWith("LARKSUITE_CLI_"))).toBe(true);
});
