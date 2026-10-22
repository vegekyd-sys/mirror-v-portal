import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
// @ts-expect-error runtime module has no type declarations
import { onboardingPreamble, guideSection } from "../runtime/inbound-input.mjs";

const payload = path.resolve(__dirname, "../../agent-templates/mirror-v-full/payload");
const guideText = fs.readFileSync(path.join(payload, "onboarding/GUIDE.md"), "utf8");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function workspace(progress?: object, withGuide = true) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-ws-"));
  dirs.push(ws);
  fs.mkdirSync(path.join(ws, "scripts"));
  fs.mkdirSync(path.join(ws, "onboarding"));
  fs.copyFileSync(path.join(payload, "scripts/onboard-progress.py"), path.join(ws, "scripts/onboard-progress.py"));
  if (withGuide) fs.writeFileSync(path.join(ws, "onboarding/GUIDE.md"), guideText);
  if (progress) fs.writeFileSync(path.join(ws, "onboarding/progress.json"), JSON.stringify(progress));
  return ws;
}
const step = (ws: string) => JSON.parse(fs.readFileSync(path.join(ws, "onboarding/progress.json"), "utf8")).step;

test("first turn carries the guide's opening verbatim and advances the step exactly once", () => {
  const ws = workspace();
  const first = onboardingPreamble("hello", { workspace: ws, sessionKey: "t:oc_x" });
  expect(first).toContain("我现在的记忆是空的");
  expect(first).toContain("1. 飞书里的文档");
  expect(first).toContain("5. 先跳过");
  expect(first.endsWith("hello")).toBe(true);
  expect(step(ws)).toBe("choose");
  const second = onboardingPreamble("1", { workspace: ws, sessionKey: "t:oc_x" });
  expect(second).not.toContain("开场白");
  expect(second).toContain("当前步骤：choose");
  expect(second).toContain("主人选来源");
});

test("onboarding survives a deleted BOOTSTRAP.md: only the progress file ends it", () => {
  // No BOOTSTRAP.md in this workspace at all, as after the model removed it on 10-22.
  const ws = workspace({ step: "feishu_auth", chosen: ["1", "3"], done: [], skipped: ["2"] });
  const out = onboardingPreamble("好了", { workspace: ws, sessionKey: "t:oc_x" });
  expect(out).toContain("当前步骤：feishu_auth");
  expect(out).toContain("已选来源：1 3");
  expect(out).toContain("飞书文档"); // the step's own instructions are quoted
  expect(out).toContain("login --finish");
  expect(onboardingPreamble("你好", { workspace: workspace({ step: "done" }), sessionKey: "t:oc_x" })).toBe("你好");
});

test("every step in the progress script maps to a guide section", () => {
  const steps = fs.readFileSync(path.join(payload, "scripts/onboard-progress.py"), "utf8").match(/STEPS = \(([^)]*)\)/)![1].match(/"([a-z_]+)"/g)!.map((s) => s.slice(1, -1));
  for (const s of steps.filter((s) => s !== "done")) expect(guideSection(guideText, s), s).toMatch(/^## 第 \d 步/);
});

test("no guide, scheduled turns: untouched", () => {
  expect(onboardingPreamble("你好", { workspace: workspace(undefined, false), sessionKey: "t:oc_x" })).toBe("你好");
  const ws = workspace();
  expect(onboardingPreamble("夜间整理", { workspace: ws, sessionKey: "t:oc_x:scheduled:abc" })).toBe("夜间整理");
  expect(fs.existsSync(path.join(ws, "onboarding/progress.json"))).toBe(false);
});
