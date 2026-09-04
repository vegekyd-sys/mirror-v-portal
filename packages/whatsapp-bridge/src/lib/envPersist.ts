import fs from "node:fs";
import path from "node:path";
import { appEnv } from "../loadEnv";

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

export function upsertEnvFileContents(text: string, updates: Record<string, string>): string {
  let next = text.replace(/\r\n/g, "\n");
  const endedWithNewline = next.endsWith("\n") || next.length === 0;
  for (const [key, raw] of Object.entries(updates)) {
    if (!ENV_KEY.test(key)) continue;
    const value = raw.replace(/\r?\n/g, "").trim();
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(next)) next = next.replace(pattern, line);
    else next = `${next.replace(/\s+$/, "")}\n${line}\n`;
  }
  if (endedWithNewline && !next.endsWith("\n")) next += "\n";
  return next;
}

/** 把键写进当前环境对应的 env 文件，并更新 process.env。不写 API Key。 */
export function persistEnvValues(updates: Record<string, string>, root = process.cwd()): string[] {
  for (const [key, value] of Object.entries(updates)) {
    if (!ENV_KEY.test(key)) continue;
    process.env[key] = value;
  }

  const files = [
    `.env.${appEnv}`,
    ".env.local",
    `.env.${appEnv}.local`,
    ".env",
  ];
  const written: string[] = [];
  for (const relative of files) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full) && relative !== `.env.${appEnv}`) continue;
    const prev = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
    const next = upsertEnvFileContents(prev, updates);
    if (next !== prev) {
      fs.writeFileSync(full, next, "utf8");
      written.push(relative);
    }
  }
  return written;
}
