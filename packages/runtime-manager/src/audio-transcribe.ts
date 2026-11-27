/**
 * Voice messages as text for the agent. Feishu voice is Opus in Ogg; Gemini takes it inline.
 * The key is the template's own GOOGLE_API_KEY (the one memory embeddings already use), sent as
 * a header, never in the URL. A failure never blocks the turn: the agent still gets the file.
 */
export interface TranscribeOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
export const DEFAULT_TRANSCRIBE_MODEL = "gemini-2.5-flash";
const PROMPT = "把这段语音逐字转写成文字。只输出转写内容，不加解释；听不清的地方写（听不清）；没有人声就输出（没有人声）。";

export async function transcribeAudio(audio: Buffer, mimeType: string, o: TranscribeOptions): Promise<string> {
  if (!o.apiKey) throw Error("TRANSCRIBE_NO_KEY");
  const model = o.model || DEFAULT_TRANSCRIBE_MODEL;
  if (!/^[a-z0-9.-]{1,64}$/.test(model)) throw Error("TRANSCRIBE_MODEL_INVALID");
  const response = await (o.fetchImpl ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {"content-type": "application/json", "x-goog-api-key": o.apiKey},
    body: JSON.stringify({
      contents: [{role: "user", parts: [{text: PROMPT}, {inline_data: {mime_type: mimeType, data: audio.toString("base64")}}]}],
      generationConfig: {temperature: 0},
    }),
    signal: AbortSignal.timeout(o.timeoutMs ?? 45_000),
  });
  if (!response.ok) throw Error(`TRANSCRIBE_HTTP_${response.status}`);
  const body: any = await response.json();
  const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
  if (!text) throw Error("TRANSCRIBE_EMPTY");
  return text.slice(0, 8000);
}
