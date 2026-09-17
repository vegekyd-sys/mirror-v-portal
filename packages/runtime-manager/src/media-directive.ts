/**
 * Attachments the agent asks to deliver.
 *
 * OpenClaw's convention is a `MEDIA:` line carrying a path or URL, which the
 * runtime's own channels turn into an upload. Nothing consumed that here, so
 * the directive travelled to the user as literal text and the file stayed in
 * the sandbox — the agent would say "图在这儿 👆" with no image attached.
 *
 * Markdown image syntax is accepted too, because agents reach for it by habit
 * even when told to use MEDIA:.
 */
const MEDIA_LINE = /^\s*MEDIA:\s*(.+?)\s*$/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;

export interface MediaDirective {
  /** Path inside the sandbox, or an absolute URL. */
  ref: string;
  /** True when the reference is already reachable without reading the sandbox. */
  remote: boolean;
}

export interface ParsedReply {
  /** Reply text with the directives removed. */
  text: string;
  media: MediaDirective[];
}

const isRemote = (ref: string) => /^https?:\/\//i.test(ref);

/** Bare filenames are resolved against the agent's workspace. */
export function resolveRef(ref: string, workspace = "/vercel/sandbox/agent-data/workspace") {
  if (isRemote(ref) || ref.startsWith("/")) return ref;
  const cleaned = ref.replace(/^\.\//, "").replace(/^~\//, "");
  return `${workspace}/${cleaned}`;
}

export function parseReply(output: string): ParsedReply {
  if (!output) return { text: "", media: [] };
  const media: MediaDirective[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    // Strip quotes and markdown link decoration agents sometimes add.
    const ref = raw.trim().replace(/^[<"'`]+|[>"'`]+$/g, "");
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    media.push({ ref, remote: isRemote(ref) });
  };

  const kept: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const directive = line.match(MEDIA_LINE);
    if (directive) {
      add(directive[1]);
      continue; // the directive itself is not part of the reply
    }
    kept.push(line);
  }

  // Markdown images stay in place as text — removing them would leave a hole in
  // a sentence — but the file is still delivered alongside.
  let text = kept.join("\n");
  for (const match of text.matchAll(MARKDOWN_IMAGE)) add(match[1]);

  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), media };
}

/** Rough kind detection from the extension; enough to pick an upload API. */
export function mediaKind(ref: string): "image" | "video" | "audio" | "file" {
  const ext = ref.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "mkv", "webm", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac", "opus", "amr"].includes(ext)) return "audio";
  return "file";
}
