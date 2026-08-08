---
name: "3d-asset-ar-showcase"
description: "Upgrade 3D/AR showcase pages with asset manifests, animation rails, mobile AR QA, and handoff rules."
license: MIT-0
compatibility: OpenClaw workspace with shell, Vercel CLI/token when deployment is requested.
metadata:
  openclaw:
    requires:
      bins:
        - python3
        - curl
        - node
        - vercel
allowed-tools: Read, Write, Edit, Bash
---

# 3D Asset AR Showcase

Create a polished, mobile-first web showcase for 3D assets, especially GLB/USDZ models generated from Meshy, Makaron, Blender, or other 3D pipelines. This skill owns the **presentation / preview / AR delivery layer**, not the generation layer.

The output is usually a static/Vercel-compatible page with:

- desktop/mobile `model-viewer` preview;
- iPhone Safari USDZ Quick Look button;
- downloadable GLB/USDZ/FBX files;
- source/reference image display;
- model-version picker;
- animated GLB action picker;
- loading progress based on a local byte manifest;
- provenance and QA notes;
- deployment verification.

## When to use

Use when the user wants to:

- 展示 3D 模型 / 3D 资产 / AR 小人 / AR 商品;
- put a GLB/USDZ model on a webpage;
- preview a model in iPhone Safari AR / Quick Look;
- deploy a 3D asset page to Vercel;
- compare multiple model versions, e.g. original / retexture / remesh / rigged;
- present animated GLB variants, e.g. walking / running / wave / heart / fall;
- package a 3D asset with source reference image, generation notes, downloads, and mobile QA.

Do **not** use this skill to create the 3D model itself. Pair with `meshy-3d-agent` or another generation skill for asset creation.

## Core lessons from V avatar / SkillHub pilots

1. Separate **static AR preview** from **web animation playback**:
   - iPhone Safari Quick Look needs USDZ.
   - Meshy skeletal animations are usually GLB/FBX.
   - Unless animated USDZ has been separately validated, state clearly: AR is static USDZ; web actions are GLB animations.
2. Make the page honest about boundaries:
   - static USDZ AR preview;
   - animated GLB in browser;
   - animated USDZ not guaranteed.
3. For animation variants, the rigged base model may not visibly animate by itself. The action GLB must be selected and `model-viewer` should auto-play the first available animation.
4. If model/action scales differ, use per-item `scale` and record why. In the first V Chibi pilot, old animation GLBs needed scale compensation; the T-pose v2 chain avoided much of that.
5. Always store model byte sizes in a local JS manifest. CDN/browser `Content-Length` can be unavailable.
6. Verify deployment by checking page and asset URLs, not just Vercel success.

## Inputs

Minimum:

- one web GLB;
- one USDZ for iPhone/iPad Safari AR Quick Look.

Recommended:

- thumbnail or source image;
- asset title and short description;
- source/reference image(s);
- model variants: original, retexture, remesh, rigged, compressed;
- animated GLB variants: walking, running, wave, heart, fall, etc.;
- default/canonical model choice;
- asset manifest: filenames, byte sizes, generation provenance, known caveats;
- target deployment slug/domain.

## Output directory

Use a clean static directory such as:

```text
demos/<slug>/
├── index.html
├── vercel.json
├── images/
│   ├── thumbnail.png
│   └── source.jpg
└── models/
    ├── asset-remesh.glb
    ├── asset-remesh.usdz
    ├── asset-rigged.glb
    ├── asset-walking.glb
    └── asset-heart.glb
```

## Procedure

### 1. Collect and normalize assets

1. Create `demos/<slug>/`.
2. Copy GLB/USDZ/FBX into `models/` using stable names.
3. Copy thumbnail/source images into `images/`.
4. Name variants clearly: `asset-original`, `asset-retexture`, `asset-remesh`, `asset-rigged`, `asset-walking`, `asset-heart`, etc.
5. Run `ls -lh models images` and record file sizes.
6. Put exact GLB/USDZ byte sizes into a JS data model as `bytes`.
7. Choose a default:
   - for identity/showcase continuity, default to canonical/original;
   - for mobile AR and rig-ready testing, default to remesh/T-pose/optimized asset;
   - state the reason in page copy or notes.

### 2. Build the static page

Use one static `index.html` unless the user requests a framework.

Required page elements:

- clear title and short description;
- large `<model-viewer>` stage;
- Safari AR link: `<a rel="ar" href="/models/model.usdz">`;
- `model-viewer ios-src` pointing at the selected USDZ;
- download buttons for GLB/USDZ;
- model rail for model variants;
- action rail for animated GLB variants;
- selected-state mirror label near the stage;
- loading panel with model size, downloaded bytes, and percent;
- notes section for AR/animation boundaries and next optimization step.

Use `@google/model-viewer` CDN unless the project already bundles it.

Core pattern:

```html
<model-viewer
  id="viewer"
  ios-src="/models/model.usdz"
  poster="/images/thumbnail.png"
  alt="3D asset preview"
  camera-controls
  touch-action="pan-y"
  auto-rotate
  autoplay
  animation-crossfade-duration="300"
  ar
  ar-modes="quick-look scene-viewer webxr"
  shadow-intensity="0.85"
  exposure="0.95"
  interaction-prompt="none">
</model-viewer>
```

### 3. Data schema

Use separate lists for static model variants and animated GLB actions:

```js
const stillUsdZ = '/models/asset-remesh.usdz';
const models = [
  { id:'remesh', kind:'model', title:'Remesh', desc:'recommended AR/web model', glb:'/models/asset-remesh.glb', usdz:'/models/asset-remesh.usdz', thumb:'/images/thumb.jpg', scale:1, tag:'default', bytes:22748532 },
  { id:'rigged', kind:'model', title:'Rigged', desc:'skeleton base', glb:'/models/asset-rigged.glb', usdz:stillUsdZ, thumb:'/images/thumb.jpg', scale:1, tag:'rig', bytes:18497904 }
];
const actions = [
  { id:'walking', kind:'action', title:'Walking', desc:'animated GLB', glb:'/models/asset-walking.glb', usdz:stillUsdZ, thumb:'/images/thumb.jpg', scale:1, tag:'walk', bytes:18510684 },
  { id:'heart', kind:'action', title:'Heart', desc:'Big_Heart_Gesture', glb:'/models/asset-heart.glb', usdz:stillUsdZ, thumb:'/images/thumb.jpg', scale:1, tag:'action', bytes:18572836 }
];
```

For actions, use the static USDZ fallback unless animated USDZ has been validated.

### 4. Loading progress

Implement loading with `fetch()` + stream reader + local manifest byte size. Do not leave the UI stuck on “reading model size”. Cache object URLs when switching variants.

### 5. Animation playback

When a selected asset is an action:

1. set `viewer.src` to the action GLB;
2. wait for load;
3. read `viewer.availableAnimations`;
4. set `viewer.animationName` to the first animation if needed;
5. call `viewer.play()`;
6. provide a Replay button.

### 6. Mobile / iPhone AR details

- Use a normal visible `<a rel="ar">` link for iPhone Quick Look.
- Use correct `Content-Type` via `vercel.json`:
  - `.usdz` → `model/vnd.usdz+zip`
  - `.glb` → `model/gltf-binary`
- Verify on deploy with `HEAD`/`curl -I`.
- If users ask why AR does not animate, explain that current AR path is static USDZ and web actions are GLB. Do not imply animated USDZ works until tested.

### 7. Deployment

If deployment is requested:

1. create/update `vercel.json` with asset MIME headers;
2. run a local static smoke test if possible;
3. deploy with Vercel;
4. verify:
   - page returns 200;
   - USDZ returns 200 and `model/vnd.usdz+zip`;
   - GLB returns 200 and `model/gltf-binary`;
   - newly added action GLBs return 200;
   - page HTML includes expected action/model IDs.

### 8. Handoff back to memory or generation skill

After completion, report:

- live URL;
- key files and asset directory;
- what is static AR vs animated web playback;
- validation checks performed;
- remaining caveats.

If this page is part of a larger 3D asset evolution, record the canonical asset directory and selected default/canonical model in project memory.

## Validation checklist

Before saying done:

- [ ] local files exist under `demos/<slug>/models` and `images`;
- [ ] page loads without broken images;
- [ ] default GLB displays;
- [ ] AR link points to intended USDZ;
- [ ] action GLBs are selectable and auto-play when possible;
- [ ] file sizes/progress are populated from manifest;
- [ ] Vercel MIME headers are correct after deploy;
- [ ] final answer states AR/animation limitations honestly.
