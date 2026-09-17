import { describe, it, expect } from "vitest";
import { isSilentReply, mayBecomeSilent } from "./reply-sentinel.js";

describe("silent reply markers", () => {
  // The bug this guards: a group message the agent chose not to answer was
  // delivered as the literal text "NO_REPLY".
  it("treats NO_REPLY as silence on any turn, not only heartbeats", () => {
    expect(isSilentReply("NO_REPLY")).toBe(true);
    expect(isSilentReply("NO_REPLY")).toBe(true);
    expect(isSilentReply(" NO_REPLY \n")).toBe(true);
    expect(isSilentReply("NO_REPLY.")).toBe(true);
    expect(isSilentReply("NO_REPLY。")).toBe(true);
  });

  it("keeps HEARTBEAT_OK scoped to heartbeats", () => {
    expect(isSilentReply("HEARTBEAT_OK", "heartbeat")).toBe(true);
    expect(isSilentReply("HEARTBEAT_OK")).toBe(false);
    expect(isSilentReply("HEARTBEAT_OK", "cron")).toBe(false);
  });

  it("never swallows a real reply that merely mentions a marker", () => {
    expect(isSilentReply("NO_REPLY 是什么意思？")).toBe(false);
    expect(isSilentReply("我不回复")).toBe(false);
    expect(isSilentReply("收到，能回。")).toBe(false);
    expect(isSilentReply("")).toBe(false);
  });
});

describe("streaming hold-back", () => {
  // Streaming publishes as text arrives, so a prefix must be withheld until it
  // is clear the text is not resolving into a marker.
  it("withholds prefixes of a marker", () => {
    for (const partial of ["N", "NO", "NO_", "NO_REP", "NO_REPLY", "H", "HEART", "HEARTBEAT_OK"])
      expect(mayBecomeSilent(partial)).toBe(true);
  });

  it("releases as soon as the text cannot be a marker", () => {
    expect(mayBecomeSilent("NO_REPLY 但是")).toBe(false);
    expect(mayBecomeSilent("NOTE: ")).toBe(false);
    expect(mayBecomeSilent("你好")).toBe(false);
    expect(mayBecomeSilent("Hi")).toBe(false);
  });

  it("withholds empty text so an empty card is never published", () => {
    expect(mayBecomeSilent("")).toBe(true);
    expect(mayBecomeSilent("   ")).toBe(true);
  });
});
