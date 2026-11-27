import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("compact backup preserves state, edits, new files, and payload deletions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-backup-test-"));
  try {
    const base = root + "/nexus/payload",
      workspace = root + "/agent-data/workspace";
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(base + "/unchanged", "original");
    fs.writeFileSync(base + "/changed", "original");
    fs.writeFileSync(base + "/deleted", "original");
    fs.writeFileSync(base + "/link", "original");
    fs.cpSync(base, workspace, { recursive: true });
    fs.writeFileSync(workspace + "/changed", "edited");
    fs.writeFileSync(workspace + "/new", "created");
    fs.unlinkSync(workspace + "/deleted");
    fs.unlinkSync(workspace + "/link");
    fs.symlinkSync("missing-target", workspace + "/link");
    fs.mkdirSync(root + "/agent-data/state");
    fs.writeFileSync(
      root + "/agent-data/state/session.json",
      '{"history":true}',
    );
    const archive = root + "/backup.tgz";
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../runtime/backup.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          NEXUS_BACKUP_ROOT: root,
          NEXUS_BACKUP_ARCHIVE: archive,
        },
      },
    );
    const listed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(listed).not.toContain("workspace/unchanged");
    expect(listed).toContain("workspace/changed");
    expect(listed).toContain("state/session.json");
    const restore = root + "/restored";
    fs.mkdirSync(restore);
    fs.cpSync(base, restore + "/agent-data/workspace", { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", restore]);
    const manifest = JSON.parse(
      fs.readFileSync(restore + "/agent-data/.nexus-backup.json", "utf8"),
    );
    for (const rel of manifest.removed)
      fs.rmSync(restore + "/agent-data/workspace/" + rel, {
        recursive: true,
        force: true,
      });
    expect(
      fs.readFileSync(restore + "/agent-data/workspace/unchanged", "utf8"),
    ).toBe("original");
    expect(
      fs.readFileSync(restore + "/agent-data/workspace/changed", "utf8"),
    ).toBe("edited");
    expect(fs.readFileSync(restore + "/agent-data/workspace/new", "utf8")).toBe(
      "created",
    );
    expect(fs.existsSync(restore + "/agent-data/workspace/deleted")).toBe(
      false,
    );
    expect(
      fs.lstatSync(restore + "/agent-data/workspace/link").isSymbolicLink(),
    ).toBe(true);
    expect(fs.readlinkSync(restore + "/agent-data/workspace/link")).toBe(
      "missing-target",
    );
    expect(
      fs.readFileSync(restore + "/agent-data/state/session.json", "utf8"),
    ).toBe('{"history":true}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const gnuTar = /GNU tar/.test(execFileSync("tar", ["--version"], { encoding: "utf8" }));
// The v-release path passes GNU tar flags (the sandbox and CI run GNU tar; macOS ships bsdtar).
test.skipIf(!gnuTar)("a v-release backup never walks an excluded tree that Codex is still writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-backup-vrel-"));
  const tmp = root + "/agent-data/state/agents/mirror-v-full/agent/codex-home/.tmp";
  try {
    fs.mkdirSync(root + "/nexus/payload", { recursive: true });
    fs.mkdirSync(root + "/agent-data/workspace", { recursive: true });
    fs.writeFileSync(root + "/nexus/v-release.json", JSON.stringify({ schemaVersion: 1, release: "r", upstream: "2026.9.1" }));
    fs.mkdirSync(tmp + "/plugins-clone", { recursive: true });
    fs.writeFileSync(tmp + "/plugins-clone/pack", "x");
    fs.writeFileSync(root + "/agent-data/state/agents/mirror-v-full/agent/codex-home/state_5.sqlite", "s");
    // An unreadable directory stands in for one whose files vanish mid-walk: entering it would throw.
    fs.chmodSync(tmp, 0o000);
    const archive = root + "/backup.tgz";
    execFileSync(process.execPath, [fileURLToPath(new URL("../runtime/backup.mjs", import.meta.url))], {
      env: { ...process.env, NEXUS_BACKUP_ROOT: root, NEXUS_BACKUP_ARCHIVE: archive },
    });
    const listed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(listed).toContain("codex-home/state_5.sqlite");
    expect(listed).not.toContain(".tmp");
  } finally {
    fs.chmodSync(tmp, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
