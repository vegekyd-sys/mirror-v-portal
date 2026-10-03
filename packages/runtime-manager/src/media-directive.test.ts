import { describe, it, expect } from "vitest";
import { FinalMediaCollector, parseReply, resolveRef, mediaKind } from "./media-directive.js";

describe("OpenResponses final media side channel", () => {
  it("accepts only the current response's final refs and deduplicates repeats", () => {
    const collector = new FinalMediaCollector();
    collector.accept({type:"response.created",response:{id:"resp-current"}});
    for (const [runId,phase] of [["resp-other","final"],["resp-current","commentary"]])
      expect(collector.accept({type:"nexus.media",runId,phase,mediaUrls:["old.jpg"]})).toBe(false);
    expect(collector.accept({type:"nexus.media",runId:"resp-current",phase:"final",mediaUrls:["new.jpg","new.jpg"]})).toBe(true);
    expect(collector.accept({type:"nexus.media",runId:"resp-current",phase:"final",mediaUrls:["new.jpg"]})).toBe(false);
    expect(collector.media).toEqual([]);
    collector.accept({type:"response.completed",response:{id:"resp-current",status:"completed"}});
    expect(collector.media).toEqual([{ref:"new.jpg",remote:false}]);
  });
  it("does not deliver announced media after a failed or foreign completed event", () => {
    for (const response of [{id:"resp-current",status:"failed"},{id:"resp-other",status:"completed"}]) {
      const collector=new FinalMediaCollector();
      collector.accept({type:"response.created",response:{id:"resp-current"}});
      collector.accept({type:"nexus.media",runId:"resp-current",phase:"final",mediaUrls:["new.jpg"]});
      collector.accept({type:"response.completed",response});
      expect(collector.media).toEqual([]);
    }
  });
  it("rejects unbound, malformed and oversized announcements", () => {
    const collector = new FinalMediaCollector();
    const event={type:"nexus.media",runId:"resp-current",phase:"final",mediaUrls:["new.jpg"]};
    expect(collector.accept(event)).toBe(false);
    collector.accept({type:"response.created",response:{id:"resp-current"}});
    for (const mediaUrls of [["x\nMEDIA: secret.txt"],["x\0.jpg"],[null],Array(21).fill("x.jpg"),["x".repeat(8001)]])
      expect(collector.accept({...event,mediaUrls})).toBe(false);
    expect(collector.media).toEqual([]);
  });
});

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
