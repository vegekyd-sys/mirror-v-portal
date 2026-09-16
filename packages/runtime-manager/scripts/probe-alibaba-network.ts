// Diagnose why the base-template bootstrap failed with an empty error message:
// check outbound network, npm availability, and surface the real error shape.
import { Sandbox } from "e2b";
import { loadConfig } from "../src/config.js";
import { alibabaOptions } from "../src/alibaba-provider.js";

const config = loadConfig(), options = alibabaOptions(config);
const out: Record<string, unknown> = {};
const ids: string[] = [];
try {
  const box = await Sandbox.create("base", { ...options, timeoutMs: 900_000 });
  ids.push(box.sandboxId);

  const probe = async (label: string, cmd: string, timeoutMs = 120_000) => {
    const at = Date.now();
    try {
      const r = await box.commands.run(cmd, { timeoutMs });
      out[label] = { ms: Date.now() - at, exit: r.exitCode, stdout: r.stdout.trim().slice(0, 300), stderr: r.stderr.trim().slice(-300) };
    } catch (e: any) {
      out[label] = { ms: Date.now() - at, threw: e?.constructor?.name ?? typeof e, message: String(e?.message ?? "").slice(0, 300) };
    }
  };

  await probe("npmVersion", "npm --version || echo NO_NPM", 30_000);
  await probe("whoami", "whoami && id -u", 30_000);
  await probe("dns", "getent hosts registry.npmjs.org || echo DNS_FAIL", 30_000);
  await probe("httpsHead", "curl -sS -o /dev/null -w '%{http_code} %{time_total}' https://registry.npmjs.org/ || echo CURL_FAIL", 60_000);
  await probe("writeTest", "mkdir -p /vercel/sandbox/nexus/runtime && touch /vercel/sandbox/nexus/runtime/.w && echo WRITE_OK", 30_000);
  // Small package first: separates "no network" from "install too slow/large".
  await probe("npmSmall", "cd /tmp && npm install --no-audit --no-fund --prefix /tmp/t is-odd@3.0.1 2>&1 | tail -5", 180_000);
} catch (e: any) {
  out.fatal = { type: e?.constructor?.name, message: String(e?.message ?? "").slice(0, 500) };
  process.exitCode = 1;
} finally {
  await Promise.allSettled(ids.map(id => Sandbox.kill(id, options)));
  console.log(JSON.stringify(out, null, 2));
}
