---
name: "figma-reference-replication"
description: "Use Figma MCP references to rebuild layout-driven images locally."
---

# Figma Reference Replication

## When to use

Use this skill when 管理员 asks V to:

- 看 / 读取 / 分析一个 Figma 文件作为参考
- 复刻 Figma 里的某张图、卡片、海报、页面、信息图
- 基于 Figma 参考图做一张新的图，但替换为 V / Makaron / 管理员 / 客户信息

This skill is for layout-driven visual artifacts where typography, spacing, hierarchy, and accurate text matter. Prefer HTML/CSS screenshot rendering or other local deterministic rendering over pure image generation.

## Important boundary: no Figma write-back

Do **not** write generated work back into the Figma file as part of this workflow.

Reason: the 2026-06-23 write-back attempt did not run successfully (`use_figma` MCP call was cancelled), so Figma write-back is not a verified capability for this method. The proven workflow is read/reference Figma → recreate locally → QC → deliver a PNG/HTML artifact.

If 管理员 separately asks to test Figma write-back in the future, treat it as a new experimental task with explicit confirmation and separate verification. Do not include it in the default replication flow.

## Safety and permission boundaries

1. Figma read-only inspection is OK when the user provides the link and asks V to inspect it.
2. Default output is local artifact delivery, not external file mutation.
3. Never overwrite or modify existing Figma content in this workflow.
4. Treat short-lived MCP screenshot/asset URLs as sensitive; do not paste them into chat unless necessary.

## Required workflow

### 1. Verify Figma MCP access

Given a Figma design URL, parse:

- `fileKey`
- `nodeId` (convert URL `node-id=0-1` to MCP `0:1`)

Use configured Figma MCP tools, not browser scraping, as the primary path:

- `whoami` — confirm authentication
- `get_metadata` — inspect page/frame structure
- `get_screenshot` — capture visual reference
- `get_design_context` — use when a specific layer is selected or when MCP accepts the node

Record blockers exactly. Common blocker examples:

- `Looks like you don't have edit access to this file...` → ask for editor access if MCP requires it.
- `You currently have nothing selected...` → ask user to select the target layer, or continue from metadata + screenshot if sufficient.

### 2. Extract visual grammar

Do not simply say “similar style.” Extract concrete design grammar:

- canvas/frame size and aspect ratio
- card/page grid and existing frame positions
- top identity/logo area
- hero image / main visual placement
- metric / status text treatment
- lower content sections
- background style, glow, gradients, texture, accents
- typography hierarchy and approximate font weights
- repeated copy patterns and tone

For the 2026-06-23 service-card reference, useful observed pattern:

- card size: `402 × 874`
- top: logo + company/object name
- upper-middle: hero image/illustration
- middle: large number/status text such as `100%`, `158`, `第1次`, `4,940`
- lower: two section headings + body copy
- style: dark navy/black, cyan-blue neon glow, occasional gold accents, cinematic tech background

### 3. Build a new artifact locally

For text-heavy cards/posters, use HTML/CSS screenshot rendering first:

1. Choose a concrete visual direction.
2. Write a fixed-size HTML file matching the target aspect ratio.
3. Use CSS for gradients, glows, backgrounds, grids, typography, and layout.
4. Insert required user/V/customer content.
5. Render with Chrome/Playwright to PNG.
6. Run visual QC before delivery.

For V identity cards, use `assets/v-avatar.jpg` as the avatar reference when available.

### 4. Required visual QC

Before delivering the PNG, inspect the rendered image:

- required text is present
- Chinese text is readable
- no overlap, clipping, or missing glyphs
- avatar/image loaded and not cropped badly
- hierarchy matches the reference
- spacing and margins are intentional
- style resembles the Figma reference, not a generic poster

If QC fails, revise and rerender before sending.

## Output expectations

For local reproduction:

- final PNG as media attachment
- optional HTML/source path if useful
- brief explanation of how it was made
- note any mismatch from source reference

Do not mention Figma write-back as a next step unless 管理员 explicitly asks to test that separate capability.

## Example: V service perception card

Content mapping used in the first experiment:

- identity: `管理员 的 AI Partner · V`
- tags: `Memory`, `Agent Ops`, `Makaron`
- metric: `24/7`
- metric label: `在线协作`
- section 1: `服务感知实时同步`
- section 1 body: `自动读取上下文、识别任务状态与阻塞点，把想法快速落成可执行方案。`
- section 2: `长期记忆持续沉淀`
- section 2 body: `沉淀 管理员 的偏好、项目经验与创作流程，让每次协作都接着上次继续。`

Known first-run artifacts:

- local HTML: `work/figma-reference-0623/v-service-card.html`
- local PNG: `work/figma-reference-0623/v-service-card.png`
- Figma access report: `work/figma-reference-0623/figma-mcp-verify-rerun2.md`
- write-back attempt report (negative evidence only): `work/figma-reference-0623/figma-add-v-card-report.md`
