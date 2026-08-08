---
name: "volcano-voice-clone-workflow"
description: "Authorized voice cloning and Feishu voice delivery workflow"
---

# Volcano Voice Clone Workflow

## Purpose

Create and use an authorized cloned voice for a digital sales/persona assistant. This skill is abstract: it is not tied to Ye Minjie. It applies to any real person only when authorization is confirmed and the use case is legitimate.

## Safety and permission boundary

- Clone only voices with explicit authorization from the speaker or an authorized company representative.
- Do not use public videos alone to clone a person unless authorization is confirmed in the task context.
- Prefer a clean authorization recording or written authorization record, plus clean speech samples.
- Do not print or store API keys in chat, docs, repos, or skill files.
- If a key is exposed in a group chat, warn once and recommend rotating it after the task.
- Store only speaker IDs, log IDs, artifact paths, and safe operational notes in memory. Do not store raw signed URLs.

## Inputs

- Authorized speaker name and intended usage scope.
- 30–120 seconds of clean speech sample, ideally mono 24k WAV or high-quality MP3/M4A.
- Optional reference transcript/style samples for the speaker's rhetorical style.
- Desired custom speaker id, e.g. `person-project-v-YYYYMMDD`.

## Prepare audio sample

Use ffmpeg to create a clean, small training sample:

```bash
ffmpeg -y -hide_banner -loglevel error \
  -ss <start> -t 35 -i input.mp3 \
  -ac 1 -ar 24000 \
  -af 'loudnorm=I=-18:LRA=11:TP=-1.5' \
  work/voice/sample.wav
```

Validate:

```bash
ffprobe -v error -show_entries format=duration,size \
  -show_entries stream=codec_name,sample_rate,channels \
  -of json work/voice/sample.wav
```

## Credential and service activation

Data-plane training uses:

- Endpoint: `https://openspeech.bytedance.com/api/v3/tts/voice_clone`
- Header: `X-Api-Key`
- Header: `X-Api-Request-Id`

If training or query returns:

```text
45000030 [resource_id=volc.megatts.timbre] requested resource not granted
```

Do not keep asking the user to toggle console settings. Use the Volcano management API with IAM AK/SK to inspect/activate the resource when available.

Management-plane lesson from the verified 2026-06-27 run:

- `volc.service_type.10029` being active is not enough.
- Activate `volc.megatts.timbre` specifically.
- After activation, wait for permission propagation, then retry.

Pseudo-code:

```python
from volcenginesdkcore.configuration import Configuration
from volcenginesdkcore.api_client import ApiClient
from volcenginesdkspeechsaasprod.api.speech_saas_prod_api import SPEECHSAASPRODApi
import volcenginesdkspeechsaasprod.models as M

conf = Configuration()
conf.ak = os.environ['VOLCANO_ACCESS_KEY']
conf.sk = os.environ['VOLCANO_SECRET_KEY']
conf.region = 'cn-north-1'
conf.client_side_validation = False
api = SPEECHSAASPRODApi(ApiClient(conf))
api.activate_service(M.ActivateServiceRequest(
    project_name='default',
    resource_id='volc.megatts.timbre',
    _configuration=conf,
))
```

## Train cloned voice

Use custom postpaid speaker ids when possible:

```json
{
  "speaker_id": "custom_speaker_id",
  "custom_speaker_id": "person-project-v-YYYYMMDD",
  "audio": {
    "data": "<base64 wav/mp3/m4a>",
    "format": "wav"
  },
  "language": 0,
  "extra_params": {
    "demo_text": "试听文本，4 到 300 字。"
  }
}
```

Success criteria:

- HTTP 200
- `status` is `2` or `4`
- response includes `speaker_id`
- response may include `speaker_status[].demo_audio`; download quickly because demo URLs expire.

## Synthesize with cloned speaker

For cloned voices, use Volcano v3 unidirectional TTS, not the old v1 `/api/v1/tts` cluster-only path.

Verified path:

- Endpoint: `https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- Header `X-Api-Resource-Id: seed-icl-2.0`
- Payload field `req_params.speaker = <clone speaker id>`

The non-SSE endpoint may return newline-delimited JSON chunks. Parse line by line, collect all `data` base64 chunks, concatenate, decode to MP3.

Pseudo-code:

```python
payload = {
  "user": {"uid": "voice-clone"},
  "req_params": {
    "text": text,
    "speaker": speaker_id,
    "audio_params": {"format": "mp3", "sample_rate": 24000}
  }
}
headers = {
  "Content-Type": "application/json",
  "X-Api-Key": api_key,
  "X-Api-Resource-Id": "seed-icl-2.0",
  "X-Api-Request-Id": str(uuid.uuid4())
}
resp = requests.post("https://openspeech.bytedance.com/api/v3/tts/unidirectional", headers=headers, json=payload)
chunks = []
for line in resp.text.splitlines():
    event = json.loads(line)
    if event.get("data"):
        chunks.append(event["data"])
Path(out_mp3).write_bytes(base64.b64decode("".join(chunks)))
```

## Feishu voice bubble delivery

When the user asks for voice in Feishu, prefer sending it as a voice/audio bubble rather than a generic file attachment.

- Generate MP3 first.
- If Feishu voice bubble requires a specific format in the active runtime, convert to OGG/Opus as fallback:

```bash
ffmpeg -y -i input.mp3 -c:a libopus -ar 48000 -b:a 32k output.ogg
```

- Use the messaging tool's voice/audio delivery option when available, e.g. `asVoice: true` / voice-note delivery, rather than `forceDocument: true`.
- Only fall back to file attachment if bubble delivery fails; report the fallback.

## Match voice style, not only timbre

Before generating speech text, inspect ASR/scripts from the speaker and extract rhetorical patterns.

For Ye Minjie-style sales answers, use this pattern:

1. One-line field observation: “我刚看完/刚跑完/刚跟买家聊完……”
2. Reframe the buyer/seller pain: “问题不是 X，而是 Y。”
3. Name a concept: “这叫双主场 / 三三四 / 信任资产 / 承接池。”
4. Give concrete actions: 2–4 steps the seller can do before/during/after the show.
5. End with a conversion hook: “把产品/国家/客户发我，我帮你拆。”

Avoid generic AI consultant tone. The answer should sound like an experienced frontline sales director: specific, direct, example-driven, and action-oriented.

## Verification checklist

- Authorization confirmed.
- Audio sample validated.
- `volc.megatts.timbre` activated if needed.
- Voice clone response status is 2 or 4.
- Speaker id saved in a safe memory/project note.
- TTS synthesis with `seed-icl-2.0` produces a playable MP3 verified by `ffprobe`.
- Feishu delivery uses voice bubble when requested.
- Final spoken text reflects the target speaker's method/style, not only their timbre.
