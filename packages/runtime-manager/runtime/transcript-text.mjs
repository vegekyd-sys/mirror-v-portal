// Print the assistant text the agent wrote to its transcript since a time, as JSON.
// Used only to repair stream text that came out with U+FFFD (see src/text-repair.ts):
// the transcript holds the harness's final messages, the stream holds its deltas.
// Usage: node transcript-text.mjs <sinceMs>   (NEXUS_AGENT_ID picks the agent)
import { createRequire } from "node:module";
const since = Number(process.argv[2]) || 0;
const agent = process.env.NEXUS_AGENT_ID || "mirror-v-full";
const db = `${process.env.NEXUS_STATE_ROOT || "/vercel/sandbox/agent-data/state"}/agents/${agent}/agent/openclaw-agent.sqlite`;
const texts = [];
try {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const live = new DatabaseSync(db, { readOnly: true });
  try {
    for (const { event_json } of live.prepare("SELECT event_json FROM transcript_events WHERE created_at >= ? ORDER BY created_at, seq LIMIT 500").all(since)) {
      let event; try { event = JSON.parse(event_json); } catch { continue; }
      const message = event?.message;
      if (event?.type !== "message" || message?.role !== "assistant") continue;
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
      for (const part of content) if (part?.type === "text" && typeof part.text === "string" && part.text) texts.push(part.text);
    }
  } finally { live.close(); }
} catch {}
process.stdout.write(JSON.stringify({ text: texts.join("\n\n").slice(0, 400000) }));
