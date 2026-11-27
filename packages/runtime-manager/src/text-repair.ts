/**
 * Stream deltas can carry U+FFFD where a harness split one UTF-8 character across
 * two chunks (seen with DeepSeek through the Codex harness, 2026-11-27). The run's
 * final text from the transcript is intact; put each damaged span back from it.
 * A span is replaced only when its surrounding context locates it exactly once.
 */
export function repairReplacementChars(text: string, reference: string | undefined): string {
  if (!text.includes("�") || !reference || reference.includes("�")) return text;
  return text.replace(/�+/g, (run: string, offset: number, whole: string) => {
    for (const k of [12, 8, 4]) {
      const before = whole.slice(Math.max(0, offset - k), offset);
      const after = whole.slice(offset + run.length, offset + run.length + k);
      if (!before || before.includes("�") || after.includes("�")) continue;
      const found = new Set<string>();
      for (let i = reference.indexOf(before); i !== -1 && found.size < 2; i = reference.indexOf(before, i + 1)) {
        const start = i + before.length;
        // One damaged character decodes to one to three U+FFFD.
        for (let len = 1; len <= run.length; len++) {
          if (after ? reference.startsWith(after, start + len) : start + len === reference.length) found.add(reference.slice(start, start + len));
        }
      }
      if (found.size === 1) return [...found][0];
    }
    return run;
  });
}
