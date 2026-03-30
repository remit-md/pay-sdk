import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CallbackSigner,
  CliSigner,
  RawKeySigner,
  createSigner,
} from "../src/signer.js";

describe("CallbackSigner", () => {
  it("delegates to callback", () => {
    const sig = new Uint8Array(65).fill(1);
    const signer = new CallbackSigner(() => sig);
    const result = signer.sign(new Uint8Array(32));
    assert.deepEqual(result, sig);
  });
});

describe("createSigner", () => {
  it("creates CliSigner for cli mode", () => {
    const signer = createSigner("cli");
    assert.ok(signer instanceof CliSigner);
  });

  it("throws for raw mode without key", () => {
    const originalKey = process.env.PAYSKILL_KEY;
    delete process.env.PAYSKILL_KEY;
    assert.throws(() => createSigner("raw"), /No key/);
    if (originalKey) process.env.PAYSKILL_KEY = originalKey;
  });

  it("creates RawKeySigner with key", () => {
    const signer = createSigner("raw", { key: "0x" + "ab".repeat(32) });
    assert.ok(signer instanceof RawKeySigner);
  });

  it("creates CallbackSigner for custom mode", () => {
    const signer = createSigner("custom", {
      callback: () => new Uint8Array(65),
    });
    assert.ok(signer instanceof CallbackSigner);
  });

  it("throws for custom mode without callback", () => {
    assert.throws(() => createSigner("custom"), /callback/);
  });
});
