import { hmacSha256Hex } from "../../lib/crypto";
import { verifyYCloudSignature } from "./signature";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("verifyYCloudSignature", () => {
  it("accepts a valid HMAC header", () => {
    const body = '{"id":"evt_1"}';
    const timestamp = "1700000000";
    const secret = "whsec_test";
    const signature = hmacSha256Hex(secret, `${timestamp}.${body}`);
    assert.equal(
      verifyYCloudSignature(body, `t=${timestamp},s=${signature}`, secret, 1700000000),
      true,
    );
  });

  it("rejects a tampered body", () => {
    const timestamp = "1700000000";
    const secret = "whsec_test";
    const signature = hmacSha256Hex(secret, `${timestamp}.{"id":"evt_1"}`);
    assert.equal(
      verifyYCloudSignature('{"id":"evt_2"}', `t=${timestamp},s=${signature}`, secret, 1700000000),
      false,
    );
  });
});
