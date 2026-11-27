import { expect, test, vi } from "vitest";
import { transcribeAudio } from "./audio-transcribe.js";

test("the key goes in a header, never the URL; the transcript is the model's text", async () => {
  const fetchImpl = vi.fn(async (_url: any, _init: any) => new Response(JSON.stringify({candidates: [{content: {parts: [{text: " 你好 "}]}}]}), {status: 200}));
  await expect(transcribeAudio(Buffer.from("OggS"), "audio/ogg", {apiKey: "k-secret", fetchImpl: fetchImpl as any})).resolves.toBe("你好");
  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).not.toContain("k-secret");
  expect(init.headers["x-goog-api-key"]).toBe("k-secret");
  expect(JSON.parse(init.body).contents[0].parts[1].inline_data.mime_type).toBe("audio/ogg");
  await expect(transcribeAudio(Buffer.from("OggS"), "audio/ogg", {apiKey: "k", fetchImpl: (async () => new Response("{}", {status: 429})) as any})).rejects.toThrow("TRANSCRIBE_HTTP_429");
  await expect(transcribeAudio(Buffer.from("OggS"), "audio/ogg", {apiKey: ""})).rejects.toThrow("TRANSCRIBE_NO_KEY");
});
