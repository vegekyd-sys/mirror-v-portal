import { expect, test } from "vitest";
// @ts-expect-error runtime module without types
import { completionsEdits, patchExact } from "../runtime/stream-preview-patch.mjs";

// The three lines the completions-stream edit touches, as npm @openclaw/ai 2026.9.1 ships them
// and as V's dsml-spaced-calls-v1 build (2026-11-08) has them.
const strict = [
  "\t\tif (forceStrict || reasoningTagTextPartitioner.hasPending()) reasoningTagTextPartitioner.markStrict();",
  "const routedDeltas = hasReasoningThinking ? reasoningTagTextPartitioner.push(contentDelta.text) : reasoningTagTextPartitioner.pushVisible(contentDelta.text);",
].join("\n");
const npmFile = `function f() {\n\tconst shouldFilterDeepSeekDsmlText = !directMode && compat.thinkingFormat === "deepseek";\n${strict}\n}`;
const vFile = `function f() {\n\t// dsml-spaced-calls-v1: direct calls hide DSML text too, but never recover tools from it\n\tconst shouldFilterDeepSeekDsmlText = compat.thinkingFormat === "deepseek";\n${strict}\n}`;

test("the completions-stream preview edit applies to npm's and V's build with the same scope", () => {
  for (const [source, scope] of [[npmFile, "const nexusVisibleDeepSeekText = shouldFilterDeepSeekDsmlText;"], [vFile, "const nexusVisibleDeepSeekText = !directMode && shouldFilterDeepSeekDsmlText;"]]) {
    const patched = patchExact(source, completionsEdits, "COMPLETIONS_STREAM");
    expect(patched).toContain(scope);
    expect(patched).toContain("if (!nexusVisibleDeepSeekText && (forceStrict");
    expect(patched).toContain("hasReasoningThinking && !nexusVisibleDeepSeekText ?");
    // Installed: unchanged on the next boot.
    expect(patchExact(patched, completionsEdits, "COMPLETIONS_STREAM")).toBe(patched);
  }
  // Unknown build: fail closed before anything is written.
  expect(() => patchExact(npmFile.replace("markStrict();", "markStrict(true);"), completionsEdits, "COMPLETIONS_STREAM")).toThrow("UNSUPPORTED_COMPLETIONS_STREAM_ANCHOR");
  const installed = patchExact(npmFile, completionsEdits, "COMPLETIONS_STREAM");
  expect(() => patchExact(installed.replace("hasReasoningThinking && !nexusVisibleDeepSeekText", "x"), completionsEdits, "COMPLETIONS_STREAM")).toThrow("UNSUPPORTED_INSTALLED_COMPLETIONS_STREAM");
});
