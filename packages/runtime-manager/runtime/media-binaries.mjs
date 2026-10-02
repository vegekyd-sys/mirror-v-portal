import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MEDIA_BINARY_PACKAGES = ["ffmpeg-static@5.2.0", "ffprobe-static@3.1.0"];

/** Resolve the installed platform binaries once while building the immutable snapshot. */
export function installMediaBinaries(runtimeRoot) {
  const root = path.resolve(runtimeRoot);
  const require = createRequire(path.join(root, "package.json"));
  const binaries = { ffmpeg: require("ffmpeg-static"), ffprobe: require("ffprobe-static").path };
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, source] of Object.entries(binaries)) {
    if (!source || !fs.statSync(source).isFile()) throw Error(`MEDIA_BINARY_UNAVAILABLE:${name}`);
    fs.accessSync(source, fs.constants.X_OK);
    const target = path.join(bin, name);
    fs.rmSync(target, { force: true });
    fs.symlinkSync(source, target);
    execFileSync(target, ["-version"], { stdio: "ignore" });
  }
  return bin;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installMediaBinaries(process.argv[2]);
  console.log(JSON.stringify({ phase: "media-binaries-ready", binaries: ["ffmpeg", "ffprobe"] }));
}
