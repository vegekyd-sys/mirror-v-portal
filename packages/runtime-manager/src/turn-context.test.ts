import { describe, it, expect } from "vitest";
import { openclawChannel } from "./provider.js";

describe("openclaw channel mapping", () => {
  // The bug: no channel reached the runtime, so every turn looked like webchat
  // and the agent told a Feishu user it was on webchat with no media support.
  it("maps our channel ids to the runtime's", () => {
    expect(openclawChannel("feishu")).toBe("feishu");
    expect(openclawChannel("weixin")).toBe("weixin");
    expect(openclawChannel("wecom")).toBe("wecom");
    expect(openclawChannel("dingtalk")).toBe("dingtalk");
  });

  it("maps the browser trial to webchat, which is what it actually is", () => {
    expect(openclawChannel("web")).toBe("webchat");
  });

  it("passes an unknown channel through rather than silently mislabelling it", () => {
    expect(openclawChannel("whatsapp")).toBe("whatsapp");
  });

  it("stays undefined when there is no channel, so no header is sent", () => {
    expect(openclawChannel(undefined)).toBeUndefined();
    expect(openclawChannel("")).toBeUndefined();
  });
});
