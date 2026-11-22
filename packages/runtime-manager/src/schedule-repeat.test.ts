import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { pendingImports, repeatAt } from "./schedule-repeat.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const spec = { while: "imports-pending" as const, afterSeconds: 60, untilHour: 8 };
const night = new Date("2026-11-23T03:05:00+08:00");

test("counts documents still waiting in the latest backup", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "repeat-"));
  dirs.push(data);
  expect(pendingImports(data, "t1")).toBeNull(); // no backup
  const src = path.join(data, "src/agent-data/workspace/memory-archive/imports");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(data, "backups"));
  const pack = () => execFileSync("tar", ["-czf", path.join(data, "backups/t1.tgz"), "-C", path.join(data, "src"), "agent-data"]);
  fs.writeFileSync(path.join(src, "MANIFEST.json"), JSON.stringify({ items: [{ disposition: "pending" }, { disposition: "compiled" }, { disposition: "pending" }] }));
  pack();
  expect(pendingImports(data, "t1")).toBe(2);
  fs.writeFileSync(path.join(src, "MANIFEST.json"), "not json");
  pack();
  expect(pendingImports(data, "t1")).toBeNull();
  expect(pendingImports(data, "../t1")).toBeNull();
});

test("runs again while there is a backlog, progress, and night left", () => {
  expect(repeatAt(spec, 167, night)?.getTime()).toBe(+night + 60_000);
  expect(repeatAt({ ...spec, last: 167 }, 150, night)).not.toBeNull();
  expect(repeatAt({ ...spec, last: 150 }, 150, night)).toBeNull(); // a round without progress ends the night
  expect(repeatAt(spec, 0, night)).toBeNull();
  expect(repeatAt(spec, null, night)).toBeNull();
  expect(repeatAt(spec, 10, new Date("2026-11-23T08:00:00+08:00"))).toBeNull();
  expect(repeatAt(undefined, 10, night)).toBeNull();
  // A dropped round is retried even though nothing moved, but not for ever.
  expect(repeatAt({ ...spec, last: 150 }, 150, night, undefined, true)).not.toBeNull();
  expect(repeatAt({ ...spec, last: 150, fails: 2 }, 150, night, undefined, true)).toBeNull();
});
