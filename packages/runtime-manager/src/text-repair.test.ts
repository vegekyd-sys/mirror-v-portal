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
