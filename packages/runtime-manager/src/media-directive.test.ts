import { describe, it, expect } from "vitest";
import { parseReply, resolveRef, mediaKind } from "./media-directive.js";

describe("media directives", () => {
  // The bug: the agent generated a file, emitted MEDIA:, and the user saw the
  // directive as text with no attachment.
  it("lifts MEDIA: lines out of the reply", () => {
    const r = parseReply("图在这儿 👆\nMEDIA: makaron-demo.jpg");
    expect(r.text).toBe("图在这儿 👆");
    expect(r.media).toEqual([{ ref: "makaron-demo.jpg", remote: false }]);
  });

  it("accepts absolute sandbox paths and URLs", () => {
    const r = parseReply("MEDIA: /vercel/sandbox/agent-data/workspace/a.png\nMEDIA: https://cdn/x.mp4");
    expect(r.media).toEqual([
      { ref: "/vercel/sandbox/agent-data/workspace/a.png", remote: false },
      { ref: "https://cdn/x.mp4", remote: true },
    ]);
    expect(r.text).toBe("");
  });

  // Agents reach for markdown out of habit; the sentence must survive intact.
  it("keeps markdown images in the text but still delivers the file", () => {
    const r = parseReply("看这个 ![海报](poster.png) 怎么样");
    expect(r.text).toBe("看这个 ![海报](poster.png) 怎么样");
    expect(r.media).toEqual([{ ref: "poster.png", remote: false }]);
  });

  it("dedups and strips quoting agents add", () => {
    const r = parseReply('MEDIA: "a.png"\nMEDIA: a.png\nMEDIA: <a.png>');
    expect(r.media).toHaveLength(1);
    expect(r.media[0].ref).toBe("a.png");
  });

  it("leaves ordinary text untouched", () => {
    const text = "这段话提到 media: 但不是指令";
    expect(parseReply(text)).toEqual({ text, media: [] });
  });

  it("collapses the blank gap a removed directive leaves behind", () => {
    expect(parseReply("上文\n\nMEDIA: a.png\n\n下文").text).toBe("上文\n\n下文");
  });
});

describe("reference resolution", () => {
  it("resolves bare names against the workspace", () => {
    expect(resolveRef("a.png")).toBe("/vercel/sandbox/agent-data/workspace/a.png");
    expect(resolveRef("./a.png")).toBe("/vercel/sandbox/agent-data/workspace/a.png");
  });
  it("leaves absolute paths and URLs alone", () => {
    expect(resolveRef("/tmp/a.png")).toBe("/tmp/a.png");
    expect(resolveRef("https://x/a.png")).toBe("https://x/a.png");
  });
});

describe("media kind", () => {
  it("picks the upload API by extension", () => {
    expect(mediaKind("a.JPG")).toBe("image");
    expect(mediaKind("a.mp4")).toBe("video");
    expect(mediaKind("a.opus")).toBe("audio");
    expect(mediaKind("a.pdf")).toBe("file");
    expect(mediaKind("https://x/a.png?v=2")).toBe("image");
  });
});
