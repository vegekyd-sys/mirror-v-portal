#!/usr/bin/env node
// Mirror V full regression eval (docs/mirror-v-full-eval.md). Runs on the Portal host.
//   health                         L0: read-only checks over every tenant (no model calls, never wakes a VM)
//   gate [--tenant id] [--quick] [--only A2,B1]
//                                  L1: functional regression on a test tenant; --quick skips the sleep cycle
//   soak [--tenant id]             L2: a night of simulated use on a dedicated tenant, compared with the last night
// Exit code: 0 pass, 2 an alert / P0 failure, 1 the eval itself broke.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const RELEASE = process.env.NEXUS_RELEASE || "/opt/nexus/current";
const DIST = `${RELEASE}/packages/runtime-manager/dist`;
const OUT = process.env.NEXUS_EVAL_DIR || "/opt/nexus/data/eval";
const { loadConfig } = await import(`${DIST}/config.js`);
const { Store } = await import(`${DIST}/store.js`);
const { runtimeRevision } = await import(`${DIST}/provider.js`);
const config = loadConfig();
const store = new Store(config);
const q = async (sql, values) => (await store.pool.query(sql, values)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] ?? true; };
fs.mkdirSync(OUT, { recursive: true });
const record = (file, entry) => fs.appendFileSync(path.join(OUT, file), JSON.stringify(entry) + "\n");

// ---------- shared primitives ----------

/** Send one message through the Portal's run pipeline and wait for it to finish. */
async function say(tenant, text, { session = "eval:main", timeoutMs = 600_000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${config.port}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.adminToken}` },
    body: JSON.stringify({ tenantId: tenant, text, sessionKey: `agent:mirror-v-full:${session}` }),
  });
  if (!res.ok) throw Error(`ENQUEUE_${res.status}`);
  const { runId } = await res.json();
  const start = Date.now();
  let run;
  for (;;) {
    await sleep(1000);
    [run] = await q("SELECT * FROM elastic_runs WHERE id=$1", [runId]);
    if (!["queued", "running"].includes(run.status)) break;
    if (Date.now() - start > timeoutMs) break;
  }
  return turnMetrics(run);
}
async function turnMetrics(run) {
  const events = await q("SELECT kind,data,created_at FROM elastic_events WHERE run_id=$1 ORDER BY seq", [run.id]);
  const at = (kind) => events.find((e) => e.kind === kind)?.created_at?.getTime();
  const t0 = run.created_at.getTime();
  const firstVisible = Math.min(...["first-preview", "first-delta"].map(at).filter(Boolean));
  const firstTool = at("tool-progress");
  const ready = events.find((e) => e.kind === "ready")?.data;
  const stats = events.find((e) => e.kind === "preview-stats")?.data;
  return {
    runId: run.id, status: run.status, error: run.error, output: run.output || "",
    totalMs: (run.completed_at?.getTime() ?? Date.now()) - t0,
    wake: ready ? { reused: ready.reused, wakeMs: ready.wakeMs } : null,
    startedMs: at("waking") ? at("waking") - t0 : null,
    firstVisibleMs: Number.isFinite(firstVisible) ? firstVisible - t0 : null,
    previewFrames: stats?.frames ?? 0, previewSpanMs: stats ? stats.lastAt - stats.firstAt : 0,
    deltas: events.filter((e) => e.kind === "delta").length,
    commentary: events.filter((e) => e.kind === "commentary").map((e) => ({ text: e.data.text, at: e.created_at.getTime() })),
    tools: events.filter((e) => e.kind === "tool-progress" && e.data.phase === "start").map((e) => e.data.name),
    firstToolAt: firstTool ?? null,
    tailMs: at("completed") && at("runtime-completed") ? at("completed") - at("runtime-completed") : null,
    backupMs: events.find((e) => e.kind === "state-saved")?.data?.backupMs ?? null,
    media: events.filter((e) => e.kind === "media-announced").length,
    completedAt: run.completed_at?.getTime() ?? null,
  };
}
const tenantRow = async (id) => (await q("SELECT * FROM elastic_tenants WHERE id=$1", [id]))[0];

/** Run a shell command inside a tenant's sandbox (wakes a sleeping one: only call right after a turn). */
async function exec(tenant, command, timeoutMs = 60_000) {
  const require = createRequire(`${RELEASE}/packages/runtime-manager/package.json`);
  const { Sandbox } = require("@vercel/sandbox");
  const { token, teamId, projectId } = config.vercel;
  const sbx = await Sandbox.get({ token, teamId, projectId, name: (await tenantRow(tenant)).sandbox_name });
  const r = await sbx.runCommand({ cmd: "bash", args: ["-lc", command], signal: AbortSignal.timeout(timeoutMs) });
  return { exitCode: r.exitCode, stdout: (await r.stdout()).trim() };
}
// Boot id current and every daemon's PID file names a live process of the right kind.
const PID_CHECK = String.raw`cur=$(cat /proc/sys/kernel/random/boot_id); [ "$(cat /tmp/nexus-boot-id)" = "$cur" ] && echo BOOT_OK
for f in gateway desktop desktop-handoff vbrowser-broker voice cua-node memory-indexer; do
  p=$(cat /tmp/nexus-$f.pid 2>/dev/null); c=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)
  if [ -n "$c" ]; then echo "$f alive $(echo $c | head -c 60)"; else echo "$f"; fi
done`;
const cjkRatio = (text) => { const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, ""); return letters ? (letters.match(/\p{Script=Han}/gu) || []).length / letters.length : 1; };
const nonce = () => randomUUID().slice(0, 8);

// ---------- L0 health ----------

async function health() {
  const alerts = [], notes = [];
  const alert = (id, tenant, detail) => alerts.push({ id, tenant, detail });
  const tenants = await q("SELECT id,template_id,state,last_error,last_activity FROM elastic_tenants WHERE template_id IS NOT NULL");
  for (const t of tenants.filter((t) => t.state === "blocked")) alert("H1", t.id, `blocked: ${t.last_error}`);
  for (const t of tenants) {
    const lastSleep = await q("SELECT kind,data FROM elastic_events WHERE tenant_id=$1 AND kind IN ('sleeping','idle-deferred') ORDER BY seq DESC LIMIT 3", [t.id]);
    if (lastSleep.length === 3 && lastSleep.every((e) => e.kind === "idle-deferred"))
      alert("H2", t.id, `cannot sleep: ${JSON.stringify(lastSleep[0].data.detail ?? lastSleep[0].data.reason)}`);
    const recent = await q("SELECT status,error FROM elastic_runs WHERE tenant_id=$1 AND schedule_id IS NULL ORDER BY created_at DESC LIMIT 3", [t.id]);
    const bad = recent.filter((r) => ["failed", "uncertain"].includes(r.status));
    if (bad.length >= 2) alert("H3", t.id, `${bad.length}/3 recent turns failed: ${[...new Set(bad.map((r) => r.error))].join(",")}`);
  }
  for (const s of await q("SELECT s.tenant_id,s.name,s.next_at FROM elastic_schedules s JOIN elastic_tenants t ON t.id=s.tenant_id WHERE s.enabled AND s.next_at < now() - interval '30 minutes'"))
    alert("H4", s.tenant_id, `schedule overdue: ${s.name} since ${s.next_at.toISOString()}`);
  for (const r of await q("SELECT r.tenant_id,r.status,r.error,s.name FROM elastic_runs r JOIN elastic_schedules s ON s.id=r.schedule_id WHERE r.created_at > now() - interval '24 hours' AND r.status IN ('failed','uncertain')"))
    alert("H4", r.tenant_id, `scheduled run failed: ${r.name} ${r.error}`);
  for (const e of await q("SELECT tenant_id,(data->>'backupMs')::int ms FROM elastic_events WHERE kind='state-saved' AND created_at > now() - interval '24 hours' AND (data->>'backupMs')::int > 15000"))
    alert("H5", e.tenant_id, `slow backup ${e.ms} ms`);
  const backups = path.join(config.dataDir, "backups");
  for (const file of fs.existsSync(backups) ? fs.readdirSync(backups) : []) {
    const size = fs.statSync(path.join(backups, file)).size;
    if (file.endsWith(".tgz") && size > 80 << 20) alert("H5", file.replace(/\.tgz$/, ""), `backup ${Math.round(size / 2 ** 20)} MB`);
  }
  const [lag] = await q("SELECT count(DISTINCT date_trunc('second',created_at)) n, max((data->>'eventLoopLagMs')::int) max FROM elastic_events WHERE kind='feishu-connection' AND created_at > now() - interval '1 hour' AND (data->>'eventLoopLagMs')::int > 1000");
  if (Number(lag.n) >= 30) alert("H6", "portal", `runtime-manager event loop >1 s ${lag.n} times in 1 h (max ${lag.max} ms)`);
  else if (Number(lag.n)) notes.push(`H6 lag>1s ${lag.n}x/h`);
  for (const t of tenants) {
    const turns = await q(`SELECT EXTRACT(EPOCH FROM (min(e.created_at) - r.created_at))*1000 ms FROM elastic_runs r JOIN elastic_events e ON e.run_id=r.id AND e.kind='feishu-first-content'
      WHERE r.tenant_id=$1 AND r.schedule_id IS NULL GROUP BY r.id ORDER BY r.created_at DESC LIMIT 10`, [t.id]);
    const sorted = turns.map((x) => Number(x.ms)).sort((a, b) => a - b);
    if (sorted.length >= 5 && sorted[Math.floor(sorted.length / 2)] > 15000) alert("H7", t.id, `first text p50 ${Math.round(sorted[Math.floor(sorted.length / 2)] / 1000)} s`);
    const [tail] = await q(`SELECT max(EXTRACT(EPOCH FROM (c.created_at - rc.created_at))*1000) ms FROM elastic_events rc JOIN elastic_events c ON c.run_id=rc.run_id AND c.kind='completed'
      WHERE rc.kind='runtime-completed' AND rc.tenant_id=$1 AND rc.created_at > now() - interval '24 hours'`, [t.id]);
    if (Number(tail.ms) > 30000) alert("H8", t.id, `reply tail ${Math.round(tail.ms / 1000)} s`);
    const [conn] = await q("SELECT data,created_at FROM elastic_events WHERE tenant_id=$1 AND kind='feishu-connection' ORDER BY seq DESC LIMIT 1", [t.id]);
    if (conn && conn.data.state !== "connected" && Date.now() - conn.created_at > 300_000) alert("H9", t.id, `feishu ${conn.data.state}`);
  }
  const result = { at: new Date().toISOString(), tenants: tenants.length, alerts, notes };
  record("health.jsonl", result);
  console.log(JSON.stringify(result, null, 1));
  return alerts.length ? 2 : 0;
}

// ---------- L1 gate ----------

function makeCases(tenant) {
  const results = [];
  const check = (id, priority, pass, detail) => { results.push({ id, priority, pass: !!pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${id} [${priority}] ${detail}`); };
  const turns = [];
  const turn = async (label, text, opts) => { const m = await say(tenant, text, opts); turns.push({ label, ...m, output: m.output.slice(0, 400) }); console.log(`  · ${label}: ${m.status} total=${m.totalMs}ms first=${m.firstVisibleMs}ms tools=${m.tools.join(",")}`); return m; };
  return { results, check, turns, turn };
}

async function gate() {
  const tenant = flag("tenant", "mvfull-accept-04");
  const only = flag("only", "") ? String(flag("only")).split(",") : null;
  const want = (id) => !only || only.includes(id);
  const { results, check, turns, turn } = makeCases(tenant);
  const t = await tenantRow(tenant);
  if (!t) throw Error(`no tenant ${tenant}`);
  check("F2", "P0", t.state !== "blocked", `test tenant state=${t.state}`);
  const wasAsleep = t.state === "sleeping";

  // A1/A2: first turn may be a cold wake, second is warm.
  const first = await turn("hello", "用两三句话介绍一下你自己。");
  if (wasAsleep) check("A1", "P0", first.status === "succeeded" && first.wake && !first.wake.reused && first.wake.wakeMs < 35000, `cold wake ${first.wake?.wakeMs} ms, ${first.status}`);
  const warm = await turn("warm", "再用一句话说说你能帮我做什么。");
  if (want("A2")) check("A2", "P0", warm.status === "succeeded" && warm.firstVisibleMs < 6000 && warm.totalMs < 25000, `first visible ${warm.firstVisibleMs} ms, total ${warm.totalMs} ms`);

  if (want("A3")) {
    const long = await turn("long", "写一段 400 字左右的短文，介绍巴厘岛乌布适合怎么玩。不要调用工具。");
    const frames = long.previewFrames + long.deltas;
    check("A3", "P0", long.status === "succeeded" && frames >= 3 && (long.previewSpanMs >= 1000 || long.deltas >= 3), `${long.previewFrames} preview + ${long.deltas} delta frames over ${long.previewSpanMs} ms`);
  }

  if (want("A4") || want("B2") || want("B3")) {
    const multi = await turn("multi-tool", "先用一句话告诉我你打算怎么做，然后用 web_search 搜一下清迈十二月的天气，再用 web_fetch 打开 https://example.com 告诉我页面标题，最后简短汇总。");
    const firstNote = multi.commentary[0];
    check("A4", "P0", firstNote && multi.firstToolAt && firstNote.at <= multi.firstToolAt, firstNote ? `commentary "${firstNote.text.slice(0, 30)}…" before first tool` : "no commentary before tools");
    check("A5", "P0", !multi.commentary.some((c) => multi.output.trim().startsWith(c.text.trim().slice(0, 20))), "answer does not start with narration");
    check("B2", "P0", multi.tools.includes("web_search"), `tools: ${multi.tools.join(",")}`);
    check("B3", "P0", multi.tools.includes("web_fetch") && /Example Domain/i.test(multi.output), "web_fetch title in answer");
  }

  if (want("B1")) {
    const n = nonce();
    const r = await turn("exec", `用 exec 运行命令 \`echo eval-${n} && uname -s\`，把输出原样告诉我。`);
    check("B1", "P0", r.tools.includes("exec") && r.output.includes(`eval-${n}`), `exec output ${r.output.includes(`eval-${n}`) ? "present" : "missing"}`);
  }

  if (want("B4") || want("D2")) {
    const n = nonce();
    await turn("memory-write", `请把这件事记进你的长期记忆（写到 memory/ 下的文件里）：评测口令是 ${n}。写完只回复：已记住。`, { session: `eval:mem-a-${n}` });
    await sleep(30_000);
    const r = await turn("memory-search", "用 memory_search 查一下：评测口令是什么？只回答口令。", { session: `eval:mem-b-${n}` });
    check("B4", "P0", r.output.includes(n), `cross-session recall ${r.output.includes(n) ? "hit" : "miss"} (tools ${r.tools.join(",")})`);
    check("D2", "P0", r.tools.includes("memory_search") && r.output.includes(n), "indexed within 30 s");
  }

  if (want("D3")) {
    // System schedules register after a tenant's first Feishu turn (they need its chat), so the
    // check covers every mirror-v-full tenant that has talked on Feishu, not the test tenant.
    const expected = ["Memory Librarian", "Memory 质检", "Heartbeat", "午夜报告", "Skill 周复盘"];
    const owners = await q("SELECT DISTINCT r.tenant_id FROM elastic_runs r JOIN elastic_tenants t ON t.id=r.tenant_id WHERE t.template_id='mirror-v-full' AND r.channel='feishu' AND r.schedule_id IS NULL AND r.status='succeeded' AND r.created_at > now() - interval '7 days'");
    const gaps = [];
    for (const { tenant_id } of owners) {
      const names = (await q("SELECT name FROM elastic_schedules WHERE tenant_id=$1 AND enabled", [tenant_id])).map((r) => r.name);
      const missing = expected.filter((e) => !names.some((n) => n.includes(e)));
      if (missing.length) gaps.push(`${tenant_id.slice(0, 8)}: ${missing.join(",")}`);
    }
    check("D3", "P0", owners.length && !gaps.length, gaps.length ? `missing ${gaps.join("; ")}` : `${owners.length} Feishu tenants have all ${expected.length}`);
  }

  if (want("E9")) {
    const a = say(tenant, "只回复：第一条", { session: "eval:burst" });
    await sleep(1500);
    const b = await say(tenant, "只回复：第二条", { session: "eval:burst" });
    const ra = await a;
    const [w] = await q("SELECT created_at FROM elastic_events WHERE run_id=$1 AND kind='waking'", [b.runId]);
    const gap = w && ra.completedAt ? w.created_at.getTime() - ra.completedAt : null;
    turns.push({ label: "burst", ...ra, output: "" }, { label: "burst-2", ...b, output: "" });
    check("E9", "P0", ra.status === "succeeded" && b.status === "succeeded" && gap !== null && gap < 5000, `second started ${gap} ms after the first finished`);
  }

  if (want("B6")) {
    await turn("vds-on", "/model vds");
    const r = await turn("vds", "只回复：vds-ok");
    await turn("vds-off", "/model deepseek");
    const back = await turn("vds-back", "只回复：back-ok");
    check("B6", "P1", r.status === "succeeded" && /vds-ok/.test(r.output) && /back-ok/.test(back.output), `vds ${r.status}, back ${back.status}`);
  }
  if (want("B5")) {
    // The eval channel is text-only (no attachment delivery), so check the image was really made.
    const r = await turn("makaron", "用 makaron 生成一张简单的小猫插画，保存到工作区 artifacts/eval-cat 开头的文件里，最后只回复文件路径。", { timeoutMs: 900_000 });
    const file = r.output.match(/\/vercel\/sandbox\/\S+\.(?:png|jpe?g|webp)/i)?.[0] || r.output.match(/artifacts\/eval-cat\S*\.(?:png|jpe?g|webp)/i)?.[0];
    const size = file ? await exec(tenant, `stat -c %s "${file.startsWith("/") ? file : "/vercel/sandbox/agent-data/workspace/" + file}" 2>/dev/null || echo 0`).then((x) => Number(x.stdout)).catch(() => 0) : 0;
    check("B5", "P1", r.status === "succeeded" && size > 10_000, file ? `${file} ${size} bytes` : `no image path in answer (tools ${r.tools.join(",")})`);
  }
  if (want("B7")) {
    const r = await turn("subagents", "同时开 3 个子 agent 并行：分别用一句话介绍东京、首尔、曼谷，都完成后汇总。");
    check("B7", "P1", r.status === "succeeded" && /东京/.test(r.output) && /首尔/.test(r.output) && /曼谷/.test(r.output) && r.totalMs < 120000, `${r.totalMs} ms`);
  }
  if (want("B8")) {
    const r = await turn("computer", "用 computer 工具截一张屏，告诉我桌面上现在有什么。");
    check("B8", "P1", r.tools.includes("computer") && r.status === "succeeded", `tools ${r.tools.join(",")}`);
  }
  if (want("B9")) {
    const r = await turn("browser", "用 browser 工具打开 https://example.org ，告诉我页面标题。");
    check("B9", "P1", r.tools.includes("browser") && /Example Domain/i.test(r.output), `tools ${r.tools.join(",")}`);
  }

  if (want("E6")) {
    const pending = say(tenant, "用 exec 运行这一条命令并等它结束：sleep 40 && echo eval-done 。然后告诉我输出。", { session: "eval:kill" });
    // Kill while that 40 s command is running, so the turn is genuinely mid-way.
    const killDeadline = Date.now() + 120_000;
    for (;;) {
      await sleep(1000);
      const [r] = await q("SELECT id FROM elastic_runs WHERE tenant_id=$1 AND session_key=$2 ORDER BY created_at DESC LIMIT 1", [tenant, "agent:mirror-v-full:eval:kill"]);
      const n = r ? (await q("SELECT count(*) n FROM elastic_events WHERE run_id=$1 AND kind='tool-progress' AND data->>'phase'='start'", [r.id]))[0].n : 0;
      if (Number(n) >= 1 || Date.now() > killDeadline) break;
    }
    await sleep(5000);
    // SIGTERM would drain the turn gracefully; a crash is SIGKILL of the Gateway and its Workers.
    await exec(tenant, "kill -9 $(cat /tmp/nexus-gateway.pid) 2>/dev/null; pkill -9 -f worker/dist/worker.mjs; true").catch(() => {});
    const killed = await pending;
    const after = await turn("after-kill", "只回复：恢复正常", { session: "eval:kill" });
    const st = (await tenantRow(tenant)).state;
    check("E6", "P0", killed.status !== "succeeded" && after.status === "succeeded" && /恢复正常/.test(after.output) && st !== "blocked", `killed turn ${killed.status}/${killed.error}; next ${after.status}; tenant ${st}`);
    check("E12", "P1", after.wake && after.wake.reused === false, `Gateway cold start ${after.wake?.wakeMs} ms`);
  }

  // Turn-level invariants over everything this gate ran.
  const done = turns.filter((x) => x.status === "succeeded");
  const slowBackup = done.filter((x) => x.backupMs > 10000);
  check("E4", "P0", !slowBackup.length, slowBackup.length ? `${slowBackup.length} backups >10 s (max ${Math.max(...slowBackup.map((x) => x.backupMs))})` : `max backup ${Math.max(0, ...done.map((x) => x.backupMs || 0))} ms`);
  const backupFile = path.join(config.dataDir, "backups", `${tenant}.tgz`);
  if (fs.existsSync(backupFile)) check("E4b", "P0", fs.statSync(backupFile).size < 50 << 20, `backup ${Math.round(fs.statSync(backupFile).size / 2 ** 20)} MB`);
  const longTail = done.filter((x) => x.tailMs > 15000);
  check("E8", "P0", !longTail.length, longTail.length ? `tail ${longTail.map((x) => x.tailMs).join(",")} ms` : `max tail ${Math.max(0, ...done.map((x) => x.tailMs || 0))} ms`);
  const text = done.map((x) => x.output).join("\n") + done.flatMap((x) => x.commentary.map((c) => c.text)).join("\n");
  check("A6", "P1", cjkRatio(text) >= 0.3, `CJK ratio ${cjkRatio(text).toFixed(2)}`);
  const leaks = done.filter((x) => /no final summary|<think>|reasoning_content/i.test(x.output));
  check("A7", "P1", !leaks.length, leaks.length ? `leak in ${leaks.map((x) => x.label)}` : "clean");
  const failed = turns.filter((x) => x.status !== "succeeded" && x.label !== "burst");
  check("E0", "P0", !failed.length, failed.length ? `failed turns: ${failed.map((x) => `${x.label}:${x.error}`).join(",")}` : "all turns succeeded");

  // E10/E2 on the awake VM, then the sleep cycle.
  if (want("E10")) {
    const r = await exec(tenant, "cat /vercel/sandbox/nexus/runtime-revision.txt");
    check("E10", "P0", r.stdout === runtimeRevision(), "sandbox runs this release's scripts");
  }
  if (!flag("quick", false)) {
    const since = new Date();
    console.log("  · waiting for idle sleep (≤ 25 min)…");
    let slept = null, deferred = [];
    for (let i = 0; i < 75 && !slept; i++) {
      await sleep(20_000);
      const ev = await q("SELECT kind,data FROM elastic_events WHERE tenant_id=$1 AND created_at>$2 AND kind IN ('sleeping','idle-deferred','idle-stop-failed') ORDER BY seq", [tenant, since]);
      deferred = ev.filter((e) => e.kind !== "sleeping");
      slept = ev.find((e) => e.kind === "sleeping");
    }
    check("E1", "P0", slept && !deferred.length, slept ? `slept${deferred.length ? ` after ${deferred.length} deferrals: ${JSON.stringify(deferred[0].data)}` : ""}` : `did not sleep: ${JSON.stringify(deferred.at(-1)?.data ?? "no attempt")}`);
    const cold = await turn("cold", "只回复：醒了");
    check("A1", "P0", cold.status === "succeeded" && cold.wake && !cold.wake.reused && cold.wake.wakeMs < 35000, `cold wake ${cold.wake?.wakeMs} ms`);
    const pids = await exec(tenant, PID_CHECK);
    const dead = pids.stdout.split("\n").filter((l) => l.trim() && l.trim() !== "BOOT_OK" && !l.includes(" alive "));
    check("E2", "P0", pids.stdout.includes("BOOT_OK") && !dead.length, dead.length ? `not running: ${dead.join("; ")}` : "boot id current, all daemons alive");
  }

  const p0Failed = results.filter((r) => r.priority === "P0" && !r.pass);
  const summary = { at: new Date().toISOString(), tenant, release: path.basename(fs.realpathSync(RELEASE)), pass: !p0Failed.length, results, turns: turns.map(({ output, ...x }) => ({ ...x, commentary: x.commentary?.length })) };
  record("gate.jsonl", summary);
  console.log(`\n${summary.pass ? "GATE PASS" : "GATE FAIL"}: ${results.filter((r) => r.pass).length}/${results.length} passed; P0 failures: ${p0Failed.map((r) => r.id).join(",") || "none"}`);
  return summary.pass ? 0 : 2;
}

// ---------- L2 soak ----------

async function soak() {
  const tenant = flag("tenant", "mvfull-soak-01");
  if (!(await tenantRow(tenant))) {
    const { requireTemplate } = await import(`${DIST}/templates.js`);
    await store.createTenant(tenant, `回归耐久 ${tenant}`, "", "", "vercel", requireTemplate(config, "mirror-v-full"));
  }
  const { results, check, turns, turn } = makeCases(tenant);
  await turn("bootstrap", "你好，我是评测员。你就叫 Mirror V，主人叫评测员。然后把 V001 示范记忆导入进来做参考，完成后简短告诉我导入了什么。", { timeoutMs: 900_000 });
  const prompts = [
    "用一句话说说今天适合做什么。", "用 web_search 查一下今天的国际新闻头条，三条就行。", "把刚才的新闻要点记进今天的日志。",
    "用 memory_search 找找我们之前聊过什么。", "写一段 300 字的随笔，主题是秋天。", "用 exec 看一下磁盘使用情况，简短汇报。",
    "帮我列一个周末出游的待办清单。", "用 web_fetch 打开 https://example.com 告诉我标题。", "回顾一下今天我们做了哪些事。",
  ];
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const p of prompts) await turn(`c${cycle}`, p, { session: `eval:soak-${cycle % 2}` });
    const since = new Date();
    let slept = null, deferred = [];
    for (let i = 0; i < 75 && !slept; i++) {
      await sleep(20_000);
      const ev = await q("SELECT kind,data FROM elastic_events WHERE tenant_id=$1 AND created_at>$2 AND kind IN ('sleeping','idle-deferred','idle-stop-failed') ORDER BY seq", [tenant, since]);
      deferred = ev.filter((e) => e.kind !== "sleeping");
      slept = ev.find((e) => e.kind === "sleeping");
    }
    check(`E1.${cycle}`, "P0", slept && !deferred.length, slept ? "slept" : `no sleep: ${JSON.stringify(deferred.at(-1)?.data)}`);
    const cold = await turn(`wake${cycle}`, "只回复：醒了");
    check(`A1.${cycle}`, "P0", cold.status === "succeeded" && cold.wake?.wakeMs < 35000, `wake ${cold.wake?.wakeMs} ms`);
  }
  const pending = say(tenant, "依次用 web_search 搜三样东西：清迈美食、清迈夜市、清迈咖啡馆，每次之间都调用工具，最后汇总。", { session: "eval:soak-kill" });
  await sleep(9000);
  await exec(tenant, "kill -9 $(cat /tmp/nexus-gateway.pid) 2>/dev/null; pkill -9 -f worker/dist/worker.mjs; true").catch(() => {});
  await pending;
  const after = await turn("after-kill", "只回复：恢复正常", { session: "eval:soak-kill" });
  check("E6", "P0", after.status === "succeeded" && (await tenantRow(tenant)).state !== "blocked", `next ${after.status}`);

  const ok = turns.filter((x) => x.status === "succeeded" && x.label.startsWith("c"));
  const pct = (xs, p) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
  const metrics = {
    firstP50: pct(ok.map((x) => x.firstVisibleMs), 0.5), tailP90: pct(ok.map((x) => x.tailMs), 0.9),
    backupP90: pct(ok.map((x) => x.backupMs), 0.9), wakeP50: pct(turns.filter((x) => x.label.startsWith("wake")).map((x) => x.wake?.wakeMs), 0.5),
    failed: turns.filter((x) => x.status !== "succeeded" && x.label !== "c0").length,
  };
  const history = fs.existsSync(path.join(OUT, "soak.jsonl")) ? fs.readFileSync(path.join(OUT, "soak.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const last = history.at(-1)?.metrics;
  for (const key of ["firstP50", "tailP90", "backupP90", "wakeP50"])
    if (last?.[key] && metrics[key]) check(`R.${key}`, "P0", metrics[key] <= last[key] * 1.5, `${metrics[key]} vs last ${last[key]}`);
  check("R.failed", "P0", metrics.failed === 0, `${metrics.failed} failed turns`);
  const summary = { at: new Date().toISOString(), tenant, release: path.basename(fs.realpathSync(RELEASE)), metrics, pass: !results.some((r) => r.priority === "P0" && !r.pass), results };
  record("soak.jsonl", summary);
  console.log(JSON.stringify(summary.metrics), summary.pass ? "SOAK PASS" : "SOAK FAIL");
  return summary.pass ? 0 : 2;
}

const command = args[0];
try {
  const code = command === "health" ? await health() : command === "gate" ? await gate() : command === "soak" ? await soak() : (console.error("usage: eval.mjs health|gate|soak"), 1);
  await store.pool.end().catch(() => {});
  process.exit(code);
} catch (error) {
  console.error("EVAL_ERROR", error?.stack || error);
  process.exit(1);
}
