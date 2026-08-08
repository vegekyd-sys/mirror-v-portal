---
name: "makaron-remotion-materialize"
description: "Makaron Remotion JSON 转 MP4 流程"
---

# Makaron Remotion Materialize

## Trigger
Use this when Makaron Chat or another Makaron workflow produces an animated design / Remotion composition JSON and the agent needs a customer-ready MP4.

## Core rule
If a valid animated design JSON already exists, do **not** start another Chat run and do **not** render locally by default. First use the Makaron CLI materialize path.

## Preferred commands

```bash
makaron materialize \
  --project <projectId> \
  --design-json <composition.json|-> \
  --wait \
  --no-publish \
  --profile fast_720p \
  --json
```

Simple URL output:

```bash
makaron materialize --project <projectId> --design-json composition.json --wait --no-publish --pick url
```

stdin:

```bash
cat composition.json | makaron materialize --project <projectId> --design-json - --wait --no-publish --pick url
```

## Publish behavior
- Use `--no-publish` for tests, QC renders, or avoiding duplicate project media.
- Use `--publish` when the MP4 should be added back to the project timeline / visible card workflow.

## JSON contract
The input is Makaron design JSON, not a raw `.tsx` Remotion project. Typical shape:

```json
{
  "code": "function Composition(props) { ... }",
  "width": 1920,
  "height": 1080,
  "animation": { "fps": 30, "durationInSeconds": 40 },
  "props": {}
}
```

Local TSX can be adapted into this schema, but the CLI expects Makaron-compatible design JSON.

## Verification
Run ffprobe on the returned URL or local file:

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries format=duration,size:stream=width,height,r_frame_rate,codec_name \
  -of json <url-or-file>
```

Check CLI JSON:
- `status == completed`
- `url` / `storageUrl` exists
- `duration_seconds`, `render_seconds`, `realtime_ratio`
- `width`, `height`, `fps`
- `error == null`

## Repair policy
- Materialize first when Chat already produced a valid animated design JSON.
- Restart/repair Chat only when materialize fails or visual QC fails.
- If multiple compositions exist, inspect project media and choose the intended composition index or snapshot before exporting.

## Validated example

```bash
makaron materialize \
  --project c22ad235-4efd-4ef6-8904-1fb1347e2f6b \
  --design-json work/versa-intro-0630/json-materialize-test/versa-remotion-design.json \
  --wait \
  --no-publish \
  --profile fast_720p \
  --json
```

Observed:
- job: `c8229195-ff29-40ce-89f0-de5e302bf974`
- 40s MP4
- 1280x720 / 30fps / H.264
- render_seconds: 32.711
- ffprobe duration: 40.000s
