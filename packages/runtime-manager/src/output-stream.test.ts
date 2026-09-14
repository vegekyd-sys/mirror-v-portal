import { test, expect } from "vitest";
import { Writable } from "node:stream";
import { finishOutput } from "./provider.js";
test("waits for all asynchronous stream callbacks after remote command completion", async () => {
  const seen: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      setTimeout(() => {
        seen.push(chunk.toString());
        callback();
      }, 10);
    },
  });
  sink.write("首字");
  sink.write("后续");
  sink.write("response.completed");
  expect(seen).toEqual([]);
  await finishOutput(sink);
  expect(seen).toEqual(["首字", "后续", "response.completed"]);
});
