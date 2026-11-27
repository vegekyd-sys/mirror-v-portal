import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error plain .mjs build helpers without types
import { portalSchedules } from "../../agent-templates/mirror-v-full/distro/schedules.mjs";
// @ts-expect-error plain .mjs build helpers without types
import { render, readSkip, SANDBOX_VALUES } from "../../agent-templates/mirror-v-full/distro/import-workspace.mjs";

const template = path.resolve(__dirname, "../../agent-templates/mirror-v-full");
const payload = path.join(template, "payload");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const textFiles = walk(payload).filter((f) => !/\.(png|jpe?g|gif|webp|min\.js)$/.test(f));

describe("Mirror V payload from the distro workspace", () => {
  it("maps schedules.json to Portal system schedules, keeping disabled ones off", () => {
    const out = portalSchedules([
      { key: "heartbeat-maintenance", name: "H", cron: "0 8,20 * * *", prompt: "p" },
      { key: "heartbeat-daily-review", name: "R", cron: "0 12 * * *", enabled: false, prompt: "p" },
    ], "Asia/Shanghai");
    expect(out).toEqual([
      { name: "H", kind: "heartbeat", schedule: { kind: "cron", expr: "0 8,20 * * *", tz: "Asia/Shanghai" }, prompt: "p" },
      { name: "R", kind: "cron", schedule: { kind: "cron", expr: "0 12 * * *", tz: "Asia/Shanghai" }, prompt: "p", enabled: false },
    ]);
    expect(() => portalSchedules([{ key: "a", name: "x", cron: "0 8 * *", prompt: "p" }], "UTC")).toThrow("SCHEDULE_CRON_INVALID");
    expect(() => portalSchedules([{ key: "a", name: "x", cron: "0 8 * * *", prompt: "p" }, { key: "b", name: "x", cron: "0 9 * * *", prompt: "p" }], "UTC")).toThrow("SCHEDULE_NAME_REPEATED");
  });

  it("the manifest registers exactly the payload's schedules.json", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(payload, "payload-manifest.json"), "utf8"));
    const schedules = JSON.parse(fs.readFileSync(path.join(payload, "schedules.json"), "utf8"));
    expect(manifest.systemSchedules).toEqual(portalSchedules(schedules, SANDBOX_VALUES.TIMEZONE));
  });

  it("renders every placeholder and refuses unknown ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-render-"));
    try {
      fs.writeFileSync(path.join(dir, "a.md"), "cd @@WORKSPACE@@ && agent @@AGENT_ID@@ in @@TIMEZONE@@");
      expect(render(dir)).toEqual(["a.md"]);
      expect(fs.readFileSync(path.join(dir, "a.md"), "utf8")).toBe("cd /vercel/sandbox/agent-data/workspace && agent mirror-v-full in Asia/Shanghai");
      fs.writeFileSync(path.join(dir, "b.md"), "@@OWNER@@");
      expect(() => render(dir)).toThrow("UNKNOWN_PLACEHOLDER:OWNER");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("every skipped path has a reason", () => {
    expect(readSkip(path.join(template, "distro/sandbox-skip.txt")).length).toBeGreaterThan(0);
  });

  it("the payload carries no placeholder and nothing that needs V's own channel or cron", () => {
    const offenders = textFiles.flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      const rel = path.relative(payload, file);
      return [
        /@@[A-Z][A-Z0-9_]*@@/.test(text) ? `${rel}: placeholder` : "",
        /scripts\/v-schedule\.py|openclaw cron (list|edit|rm|add)/.test(text) ? `${rel}: native cron` : "",
        /skills\/feishu-channel-cards/.test(text) ? `${rel}: native cards` : "",
      ].filter(Boolean);
    });
    expect(offenders).toEqual([]);
    expect(fs.existsSync(path.join(payload, "artifacts/memory-graph/vendor/force-graph.min.js"))).toBe(true);
  });
});
