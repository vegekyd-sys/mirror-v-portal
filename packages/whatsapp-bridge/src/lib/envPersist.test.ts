import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { upsertEnvFileContents } from "./envPersist";

describe("upsertEnvFileContents", () => {
  it("replaces an existing key and appends a missing one", () => {
    const next = upsertEnvFileContents("APP_SETTING=\nPORT=3000\n", {
      APP_SETTING: "enabled",
      SECOND_SETTING: "configured",
    });
    assert.match(next, /^APP_SETTING=enabled$/m);
    assert.match(next, /^SECOND_SETTING=configured$/m);
    assert.match(next, /^PORT=3000$/m);
  });
});
