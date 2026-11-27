import { randomUUID } from "node:crypto";

/**
 * Voice messages as text for the agent, the same service V uses for its inbound voice
 * (Volcengine BigASR Flash, "录音文件识别极速版": one synchronous request, audio sent inline as
 * base64). Feishu voice is Opus in Ogg. The key lives only in the Portal's private config
 * (`volcengineAsr.apiKey`), goes in a header and never into a URL, a log or the sandbox.
 * A failure never blocks the turn: the agent still gets the audio file.
 */
export interface TranscribeOptions {
  apiKey: string;
  /** Volcengine resource id; V uses the flash ("auc_turbo") resource. */
  resourceId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
export const VOLCENGINE_FLASH_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
export const DEFAULT_RESOURCE_ID = "volc.bigasr.auc_turbo";
const OK = "20000000";
const FORMATS: Record<string, string> = { "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/wav": "wav" };

export async function transcribeAudio(audio: Buffer, mimeType: string, o: TranscribeOptions): Promise<string> {
  if (!o.apiKey) throw Error("TRANSCRIBE_NO_KEY");
  const format = FORMATS[mimeType];
  if (!format) throw Error("TRANSCRIBE_FORMAT_UNSUPPORTED");
  const resourceId = o.resourceId || DEFAULT_RESOURCE_ID;
  if (!/^[a-z0-9._-]{1,64}$/.test(resourceId)) throw Error("TRANSCRIBE_RESOURCE_INVALID");
  const response = await (o.fetchImpl ?? fetch)(VOLCENGINE_FLASH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": o.apiKey,
      "x-api-resource-id": resourceId,
      "x-api-request-id": randomUUID(),
      "x-api-sequence": "-1",
    },
    // Same request as V's openclaw-inbound-volcano-asr.sh (lib/build_request.py).
    body: JSON.stringify({
      user: { uid: "mirror-v-portal" },
      audio: { data: audio.toString("base64"), format },
      request: { model_name: "bigmodel", enable_itn: true, enable_punc: false, enable_ddc: false, show_utterances: false, enable_speaker_info: false },
    }),
    signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
  });
  // The service reports its own status in a header; HTTP 200 alone is not success.
  const status = response.headers.get("x-api-status-code");
  if (!response.ok) throw Error(`TRANSCRIBE_HTTP_${response.status}`);
  if (status !== OK) throw Error(/^\d{1,12}$/.test(status ?? "") ? `TRANSCRIBE_STATUS_${status}` : "TRANSCRIBE_STATUS_MISSING");
  const body: any = await response.json();
  const text = typeof body?.result?.text === "string" ? body.result.text.trim() : "";
  if (!text) throw Error("TRANSCRIBE_EMPTY");
  return text.slice(0, 8000);
}
