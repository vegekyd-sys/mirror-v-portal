import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { memorySiteFile } from "./memory-site.js";
import { VercelProvider } from "./provider.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function backup(dataDir: string, tenant: string, page: string) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "memory-src-"));
  dirs.push(src);
  const site = path.join(src, "agent-data/workspace/artifacts/memory-graph");
  fs.mkdirSync(path.join(site, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), page);
  fs.writeFileSync(path.join(site, "vendor/force-graph.min.js"), "/* lib */");
  fs.writeFileSync(path.join(site, "shot.png"), "png");
  fs.symlinkSync("/etc/passwd", path.join(site, "graph.json"));
  fs.writeFileSync(path.join(src, "agent-data/workspace/USER.md"), "private");
  fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });
  execFileSync("tar", ["-czf", path.join(dataDir, "backups", `${tenant}.tgz`), "-C", src, "agent-data"]);
}

test("serves only the memory page from the latest backup, refreshed when the backup changes", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-data-"));
  dirs.push(dataDir);
  expect(memorySiteFile(dataDir, "t1", "")).toBeNull(); // no backup yet
  backup(dataDir, "t1", "<title>first</title>");
  const page = memorySiteFile(dataDir, "t1", "")!;
  expect(page.type).toContain("text/html");
  expect(fs.readFileSync(page.file, "utf8")).toContain("first");
  expect(memorySiteFile(dataDir, "t1", "vendor/force-graph.min.js")?.type).toContain("javascript");
  // Nothing else from the backup, no traversal, no symlink out of the page.
  for (const rel of ["shot.png", "../USER.md", "../../USER.md", "graph.json", "vendor/../index.html"]) expect(memorySiteFile(dataDir, "t1", rel), rel).toBeNull();
  // A newer backup (a later turn) replaces the cached copy.
  const later = new Date(Date.now() + 5000);
  backup(dataDir, "t1", "<title>second</title>");
  fs.utimesSync(path.join(dataDir, "backups/t1.tgz"), later, later);
  expect(fs.readFileSync(memorySiteFile(dataDir, "t1", "index.html")!.file, "utf8")).toContain("second");
});

test("owners of templates with a memory page get a signed link to it", () => {
  const provider = new VercelProvider({ encryptionKey: "ab".repeat(32), publicBaseUrl: "https://portal.example", templates: {} } as any);
  const link = provider.openLinks({ id: "t1", template_id: "mirror-v-full" } as any).memory;
  expect(link).toMatch(/^https:\/\/portal\.example\/onboard\/memory\/t1\/[a-f0-9]{32}\/index\.html$/);
  expect(provider.openSignatureValid({ id: "t1" } as any, "memory", link.split("/").at(-2)!)).toBe(true);
  expect(provider.openSignatureValid({ id: "t2" } as any, "memory", link.split("/").at(-2)!)).toBe(false);
  expect(provider.openLinks({ id: "t1", template_id: "makaron" } as any).memory).toBeUndefined();
});
