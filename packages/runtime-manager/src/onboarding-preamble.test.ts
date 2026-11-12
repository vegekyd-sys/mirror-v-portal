import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
// @ts-expect-error runtime module has no type declarations
import { onboardingPreamble, guideSection, librarianAskPreamble } from "../runtime/inbound-input.mjs";

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

test("first turn carries the guide's opening verbatim, then connects Feishu, and advances the step exactly once", () => {
  const ws = workspace();
  const first = onboardingPreamble("hello", { workspace: ws, sessionKey: "t:oc_x" });
  expect(first).toContain("我现在还不认识你");
  expect(first).toContain("feishu-docs.py connect"); // step 0's second half: get the auth link out in the same turn
  expect(first).not.toContain("1. 飞书里的文档"); // no pick-a-source menu any more
  expect(first.endsWith("hello")).toBe(true);
  expect(step(ws)).toBe("feishu_auth");
  const second = onboardingPreamble("好了", { workspace: ws, sessionKey: "t:oc_x" });
  expect(second).not.toContain("开场白");
  expect(second).toContain("当前步骤：feishu_auth");
  expect(second).toContain("connect --finish");
  expect(second).toContain("写初稿"); // authorizing usually runs on into reading and the draft
  expect(second).toContain("feishu-docs.py picks");
});

test("onboarding survives a deleted BOOTSTRAP.md: only the progress ends it", () => {
  // No BOOTSTRAP.md in this workspace at all, as after the model removed it on 10-22.
  const ws = workspace({ step: "feishu_grant", chosen: [], done: [], skipped: [] });
  const out = onboardingPreamble("好了", { workspace: ws, sessionKey: "t:oc_x" });
  expect(out).toContain("当前步骤：feishu_grant");
  expect(out).toContain("等主人授权"); // the step's own instructions are quoted
  expect(onboardingPreamble("你好", { workspace: workspace({ step: "done" }), sessionKey: "t:oc_x" })).toBe("你好");
});

test("the progress is corrected from what happened, and the draft sent in the background is quoted back", () => {
  // 2026-10-23: documents were read in, but the step stayed at the old "choose".
  const ws = workspace({ step: "choose", chosen: ["1"], done: [], skipped: [] });
  fs.mkdirSync(path.join(ws, "memory-archive/imports"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory-archive/imports/MANIFEST.json"), JSON.stringify({ items: [{ source: "feishu", title: "[Versa] 公司介绍" }] }));
  expect(onboardingPreamble("在吗", { workspace: ws, sessionKey: "t:oc_x" })).toContain("当前步骤：reading");
  fs.writeFileSync(path.join(ws, "onboarding/draft.md"), "读完第一批文档了，这是我现在对你的理解：\n你：Versa 创始人");
  const out = onboardingPreamble("公司名写错了", { workspace: ws, sessionKey: "t:oc_x" });
  expect(out).toContain("当前步骤：draft");
  expect(out).toContain("你：Versa 创始人");
  expect(out).toContain("主人纠正初稿");
});

test("the Librarian's open question rides along until answered or a week old", () => {
  const ws = workspace({ step: "done" });
  const now = Date.parse("2026-11-13T09:00:00+08:00");
  fs.mkdirSync(path.join(ws, "memory/librarian"), { recursive: true });
  const ask = { asked_at: "2026-11-12T21:08:00+0800", question: "成立时间以哪个为准？", options: ["官网 2020 年", "工商 2021 年"], pages: ["memory/projects/versa/main.md"] };
  fs.writeFileSync(path.join(ws, "memory/librarian/ask.json"), JSON.stringify(ask));
  const out = librarianAskPreamble("2", { workspace: ws, sessionKey: "t:oc_x", now });
  expect(out).toContain("成立时间以哪个为准？");
  expect(out).toContain("2. 工商 2021 年");
  expect(out).toContain("librarian-ask.py answered");
  expect(out.endsWith("2")).toBe(true);
  expect(librarianAskPreamble("2", { workspace: ws, sessionKey: "t:oc_x:scheduled:a", now })).toBe("2");
  expect(librarianAskPreamble("2", { workspace: ws, sessionKey: "t:oc_x", now: now + 8 * 86400000 })).toBe("2");
  fs.writeFileSync(path.join(ws, "memory/librarian/ask.json"), JSON.stringify({ ...ask, answered_at: "2026-11-13T09:01:00+0800" }));
  expect(librarianAskPreamble("2", { workspace: ws, sessionKey: "t:oc_x", now })).toBe("2");
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
