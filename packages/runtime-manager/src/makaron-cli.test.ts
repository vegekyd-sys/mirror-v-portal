import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { distroToolMismatches, makaronCliLinkScript, makaronCliVerifyScript } from "./makaron-cli.js";

// A local stand-in for the npm package: it only prints its version.
function fakeCli(dir: string, version: string) {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "makaron-cli", version, type: "module", bin: { makaron: "bin/makaron.mjs" } }));
  fs.writeFileSync(path.join(dir, "bin/makaron.mjs"), `#!/usr/bin/env node\nconsole.log("${version}");\n`, { mode: 0o755 });
}

describe("preinstalled Makaron CLI", () => {
  it("runs one version as makaron, makaron-cli and npx makaron-cli, also after a tenant upgrade", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-makaron-"));
    try {
      const preinstalled = path.join(root, "nexus/tools-node/node_modules/makaron-cli");
      fakeCli(preinstalled, "1.2.3");
      // npm settings inherited from the test runner (npm_config_prefix, …) would override the prefix under test.
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
      const env = { ...inherited, HOME: root, npm_config_cache: path.join(root, "cache"), npm_config_update_notifier: "false" };
      const sh = (script: string) => execFileSync("bash", ["-c", script], { env, encoding: "utf8", stdio: "pipe" });
      sh(makaronCliLinkScript(root));
      sh(makaronCliLinkScript(root));
      expect(sh(makaronCliVerifyScript("1.2.3", root)).match(/ 1\.2\.3$/gm)).toHaveLength(4);
      expect(() => sh(makaronCliVerifyScript("9.9.9", root))).toThrow();

      const newer = path.join(root, "newer");
      fakeCli(newer, "2.0.0");
      sh(`cd ${newer} && npm pack --silent && NPM_CONFIG_PREFIX=${root}/agent-data/npm npm install -g --offline ./makaron-cli-2.0.0.tgz`);
      // The image's own copy stays; the tools/bin fallback is behind the upgraded global prefix on PATH.
      expect(JSON.parse(fs.readFileSync(path.join(preinstalled, "package.json"), "utf8")).version).toBe("1.2.3");
      const upgraded = sh(`export NPM_CONFIG_PREFIX=${root}/agent-data/npm PATH=${root}/agent-data/npm/bin:${root}/nexus/tools/bin:$PATH; cd ${root} && makaron && makaron-cli && npx --offline makaron-cli`);
      expect(upgraded.trim().split("\n")).toEqual(["2.0.0", "2.0.0", "2.0.0"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("v-distro tool versions", () => {
  it("names every CLI whose snapshot pin differs from the package", () => {
    const tools = { npm: { codex: { version: "0.169.1" }, "makaron-cli": { version: "0.17.30" }, "lark-cli": { version: "1.0.97" } } };
    expect(distroToolMismatches(tools, { codex: "0.169.1", "makaron-cli": "0.17.30", "lark-cli": "1.0.97" })).toEqual([]);
    expect(distroToolMismatches(tools, { codex: "0.159.2", "makaron-cli": "0.17.30", "lark-cli": "1.0.97" })).toEqual(["codex: snapshot 0.159.2, v-distro 0.169.1"]);
    // Archives packaged before v-distro carry no tools.json.
    expect(distroToolMismatches(undefined, { codex: "0.159.2" })).toEqual([]);
  });
});
