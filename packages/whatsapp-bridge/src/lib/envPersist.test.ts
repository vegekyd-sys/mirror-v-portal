import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { upsertEnvFileContents } from "./envPersist";

describe("upsertEnvFileContents", () => {
  it("replaces an existing key and appends a missing one", () => {
    const next = upsertEnvFileContents("YCLOUD_WABA_ID=\nPORT=3000\n", {
      YCLOUD_WABA_ID: "123",
      YCLOUD_FROM: "+85251111111",
    });
    assert.match(next, /^YCLOUD_WABA_ID=123$/m);
    assert.match(next, /^YCLOUD_FROM=\+85251111111$/m);
    assert.match(next, /^PORT=3000$/m);
  });
});
