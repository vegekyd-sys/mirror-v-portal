import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * A schedule may ask to run again soon while the tenant's import backlog lasts:
 * spec.repeat = { while: "imports-pending", afterSeconds, untilHour }.
 *
 * The decision is made here, from the state backup the finished turn just wrote,
 * rather than by the agent booking its own follow-up: on 2026-11-22 the agent
 * paraphrased the prompt it was told to copy, dropped a condition, and the chain
 * stopped with 380 pieces left.
 */
export type RepeatSpec = { while: "imports-pending"; afterSeconds: number; untilHour: number; last?: number | null; fails?: number };

/** Imported documents still waiting to be compiled, per the latest backup; null when unknown. */
export function pendingImports(dataDir: string, tenantId: string): number | null {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(tenantId)) return null;
  try {
    const text = execFileSync("tar", ["-xzOf", path.join(dataDir, "backups", `${tenantId}.tgz`), "agent-data/workspace/memory-archive/imports/MANIFEST.json"],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const data = JSON.parse(text);
    const items = Array.isArray(data) ? data : data.items;
    return Array.isArray(items) ? items.filter((item) => item?.disposition === "pending").length : null;
  } catch { return null; }
}

/** Consecutive failed rounds tolerated before waiting for the regular time (the model drops about one turn in seven). */
const MAX_FAILS = 2;

/** When to run again, or null to wait for the regular time. Stops outside the window, after repeated failures, and when a round made no progress. */
export function repeatAt(repeat: RepeatSpec | undefined, pending: number | null, now = new Date(), tz = "Asia/Shanghai", failed = false): Date | null {
  if (!repeat || repeat.while !== "imports-pending" || !pending) return null;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz }).format(now));
  if (hour >= repeat.untilHour) return null;
  if (failed) { if ((repeat.fails ?? 0) >= MAX_FAILS) return null; }
  else if (typeof repeat.last === "number" && pending >= repeat.last) return null;
  return new Date(+now + Math.max(60, repeat.afterSeconds) * 1000);
}
