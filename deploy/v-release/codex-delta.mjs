#!/usr/bin/env node
// V captures its running @openclaw/codex as a whole package (release/captured/<tag>.codex:
// every file "added", paths ./dist/... and ./package.json). The sandbox installs the npm
// package itself and overlays only what V changed, fail-closed (runtime/v-release.mjs
// applyCapture). This turns the whole-package capture into that overlay:
//   modified  V's bytes for a dist file the npm package also ships (baseSha256 = npm bytes)
//   added     a dist file only V has
// Every file outside dist/ must equal the npm package, otherwise the overlay could not
// reproduce V's package and the conversion fails.
//
// Usage: codex-delta.mjs <capture dir> <npm package dir> <out dir>
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function codexDelta(captureDir, npmDir, outDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(captureDir, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(npmDir, "package.json"), "utf8"));
  if (pkg.name !== "@openclaw/codex") throw Error(`CODEX_DELTA_NOT_CODEX_PACKAGE:${pkg.name}`);
  if (manifest.upstream && manifest.upstream !== `@openclaw/codex ${pkg.version}`) throw Error(`CODEX_DELTA_VERSION_MISMATCH:${manifest.upstream}`);
  if (manifest.removedFromBase?.length) throw Error("CODEX_DELTA_REMOVED_FILES_UNSUPPORTED");
  const files = [];
  const captured = new Set();
  for (const entry of manifest.files) {
    const rel = entry.path.replace(/^\.\//, "");
    if (!rel || rel.split("/").some((part) => !part || part === "..")) throw Error(`CODEX_DELTA_PATH_INVALID:${entry.path}`);
    captured.add(rel);
    const src = path.join(captureDir, "dist", rel);
    if (sha256(src) !== entry.sha256) throw Error(`CODEX_DELTA_CAPTURE_BYTES_MISMATCH:${rel}`);
    const base = path.join(npmDir, rel);
    const baseSha = fs.existsSync(base) ? sha256(base) : null;
    if (!rel.startsWith("dist/")) {
      if (baseSha !== entry.sha256) throw Error(`CODEX_DELTA_PACKAGE_FILE_DIFFERS:${rel}`);
      continue;
    }
    if (baseSha === entry.sha256) continue;
    const distRel = rel.slice("dist/".length);
    fs.mkdirSync(path.dirname(path.join(outDir, "dist", distRel)), { recursive: true });
    fs.copyFileSync(src, path.join(outDir, "dist", distRel));
    files.push(baseSha ? { path: `./${distRel}`, sha256: entry.sha256, kind: "modified", baseSha256: baseSha } : { path: `./${distRel}`, sha256: entry.sha256, kind: "added" });
  }
  // npm files V's package no longer has would stay behind in the overlay: refuse instead.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
  const extra = walk(npmDir).map((file) => path.relative(npmDir, file).split(path.sep).join("/")).filter((rel) => !captured.has(rel));
  if (extra.length) throw Error(`CODEX_DELTA_NPM_ONLY_FILES:${extra.slice(0, 5).join(",")}`);
  const out = {
    release: manifest.release,
    upstream: pkg.version,
    package: "@openclaw/codex",
    capturedFrom: manifest.capturedFrom,
    capturedAt: manifest.capturedAt,
    note: `Overlay derived from the whole-package capture ${manifest.release} against npm @openclaw/codex@${pkg.version} (deploy/v-release/codex-delta.mjs).`,
    removedFromBase: [],
    files,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(out, null, 1));
  return { release: out.release, modified: files.filter((f) => f.kind === "modified").length, added: files.filter((f) => f.kind === "added").length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [captureDir, npmDir, outDir] = process.argv.slice(2);
  if (!captureDir || !npmDir || !outDir) throw Error("usage: codex-delta.mjs <capture dir> <npm package dir> <out dir>");
  fs.mkdirSync(outDir, { recursive: true });
  console.log(JSON.stringify(codexDelta(captureDir, npmDir, outDir)));
}
