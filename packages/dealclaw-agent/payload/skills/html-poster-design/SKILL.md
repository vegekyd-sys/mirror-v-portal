---
name: "html-poster-design"
description: "HTML/Remotion poster/image design with webfonts and typography QC."
---

# HTML Poster Design

Use this skill when the user asks for a designed image, poster, comparison image, family card, keepsake, infographic, thumbnail, or layout-driven visual artifact where typography and placement matter. This is especially relevant when the artifact contains names, dates, labels, captions, or multiple source photos.

## Core Routing

- Prefer **HTML/CSS screenshot rendering** or **Remotion** over pure image generation when the task depends on precise text, typography, labels, dates, existing photos, or layout.
- Use image generation only when the core value is synthesizing new visual content, not arranging existing content.
- If the task is user-facing creative work in a Makaron context, follow the Makaron skill for service/card/account rules, but use this procedure for the actual HTML/Remotion design artifact when appropriate.

## Typography Asset Rule

For HTML/Remotion design work:

- Do **not** claim local fonts are the main limitation before trying webfont assets.
- Use Google Fonts, hosted webfonts, or pinned local font files when typography matters.
- Verify fonts loaded before screenshot/render (`document.fonts.ready` in Playwright, or equivalent).
- Choose a font pair intentionally:
  - Display/title font for the emotional direction.
  - Information/body font for captions, dates, tags, and metadata.
- Avoid defaulting to Arial, Inter, Roboto, or generic system fonts unless the design specifically calls for that neutral voice. Inter can be acceptable as an information layer paired with a distinctive display font.

## Design Workflow

Before coding, commit to a specific visual direction, for example:

- editorial family archive
- refined newborn keepsake
- playful sticker-card / toy-like scrapbook
- luxury minimal photo diptych
- magazine comparison layout
- soft pastel baby record card

Then execute in this order:

1. **Reference the intent**: What should the image feel like? Premium, cute, mischievous, warm, documentary, toy-like, etc.
2. **Choose typography first**: Select fonts and weights that embody the direction.
3. **Build the layout grid**: Decide canvas ratio, margins, photo sizes, text hierarchy, and alignment.
4. **Place content**: Photos, names, dates, labels, captions.
5. **Add style elements last**: tags, stickers, shadows, borders, speech bubbles, textures, background shapes.
6. **Render and self-QC** before presenting.

## Self-QC Checklist

Do not present the artifact until checking:

- Are fonts actually loaded and visually reflected in the render?
- Do title spacing, letter spacing, line-height, and baseline feel optically intentional?
- Are labels/tags integrated rather than pasted on?
- Does the design avoid cheap template signals: random decorations, heavy shadows, unmotivated badges, default font feel, overcrowded small caps?
- Is there a clear hierarchy between title, labels, names, dates, and captions?
- Do photos and text have breathing room?
- Does the style match the user's requested mood?
- Would a screenshot at final size still look precise?

If the result feels merely "rendered" but not designed, iterate before sending.

## Handling Critical Feedback

If the user says the result feels cheap, imprecise, or poorly designed:

- Acknowledge the aesthetic failure directly.
- Identify concrete causes: font choice, letter spacing, line spacing, optical spacing, baseline, hierarchy, composition, decoration, or photo crop.
- Do not defend implementation constraints such as local fonts.
- Redo with better design assets and self-QC before presenting the next version.

## Examples

- Editorial/family archive diptych: Cormorant Garamond for title + Inter or another restrained sans for metadata; minimal decoration; precise spacing.
- Cute/playful Chinese newborn card: a characterful Chinese display font such as ZCOOL KuaiLe or Ma Shan Zheng, plus Noto Sans SC for labels; tag/badge elements under the title; playful but controlled cards, speech bubbles, and stickers.
