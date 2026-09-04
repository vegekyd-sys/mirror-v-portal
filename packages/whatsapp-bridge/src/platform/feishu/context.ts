import { AsyncLocalStorage } from "node:async_hooks";
import type { FeishuAppCreds } from "./apps";
import { envFeishuCreds, resolveFeishuAppCreds } from "./apps";

const storage = new AsyncLocalStorage<FeishuAppCreds>();

export function runWithFeishuApp<T>(creds: FeishuAppCreds, fn: () => T): T {
  return storage.run(creds, fn);
}

export async function withFeishuApp<T>(appId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const creds = await resolveFeishuAppCreds(appId);
  return runWithFeishuApp(creds, fn);
}

export function currentFeishuApp(): FeishuAppCreds | undefined {
  return storage.getStore() || envFeishuCreds();
}

export function requireFeishuApp(): FeishuAppCreds {
  const creds = currentFeishuApp();
  if (creds) return creds;
  throw new Error("飞书应用未注册：智能体初始化时请 POST /api/feishu/apps");
}
