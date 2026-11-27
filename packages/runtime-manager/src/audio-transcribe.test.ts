import { expect, test, vi } from "vitest";
import { transcribeAudio, VOLCENGINE_FLASH_URL } from "./audio-transcribe.js";

const ok = (body: unknown, status = "20000000") => new Response(JSON.stringify(body), { status: 200, headers: { "x-api-status-code": status } });

test("Volcengine flash: the key goes in a header, never the URL; the transcript is result.text", async () => {
  const fetchImpl = vi.fn(async (_url: any, _init: any) => ok({ result: { text: " 你好 " } }));
  await expect(transcribeAudio(Buffer.from("OggS"), "audio/ogg", { apiKey: "k-secret", fetchImpl: fetchImpl as any })).resolves.toBe("你好");
  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe(VOLCENGINE_FLASH_URL);
  expect(String(url)).not.toContain("k-secret");
  expect(init.headers["x-api-key"]).toBe("k-secret");
  expect(init.headers["x-api-resource-id"]).toBe("volc.bigasr.auc_turbo");
  const body = JSON.parse(init.body);
  expect(body.audio).toEqual({ data: Buffer.from("OggS").toString("base64"), format: "ogg" });
  expect(body.request.model_name).toBe("bigmodel");
});

test("a service status other than 20000000 is a failure even with HTTP 200", async () => {
  await expect(transcribeAudio(Buffer.from("OggS"), "audio/ogg", { apiKey: "k", fetchImpl: (async () => ok({}, "45000151")) as any })).rejects.toThrow("TRANSCRIBE_STATUS_45000151");
  await expect(transcribeAudio(Buffer.from("OggS"), "audio/ogg", { apiKey: "k", fetchImpl: (async () => ok({ result: { text: "" } })) as any })).rejects.toThrow("TRANSCRIBE_EMPTY");
  await expect(transcribeAudio(Buffer.from("OggS"), "audio/ogg", { apiKey: "k", fetchImpl: (async () => new Response("{}", { status: 429 })) as any })).rejects.toThrow("TRANSCRIBE_HTTP_429");
  await expect(transcribeAudio(Buffer.from("OggS"), "audio/ogg", { apiKey: "" })).rejects.toThrow("TRANSCRIBE_NO_KEY");
  await expect(transcribeAudio(Buffer.from("x"), "audio/flac", { apiKey: "k" })).rejects.toThrow("TRANSCRIBE_FORMAT_UNSUPPORTED");
});
