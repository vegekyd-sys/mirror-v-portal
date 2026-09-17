/**
 * Markers the agent emits to mean "say nothing at all".
 *
 * The payload instructs the agent to answer `NO_REPLY` when group-chat rules
 * say it should stay silent, or when it already delivered the result through
 * another surface and a text reply would duplicate it. Those are instructions
 * to the runtime, not content: delivering them verbatim is how a silent turn
 * turns into the agent literally saying "NO_REPLY" in the chat.
 *
 * `HEARTBEAT_OK` is the same idea for scheduled heartbeats, and stays scoped
 * to them — outside a heartbeat it is ordinary text and should be delivered.
 */
const NO_REPLY = /^NO_REPLY[.!。\s]*$/;
const HEARTBEAT_OK = /^HEARTBEAT_OK[.!。\s]*$/;
const PREFIXES = ["NO_REPLY", "HEARTBEAT_OK"];

export function isSilentReply(text: string, scheduleKind?: string | null): boolean {
  const trimmed = text.trim();
  if (NO_REPLY.test(trimmed)) return true;
  return scheduleKind === "heartbeat" && HEARTBEAT_OK.test(trimmed);
}

/**
 * True while a partial stream could still resolve into a silent marker.
 *
 * Streaming publishes as text arrives, so by the time `NO_REPLY` is complete it
 * would already be on screen. Withholding any prefix of a marker costs at most
 * one flush of latency for real replies that happen to start with those
 * letters, and avoids showing text that is meant to be swallowed.
 */
export function mayBecomeSilent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return PREFIXES.some((p) => p.startsWith(trimmed) || new RegExp(`^${p}[.!。\\s]*$`).test(trimmed));
}
