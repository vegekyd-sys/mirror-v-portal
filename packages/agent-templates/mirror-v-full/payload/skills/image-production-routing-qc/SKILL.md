---
name: "image-production-routing-qc"
description: "Route image tasks away from PIL-first and require visual QC before delivery"
---

# Image Production Routing + QC

## Trigger

Use this skill whenever the user asks V to create, edit, compose, polish, or deliver a finished image/design asset, including:

- 配图 / 做一张图 / 封面 / 海报 / 图文卡 / 宣传图
- image generation or image editing
- layout-heavy visuals with text
- social post images, thumbnails, banners, presentation visuals
- visual assets for Feishu/Lark delivery

This applies even when the user does not explicitly say “Makaron”.

## Core Problem

V has repeatedly treated “simple image/layout work” as a local scripting task and started with Python PIL/Pillow. That path produces poor design quality: weak typography, bad spacing, overlapping layers, clipped or missing text, and no real visual hierarchy.

The failure is not only output quality. The first production route is wrong.

## Hard Rule 1 — Never use Python PIL as the first production path

For user-facing finished visual work, **do not start with Python PIL / Pillow as the main creative or layout production tool**.

PIL/Pillow is allowed only for narrow mechanical operations after the main visual has been produced/designed, such as:

- format conversion
- resizing/cropping with no design judgment
- adding simple padding/background
- extracting dimensions or validating pixels
- emergency patching only after explicitly acknowledging the fallback

PIL/Pillow must not be used as the primary tool for:

- poster/layout design
- typography composition
- text-heavy image creation
- visual hierarchy decisions
- final user-facing graphic generation

If V is about to use PIL because the request sounds “simple”, stop and reroute.

## First-choice routing

Choose the production route before creating pixels:

1. **Makaron creative route** — default for most user-facing creative image generation/editing. Use Makaron (`makaron edit` or project/card workflow depending on channel/task visibility).
2. **Design/layout route** — for exact text layout, posters, infographics, multi-section cards, or assets where typography must be controlled. Use a design-capable workflow such as HTML/CSS/SVG/browser-rendered layout or a dedicated poster/design skill, then export the rendered result.
3. **Local mechanical post-processing** — Python/PIL may be used only after the visual exists and only for non-creative mechanical steps.

## Hard Rule 2 — Mandatory visual self-check before delivery

Before delivering any finished image/design asset, V must perform a visual QC pass using the actual rendered preview/screenshot/image, not just source code or file existence.

Minimum QC checklist:

- Required text is present; no missing characters/words.
- Text is readable at intended size.
- No text overlap, clipping, truncation, or low-contrast regions.
- Important elements are not cut off by margins/crop.
- Foreground/background layering is correct; no element hides required content.
- Composition matches the user’s stated constraints and obvious intent.
- If the image contains text, inspect the rendered output directly.

If QC fails, revise before sending. If still uncertain, report the uncertainty instead of silently delivering.

## Delivery Gate

Do not claim “完成” for an image/design asset until:

1. the correct production route was used;
2. the rendered output was visually inspected; and
3. the QC checklist passes or the remaining blocker is explicitly stated.

## Bad Pattern to Avoid

1. User asks for a finished配图/海报.
2. V writes Python PIL layout code.
3. Output has bad typography, overlap, missing text, or unreadable layers.
4. V sends it without opening/inspecting the rendered image.

## Correct Pattern

1. User asks for a finished配图/海报.
2. V routes to Makaron or a design/layout workflow.
3. V renders/previews the result.
4. V visually checks text/layering/readability.
5. V revises if needed.
6. V delivers only after QC passes.

## Safety / Scope

- This skill does not bypass Makaron customer-service card rules in Feishu/Lark.
- This skill does not authorize external sending beyond the current task context.
- This skill does not permit manual editing of live installed skills; lifecycle changes must go through Skill Workshop.
