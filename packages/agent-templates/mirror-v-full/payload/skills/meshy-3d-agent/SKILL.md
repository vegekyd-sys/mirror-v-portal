---
name: "meshy-3d-agent"
description: "Upgrade Meshy 3D asset generation with rig-ready source prep, chained tasks, canonical asset packets, and animation IDs."
license: MIT-0
compatibility: Requires Python 3 with requests package. Compatible with OpenClaw and all Agent Skills tools.
metadata:
  openclaw:
    primaryEnv: MESHY_API_KEY
    requires:
      env:
        - MESHY_API_KEY
      bins:
        - python3
        - curl
    install:
      - kind: uv
        package: requests
allowed-tools: Bash, Write, Read
---

# Meshy 3D — Asset Generation, Rigging, Animation

Directly communicate with the Meshy AI API to generate 3D assets from text or images, export GLB/USDZ/FBX, remesh, rig characters, create animations, and package outputs for web/AR/showcase handoff.

This skill owns the **3D asset generation layer**. Pair it with `3d-asset-ar-showcase` when the user also wants a polished web/iPhone AR preview page.

## Security manifest

- Environment variable: `MESHY_API_KEY` sent only as `Authorization: Bearer` to `https://api.meshy.ai`.
- Never log or repeat the full key.
- Key lookup: current environment first, then current working directory `.env` only.
- Prefer private OpenClaw secret storage / SecretRef over repo `.env` for persistent keys.
- Write generated files under `./meshy_output/` and copied canonical asset packets under explicit project asset directories when requested.

## First-use session notice

When first activated in a session, tell the user once:

> Meshy outputs will be saved under `meshy_output/` in this workspace. Each project gets its own folder with model files, metadata, task JSON, and checksums when available.

## Credit / permission rule

Before paid task creation, present the expected credit cost and wait for confirmation unless the owner has just explicitly asked to run the exact paid generation and the cost is low. Still report actual credits / generated tasks afterward.

Approximate cost map:

| Task | Endpoint | Typical credits |
|---|---|---:|
| text-to-3D preview/refine | `/openapi/v2/text-to-3d` | 5–20 + 10 |
| image-to-3D | `/openapi/v1/image-to-3d` | 5–30 |
| multi-image-to-3D | `/openapi/v1/multi-image-to-3d` | 5–30 |
| remesh / format conversion | `/openapi/v1/remesh` | 5 |
| rigging | `/openapi/v1/rigging` | 5 |
| custom animation | `/openapi/v1/animations` | 3 |

Rigging typically returns walking/running animations automatically. Use custom animation only for additional actions.

## Core lesson: choose pipeline by intended use

### If the user needs a static object/product

Use image/text → 3D → GLB/USDZ/FBX → optional remesh → handoff to showcase.

### If the user needs an animated character

Do **not** treat any nice-looking image as enough. First optimize source images for rigging:

- strict T-pose or A-pose;
- front/side/back consistency;
- full body visible, no cropping;
- arms separated from body;
- legs separated enough for clean segmentation;
- hands/feet visible;
- no props crossing limbs unless needed;
- clean background;
- avoid labels/text/watermarks; crop them before Meshy.

The V avatar v2 pipeline succeeded better because it used a strict T-pose three-view before Meshy, then remesh, then rigging.

## Recommended character asset pipeline

1. **Source prep**
   - Use Makaron or another image tool to create a rig-friendly front/side/back T-pose sheet.
   - QC for pose, consistency, limb separation, full body, and label/text pollution.
   - Crop each view into clean separate images if needed.
2. **Multi-image-to-3D**
   - Use `/openapi/v1/multi-image-to-3d` with front/side/back images.
   - Request GLB and USDZ when supported.
   - Download all available model URLs.
3. **Remesh**
   - Use `/openapi/v1/remesh` before rigging when face count/topology may be too high.
   - Request GLB/USDZ/FBX.
   - For character rigging, target a reasonable polycount such as ~150k unless a different production target is specified.
4. **Rigging**
   - Use `/openapi/v1/rigging` on the remeshed task/model.
   - Download rigged GLB and built-in walking/running outputs.
5. **Custom animations**
   - Use `/openapi/v1/animations` with the rigging task id and selected `action_id`.
   - Download GLB/FBX outputs.
6. **Package canonical asset**
   - Copy selected files into a project asset directory such as `assets/<project>/<date>-<slug>/`.
   - Include source images, generated models, task JSON, metadata, README, and SHA256SUMS.
7. **Handoff**
   - If user wants preview/AR, invoke or recommend `3d-asset-ar-showcase`.

## Action library notes from V avatar work

Useful known actions:

| action_id | Name | Notes |
|---:|---|---|
| 11 | `Idle_02` | quiet idle |
| 27 | `Big_Heart_Gesture` | 比心 |
| 28 | `Big_Wave_Hello` | waving hello |
| 36 | `Confused_Scratch` | hesitation / confused idle |
| 44 | `Happy_jump_f` | happy jump |
| 366 | `falling_down` | natural daily-action fall; preferred first for cute character |
| 502–505 | `Fall1`–`Fall4` | falling freely variants |
| 180–188, 190 | combat/dying falls | avoid for cute characters unless explicitly requested |

When searching for a new action, query Meshy's Animation Library Reference and choose the least violent / most character-appropriate action first.

## API execution pattern

Use one Python script per multi-step run. It should:

- load key safely;
- check balance;
- create tasks;
- poll with backoff;
- tolerate 99% finalization delays;
- download outputs with streaming;
- write task JSON and metadata;
- save SHA256 checksums;
- print project directory and generated file paths.

Do not scatter generated files. Do not stop after stage 1 when the user asked for a chain.

## Project directory standard

Under `meshy_output/`:

```text
meshy_output/YYYYMMDD_HHMMSS_<slug>/
├── metadata.json
├── task-<id>.json
├── model.glb
├── model.usdz
├── model.fbx
├── rigged.glb
├── walking.glb
├── running.glb
└── action-*.glb/fbx
```

When promoting to canonical assets:

```text
assets/<project>/<YYYYMMDD>-<slug>/
├── README.md
├── SHA256SUMS.txt
├── source-crops/
├── *.glb
├── *.usdz
├── *.fbx
└── task-*.json / metadata.json
```

## Metadata / README requirements

For durable asset packets, include:

- source prompt/reference summary;
- all task IDs and endpoints;
- generation date;
- chosen canonical/default file;
- use guidance: web GLB, iPhone AR USDZ, rigged GLB, action GLBs;
- known caveats;
- action IDs and action names;
- checksum file.

## Known limitations

- iPhone Quick Look USDZ preview is static unless animated USDZ has been separately validated.
- Meshy animation outputs are usually GLB/FBX; do not promise iPhone AR animation without testing a USD conversion pipeline.
- Auto-rig quality depends heavily on source pose and topology. If deformation persists after T-pose/remesh, switch to semi-manual rig/weight correction rather than burning repeated auto-rig attempts.
- For generated image sheets, crop out labels and text before 3D generation; they can become texture noise.

## Chained workflow handoff

If Meshy is stage 2+ of a larger flow, preserve the chain state:

- upstream image/task path;
- Meshy project directory;
- generated files;
- next recommended skill (`3d-asset-ar-showcase`, Blender cleanup, etc.);
- blockers/caveats.

Makaron card workers may mark `expected=image` as complete after image generation. If the user actually asked for image → 3D → rig/preview, the orchestrator must continue after Makaron output rather than treating image completion as task completion.

## Validation checklist

Before saying done:

- [ ] key loaded without exposing full value;
- [ ] balance checked or cost reported;
- [ ] task JSON saved;
- [ ] generated files downloaded;
- [ ] model files have plausible sizes;
- [ ] GLB structure checked when relevant: meshes / skins / animations;
- [ ] USDZ exists for AR if requested;
- [ ] README/metadata written for durable assets;
- [ ] handoff to preview/deploy skill completed or clearly stated as next step.
