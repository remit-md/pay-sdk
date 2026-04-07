import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PayClient } from "../src/client.js";
import { PayValidationError } from "../src/errors.js";
import { CallbackSigner } from "../src/signer.js";

const VALID_ADDR = "0x" + "a1".repeat(20);
const dummySigner = new CallbackSigner(() => new Uint8Array(65));

const client = new PayClient({
  apiUrl: "http://localhost:9999",
  signer: dummySigner,
});

describe("payDirect validation", () => {
  it("rejects invalid address", async () => {
    await assert.rejects(
      () => client.payDirect("not-an-address", 1_000_000),
      PayValidationError
    );
  });

  it("rejects amount below minimum", async () => {
    await assert.rejects(
      () => client.payDirect(VALID_ADDR, 500_000),
      PayValidationError
    );
  });

  it("accepts valid inputs (fails on network, not validation)", async () => {
    // This should fail with a network error, not validation
    await assert.rejects(
      () => client.payDirect(VALID_ADDR, 1_000_000),
      (err: Error) => {
        assert.ok(!(err instanceof PayValidationError));
        return true;
      }
    );
  });
});


describe("openTab validation", () => {
  it("rejects amount below $5 minimum", async () => {
    await assert.rejects(
      () =>
        client.openTab(VALID_ADDR, 1_000_000, { maxChargePerCall: 100_000 }),
      PayValidationError
    );
  });

  it("rejects zero maxChargePerCall", async () => {
    await assert.rejects(
      () => client.openTab(VALID_ADDR, 10_000_000, { maxChargePerCall: 0 }),
      PayValidationError
    );
  });

  it("rejects invalid provider address", async () => {
    await assert.rejects(
      () =>
        client.openTab("bad-addr", 10_000_000, { maxChargePerCall: 500_000 }),
      PayValidationError
    );
  });
});
