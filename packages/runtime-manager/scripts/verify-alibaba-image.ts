import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const name = `nexus-alibaba-image-check-${randomUUID().slice(0, 8)}`;
const env = { ...process.env,
  NEXUS_GATEWAY_TOKEN: randomUUID(), NEXUS_MODEL_KEY: "image-check-placeholder",
  NEXUS_MODEL_BASE_URL: "http://127.0.0.1:9", NEXUS_MODEL_ID: "deepseek-flash", NEXUS_OPTIMIZE: "1" };
const docker = (args: string[]) => execFileSync("docker", args, { env, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });
try {
  docker(["run", "-d", "--platform", "linux/amd64", "--user", "node", "--name", name,
    ...["NEXUS_GATEWAY_TOKEN", "NEXUS_MODEL_KEY", "NEXUS_MODEL_BASE_URL", "NEXUS_MODEL_ID", "NEXUS_OPTIMIZE"].flatMap(k => ["--env", k]),
    "nexus-dealclaw-alibaba:2026-09-14", "sleep", "300"]);
  docker(["cp", path.resolve("runtime/.") + "/.", `${name}:/vercel/sandbox/nexus/`]);
  const boot = docker(["exec", name, "node", "/vercel/sandbox/nexus/boot.mjs"]);
  console.log(JSON.stringify({ phase: "local-image-boot", boot: JSON.parse(boot.trim().split("\n").at(-1)!) }));
  const reused = docker(["exec", name, "node", "/vercel/sandbox/nexus/boot.mjs"]);
  if (!JSON.parse(reused.trim().split("\n").at(-1)!).processReused) throw Error("IMAGE_BOOT_NOT_REUSED");
  console.log(JSON.stringify({ phase: "local-image-verified", user: "node", modelCallTested: false }));
} catch (error: any) {
  // No credentials are supplied to this image-only check. Keep diagnostics local.
  console.error(String(error.stderr || error.message).slice(-3000)); process.exitCode = 1;
} finally { try { docker(["rm", "-f", name]); } catch {} }
