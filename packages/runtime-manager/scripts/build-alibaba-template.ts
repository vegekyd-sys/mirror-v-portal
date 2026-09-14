import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Template } from "e2b";
import { loadConfig } from "../src/config.js";
import { alibabaOptions } from "../src/alibaba-provider.js";

const config = loadConfig();
const context = path.join(config.dataDir, "alibaba-build");
fs.mkdirSync(context, { recursive: true, mode: 0o700 });
// Archive only tracked product payload; no customer state or credentials.
execFileSync("git", ["archive", "--format=tar", "--output", path.join(context, "payload.tar"), "HEAD", "packages/dealclaw-agent/payload"], { cwd: path.resolve("../..") });
try {
  fs.copyFileSync(new URL("../runtime/Dockerfile.alibaba", import.meta.url), path.join(context, "Dockerfile"));
  const sourceImage = process.env.NEXUS_ALIBABA_IMAGE;
  if (!sourceImage) {
    console.log(JSON.stringify({ phase: "image-context-ready", context,
      next: "Build linux/amd64 image, push to a private supported registry, then rerun with NEXUS_ALIBABA_IMAGE" }));
    process.exit(0);
  }
  // FC rejects inline E2B build steps: build dependencies into the OCI image.
  const template = Template().fromImage(sourceImage);
  const build = await Template.build(template, `nexus-dealclaw-${Date.now()}`, {
    ...alibabaOptions(config), cpuCount: 2, memoryMB: 4096,
    onBuildLogs: (entry) => console.log(entry.message.replaceAll(config.alibaba!.apiKey, "[redacted]")),
  });
  const file = path.join(config.dataDir, "config.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.alibaba.templateId = build.templateId;
  fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ phase: "template-ready", templateId: build.templateId, buildId: build.buildId }));
} catch (error: any) {
  console.error(JSON.stringify({ phase: "template-build-failed", type: error.constructor.name,
    message: String(error.message).replaceAll(config.alibaba!.apiKey, "[redacted]").slice(0, 2000) }));
  process.exitCode = 1;
}
