import { test, expect } from "vitest";
import { repairReplacementChars } from "./text-repair.js";

test("a character split across stream deltas is restored from the transcript text", () => {
  const ref = "还想让我多了解你一点的话，可以再接这几样（回数字，可以多选）";
  expect(repairReplacementChars("还想让我多了解你一点的话，可以再接这几��（回数字，可以多选）", ref)).toBe(ref);
  // Extra text around it (narration, a removed MEDIA line) does not matter.
  expect(repairReplacementChars("前言。\n\n可以再接这几�（回数字", "可以再接这几样（回数字，可以多选）")).toBe("前言。\n\n可以再接这几样（回数字");
});

test("damage is left alone when the reference is missing, damaged or ambiguous", () => {
  const bad = "这几��（回";
  expect(repairReplacementChars(bad, undefined)).toBe(bad);
  expect(repairReplacementChars(bad, "这几�（回")).toBe(bad);
  expect(repairReplacementChars("a�b", "a1b a2b")).toBe("a�b");
  expect(repairReplacementChars("完好的文字", "完全不同")).toBe("完好的文字");
});

test("the transcript reader returns only assistant text written since the turn began", async () => {
  const { default: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-transcript-"));
  try {
    const dir = path.join(root, "agents", "mirror-v-full", "agent");
    fs.mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
    db.exec("CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq)) STRICT");
    const add = db.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)");
    const msg = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
    add.run("s", 1, msg("assistant", "上一轮的回答"), 1000);
    add.run("s", 2, msg("user", "主人说的话"), 2000);
    add.run("s", 3, msg("assistant", "复核：本地没被改动。"), 2001);
    add.run("s", 4, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "exec" }] } }), 2002);
    db.close();
    const out = execFileSync(process.execPath, [new URL("../runtime/transcript-text.mjs", import.meta.url).pathname, "1500"], {
      env: { ...process.env, NEXUS_STATE_ROOT: root, NEXUS_AGENT_ID: "mirror-v-full" }, encoding: "utf8",
    });
    expect(JSON.parse(out).text).toBe("复核：本地没被改动。");
    expect(repairReplacementChars("复核：本地没被改���。", JSON.parse(out).text)).toBe("复核：本地没被改动。");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
