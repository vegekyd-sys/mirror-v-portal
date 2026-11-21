import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The owner's memory page, served from the tenant's latest state backup.
 *
 * The agent builds artifacts/memory-graph/ itself (scripts/memory-graph.py, the
 * same page V publishes as wiki.tianyi.live), and every turn ends with a backup
 * of agent-data. Reading the page from that backup means opening the link never
 * wakes a sleeping sandbox, and the page is as fresh as the last turn.
 */
const SITE = "agent-data/workspace/artifacts/memory-graph";
/** Only the page, its data and the bundled graph library; never screenshots or anything else in the backup. */
const SERVED = /^(index\.html|graph\.json|graph-lib\.js|history\.jsonl|days\/\d{4}-\d{2}-\d{2}\.json|vendor\/[\w.-]+\.js)$/;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function memorySiteFile(dataDir: string, tenantId: string, rel: string): { file: string; type: string } | null {
  const name = rel || "index.html";
  if (!SERVED.test(name) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(tenantId)) return null;
  const backup = path.join(dataDir, "backups", `${tenantId}.tgz`);
  let stamp: string;
  try { stamp = String(fs.statSync(backup).mtimeMs); } catch { return null; }
  const dir = path.join(dataDir, "memory-sites", tenantId);
  let current = "";
  try { current = fs.readFileSync(path.join(dir, ".stamp"), "utf8"); } catch {}
  if (current !== stamp) extract(backup, dir, stamp);
  const file = path.join(dir, name);
  // A symlink inside the backup must not lead outside the page.
  try {
    if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(fs.realpathSync(dir) + path.sep)) return null;
  } catch { return null; }
  return { file, type: TYPES[path.extname(file)] };
}

function extract(backup: string, dir: string, stamp: string) {
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    execFileSync("tar", ["-xzf", backup, "-C", tmp, "--no-same-owner", "--exclude=*.png", "--strip-components=4", SITE], { timeout: 60_000, stdio: "ignore" });
  } catch {
    // No page in this backup yet (the first nightly run builds it): serve nothing.
  }
  fs.writeFileSync(path.join(tmp, ".stamp"), stamp);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
}
