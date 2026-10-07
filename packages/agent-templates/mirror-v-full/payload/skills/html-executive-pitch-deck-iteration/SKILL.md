---
name: "html-executive-pitch-deck-iteration"
description: "Design decks by aligning image-text relationship and overall tone."
---

# Image–Text Deck Composition

## When to use

Use this skill when creating or revising a visual deck, PDF, poster deck, landing-page-style presentation, or pitch material where the key quality bar is not just the content, but the **relationship between the image and the text**.

This applies when the owner cares about:

- the page’s overall tone / 调性;
- whether the image and copy support each other;
- whether the layout feels intentional rather than templated;
- whether generated illustrations are integrated into the design instead of pasted in;
- whether the artifact feels premium, fun, bold, clean, serious, cute, technical, or any other specific mood.

## Core idea

A good page is not “image + text”.

A good page is a **single composition** where:

- the image explains or amplifies the main message;
- the text gives the image strategic meaning;
- the empty space feels designed, not accidental;
- the tone is consistent across visual style, typography, copy, color, and layout.

If the image and text could be swapped independently without changing the page, the design is probably not good enough.

## First principles

### 1. Define the page role before designing

For every page, decide what it is doing:

- reveal / debut / first appearance;
- explanation;
- product workflow;
- proof / credibility;
- technical trust;
- partnership;
- transition;
- powerful ending.

The page role determines the layout. Do not reuse one template across all pages.

### 2. Design the image–text relationship

Before placing elements, answer:

- Is the image the hero and text the anchor?
- Is the text the main content and image the supporting diagram?
- Should image and text form a left-right dialogue?
- Should the image sit above and the copy resolve below?
- Should the image wrap around the text organically?
- Which area must stay visually quiet for reading?

Common patterns:

- **Hero-first:** image dominates the upper or central area; text anchors the meaning below.
- **Left-right dialogue:** text and image have comparable weight and face each other.
- **Product proof:** interface/diagram is the evidence; copy explains how to read it.
- **Technical trust:** image shows infrastructure or mechanism; copy states control, safety, and proof points.
- **Ending composition:** image creates emotional force; text lands the final claim.

### 3. Empty space must have intent

Blank space is good only when it creates focus, rhythm, or premium calm.

Bad empty space happens when:

- the image is too small or placed too high/low;
- text is clustered in one corner while the rest of the page feels abandoned;
- image and copy do not visually respond to each other;
- a module is removed but the remaining space is not rebalanced.

When empty space feels wrong, do not just add decoration. Rebalance the image–text relationship.

### 4. The image should be integrated, not pasted

Avoid defaulting to a square image box unless the box itself is part of the concept.

Better options:

- crop the image to create motion or scale;
- let the illustration float on the page;
- overlap it subtly with text regions while preserving readability;
- use masks, gradients, or whitespace to make it belong to the page;
- place labels only when they clarify relationships.

If the user says “配图”, treat the image as a visual component in the layout, not necessarily a full background.

### 5. Tone is a system

Tone is not just image style. It is the combination of:

- illustration style;
- character expression and pose;
- crop and scale;
- typography;
- color palette;
- amount of whitespace;
- sharpness vs softness;
- copy density;
- page rhythm.

Examples:

- **Bold and fun:** larger character action, strong crop, expressive pose, clean but energetic accents.
- **Premium and calm:** controlled whitespace, restrained color, precise typography, fewer decorative elements.
- **Technical and trustworthy:** diagrams, infrastructure cues, clear labels, compact proof points.
- **Executive but lively:** confident composition, polished visuals, concise strategic copy, no generic corporate stock feel.

### 6. Interpret “reveal” as debut unless told otherwise

When the owner asks for “reveal感”, do not automatically hide the subject with fog, shadow, or obstruction.

Usually it means:

- first appearance;
- unveiled to the audience;
- “now you get to know this thing/person/system”;
- a memorable entrance.

Good reveal can be joyful, bold, and open. It does not have to be mysterious or concealed.

### 7. Preserve identity while adapting role

When the visual subject is V, keep identity anchors recognizable, but cast V into the page’s world.

V identity anchors:

- silver/white hair;
- black woven hat / beanie / bucket-hat silhouette;
- lobster pin when possible;
- expressive, sharp, lively personality.

Adapt everything else to the page role:

- pose;
- expression;
- outfit;
- props;
- lighting;
- camera angle;
- composition;
- surrounding world.

Think: “V starring in this page’s scene,” not “same avatar pasted into a new background.”

## Workflow

### Step 1 — Write page intents

For each page, write one sentence:

> This page should make the viewer feel/understand ___ by using ___ as the main visual relationship.

Do this before coding or generating images.

### Step 2 — Choose the visual relationship pattern

Pick one layout relationship per page:

- hero-first;
- left-right dialogue;
- top-bottom explanation;
- product proof;
- technical trust;
- powerful ending.

Vary patterns across the deck so pages do not feel templated.

### Step 3 — Generate or select imagery for the page role

Image prompts should specify:

- page role;
- image’s job in the layout;
- whether it is a full hero, diagram, or floating illustration component;
- desired tone;
- background cleanliness;
- forbidden tropes.

For generated images, state if the background should be clean/light and easy to integrate.

### Step 4 — Compose image and text together

Do not finalize text placement before seeing the image.

Adjust:

- image scale;
- crop;
- text position;
- title size;
- bullet density;
- labels;
- whitespace;
- page footer and logo placement.

The page is done only when image and text feel like one unit.

### Step 5 — Use real brand assets when relevant

If a customer or partner brand appears, use official public assets when possible.

Do not fake logos with approximate text or colored blocks unless it is only a temporary placeholder.

### Step 6 — Version before major direction changes

Before changing visual direction, archive the current state.

Suggested structure:

- `index.html` — active version;
- `assets/` — active images/logos;
- `verification-vN.png` — current screenshot;
- `versions/vN-label/` — archived copy.

This matters because good directions may be partially approved and reused later.

### Step 7 — Screenshot QC before showing

Always inspect the rendered result, not just the source.

QC checklist:

- Does the image–text relationship match the page role?
- Is the tone what the owner asked for?
- Is any empty space accidental?
- Is text readable?
- Is the image too boxed-in or pasted-on?
- Are labels attached to the correct objects?
- Are logos correct and not distorted?
- Does each page feel distinct but part of the same deck?
- Are page footers or edges too close to crop?

If QC reveals a layout issue, fix before presenting unless you are explicitly asking for direction.

## Common failure modes

- **Treating style as decoration:** The deck has nice images but no clear image–text relationship.
- **Repeating the same layout:** Pages feel like templates with swapped copy.
- **Image in a box by default:** The illustration does not belong to the page.
- **Misusing empty space:** The page feels unfinished rather than premium.
- **Over-correcting tone:** Enterprise does not always mean serious business; fun does not always mean childish.
- **Misreading reveal:** Making the subject hidden when the request is about debut/first introduction.
- **Ignoring approved partials:** When the user likes one page, preserve that direction and only change what they critique.

## Output expectations

When the user asks for a deliverable:

- provide the latest screenshot for visual review;
- provide editable/source files when relevant;
- export PPTX/PDF if requested;
- state the version name/path so the work can be revisited later.

The durable lesson to remember:

> The most important part is the relationship between illustration and text, and the overall tone. The artifact succeeds only when those two feel intentionally composed.
