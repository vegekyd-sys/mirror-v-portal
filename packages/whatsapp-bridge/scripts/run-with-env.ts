import { spawnSync } from "node:child_process";
import { loadEnvFiles } from "../src/loadEnv.js";

loadEnvFiles();

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: tsx scripts/run-with-env.ts <command> [args...]");
  process.exit(1);
}

const [command, ...rest] = args;
const result = spawnSync(command, rest, {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 1);
