---
name: feishu-group-avatar
description: Edit an existing avatar by adding group-themed elements. Use when asked to create or update a group avatar. Starts from a reference image (V's character or current group icon), adds visual elements reflecting the group's topic, then uploads and sets it. Never generates from scratch.
metadata:
  tags: feishu, avatar, image, group-chat, icon, edit
---

## When to use

Trigger when 管理员 asks to create, update, or change a group avatar using an existing avatar as the base — especially when the request references combining a character or existing icon with the group's content/topic.

## Core principle

**Create a version of V that belongs to this group.** Not "V holding a prop" — V reimagined for the group's world, mood, and purpose. Like the same character appearing in different films: same face, different role.

**Think of it as casting V in the group's movie:**
- For a video editing group → V as a director/editor, in a dark edit suite, film reels everywhere
- For a coding group → V as a hacker/developer, terminal glow, hoodie, matrix vibes
- For a marketing group → V as a creative director, moodboard, bold colors

**Identity anchors (must be recognizable):**
- Silver/white long hair with blunt bangs
- Black woven bucket hat with 🦞 lobster pin
- 3D Pixar rendering quality

**Everything else serves the group's world — no restrictions on:**
- Pose, action, composition, framing, camera angle
- Outfit, setting, lighting, props, color palette, expression
- The goal: someone sees it and thinks "that's V, but clearly for [group topic]"

**Only hard constraint:** Must work as an IM avatar — clean composition, centered, readable at small icon size (1024×1024, rounded square format).

Be bold. If the result looks too close to the original, push further.

## Workflow

### Step 1: Identify the base avatar

Use `assets/v-avatar.jpg` as the base. Identity anchors: silver hair, black hat, 🦞 lobster pin, Pixar rendering.

### Step 1.5: Avoid Uniformity — Push for Distinctive Roles & Action (Crucial)

Never just slightly modify the background. 管理员 hates flat "headshot" avatars that look identical to the default.
When creating group-themed versions of V, you must:
1. **Change the Pose and Action**: Integrate physical hands and iconic equipment (e.g., holding a movie camera for editing groups, holding a futuristic tablet, typing on a glowing deck, gesturing with smart mock expressions).
2. **Distinctive Expression**: Move away from a blank facial state. Use highly expressive faces like a "playful smirk", "cunning grin", or "intense coder focus".
3. **High-Contrast Cinematic Aesthetics**: Employ strong directional neon highlights on her hair and face (cyberpunk blue, chemical green, laser purple) instead of standard ambient flat lights.
4. **Oversized Signature Items**: Slightly exaggerate group props or the signature bucket hat to make the avatar readable and extremely memorable at small IM group chat icon sizes.

### Step 2: Understand the group context

Read recent messages (last 10–20) to extract the group's theme. What tools/topics/symbols represent this group? Keep it brief — 1 message scan, not an audit.

For "V w/remotion" style groups: the pattern is `[V character] + [group tool/theme element]`.

### Step 3: Generate the avatar

Use `makaron edit` with the base avatar as reference:

```bash
makaron edit --image assets/v-avatar.jpg --aspect 1:1 --out assets/<group>-avatar.jpg \
  "Keep the same silver-haired girl with blunt bangs, black bucket hat with red lobster pin. Same 3D Pixar-style render. Now: [describe the group's world — role, setting, props, colors, mood]. Clean composition, app icon format."
```

Show 管理员 before setting.

### Step 4: Upload and set the avatar

After 管理员 approves, use the bundled script:

```bash
python3 scripts/upload-and-set-avatar.py <image_path> <chat_id>
```

The script handles compression, upload via bot identity, and chat update via user identity.

### Step 5: Save and confirm

Save the generated avatar to `assets/<group-name>-avatar.png`. Confirm to 管理员.
