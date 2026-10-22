import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
// @ts-expect-error runtime module has no type declarations
import { onboardingPreamble } from "../runtime/inbound-input.mjs";

const payload = path.resolve(__dirname, "../../agent-templates/mirror-v-full/payload");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function workspace(withBootstrap = true) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-ws-"));
  dirs.push(ws);
  fs.mkdirSync(path.join(ws, "scripts"));
  fs.copyFileSync(path.join(payload, "scripts/onboard-progress.py"), path.join(ws, "scripts/onboard-progress.py"));
  if (withBootstrap) fs.copyFileSync(path.join(payload, "BOOTSTRAP.md"), path.join(ws, "BOOTSTRAP.md"));
  return ws;
}
const progress = (ws: string) => JSON.parse(fs.readFileSync(path.join(ws, "onboarding/progress.json"), "utf8"));

test("first turn carries the payload's opening verbatim and advances the step exactly once", () => {
  const ws = workspace();
  const first = onboardingPreamble("扫码通知", { workspace: ws, sessionKey: "t:oc_x" });
  expect(first).toContain("我现在的记忆是空的");
  expect(first).toContain("1. 飞书里的文档");
  expect(first).toContain("5. 先跳过");
  expect(first.endsWith("扫码通知")).toBe(true);
  expect(progress(ws).step).toBe("choose");
  const second = onboardingPreamble("1", { workspace: ws, sessionKey: "t:oc_x" });
  expect(second).not.toContain("开场白");
  expect(second).toContain("当前步骤：choose");
  expect(second.endsWith("1")).toBe(true);
});

test("later steps report the recorded progress", () => {
  const ws = workspace();
  fs.mkdirSync(path.join(ws, "onboarding"));
  fs.writeFileSync(path.join(ws, "onboarding/progress.json"), JSON.stringify({ step: "feishu_auth", chosen: ["1", "3"], done: [], skipped: ["2"] }));
  const out = onboardingPreamble("好了", { workspace: ws, sessionKey: "t:oc_x" });
  expect(out).toContain("当前步骤：feishu_auth");
  expect(out).toContain("已选来源：1 3");
  expect(out).toContain("已跳过：2");
});

test("no onboarding, no note: finished workspaces and scheduled turns pass through untouched", () => {
  const done = workspace(false);
  expect(onboardingPreamble("你好", { workspace: done, sessionKey: "t:oc_x" })).toBe("你好");
  const ws = workspace();
  expect(onboardingPreamble("夜间整理", { workspace: ws, sessionKey: "t:oc_x:scheduled:abc" })).toBe("夜间整理");
  expect(fs.existsSync(path.join(ws, "onboarding/progress.json"))).toBe(false);
});
