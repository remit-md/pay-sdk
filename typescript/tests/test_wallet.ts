import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { Wallet, PayError, PayValidationError } from "../src/index.js";

// Anvil account #0 — well-known test key
const ANVIL_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const VALID_ADDR = "0x" + "a1".repeat(20);

// Save/restore env for tests that modify it
let savedEnv: Record<string, string | undefined>;

function saveEnv() {
  savedEnv = {
    PAYSKILL_KEY: process.env.PAYSKILL_KEY,
    PAYSKILL_TESTNET: process.env.PAYSKILL_TESTNET,
    PAYSKILL_API_URL: process.env.PAYSKILL_API_URL,
  };
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── Construction ──────────────────────────────────────────────────────

describe("Wallet construction", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("constructs with explicit private key", () => {
    const wallet = new Wallet({ privateKey: ANVIL_PK });
    assert.equal(wallet.address, ANVIL_ADDRESS);
  });

  it("constructs without 0x prefix", () => {
    const wallet = new Wallet({ privateKey: ANVIL_PK.slice(2) });
    assert.equal(wallet.address, ANVIL_ADDRESS);
  });

  it("constructs from PAYSKILL_KEY env var", () => {
    process.env.PAYSKILL_KEY = ANVIL_PK;
    const wallet = new Wallet();
    assert.equal(wallet.address, ANVIL_ADDRESS);
  });

  it("throws without key", () => {
    delete process.env.PAYSKILL_KEY;
    assert.throws(() => new Wallet(), PayError);
  });

  it("throws on invalid key (too short)", () => {
    assert.throws(
      () => new Wallet({ privateKey: "0xdead" }),
      PayValidationError,
    );
  });

  it("throws on invalid key (non-hex)", () => {
    assert.throws(
      () => new Wallet({ privateKey: "0x" + "zz".repeat(32) }),
      PayValidationError,
    );
  });

  it("Wallet.fromEnv reads PAYSKILL_KEY", () => {
    process.env.PAYSKILL_KEY = ANVIL_PK;
    const wallet = Wallet.fromEnv();
    assert.equal(wallet.address, ANVIL_ADDRESS);
  });

  it("Wallet.fromEnv throws without env var", () => {
    delete process.env.PAYSKILL_KEY;
    assert.throws(() => Wallet.fromEnv(), PayError);
  });

  it("Wallet.create falls back to env var when keychain unavailable", async () => {
    process.env.PAYSKILL_KEY = ANVIL_PK;
    const wallet = await Wallet.create();
    assert.equal(wallet.address, ANVIL_ADDRESS);
  });

  it("respects testnet option", () => {
    process.env.PAYSKILL_KEY = ANVIL_PK;
    // Just verify it doesn't throw — testnet flag affects API URL only
    const wallet = new Wallet({ testnet: true });
    assert.equal(wallet.address, ANVIL_ADDRESS);
  });

  it("respects PAYSKILL_TESTNET env var", () => {
    process.env.PAYSKILL_KEY = ANVIL_PK;
    process.env.PAYSKILL_TESTNET = "1";
    const wallet = new Wallet();
    assert.equal(wallet.address, ANVIL_ADDRESS);
  });
});

// ── Validation ──────────────────────────────────────────────────────

describe("Wallet input validation", () => {
  let wallet: Wallet;

  beforeEach(() => {
    wallet = new Wallet({ privateKey: ANVIL_PK });
  });

  it("send rejects invalid address", async () => {
    await assert.rejects(
      () => wallet.send("not-an-address", 5),
      PayValidationError,
    );
  });

  it("send rejects amount below $1 minimum", async () => {
    await assert.rejects(
      () => wallet.send(VALID_ADDR, 0.5),
      PayValidationError,
    );
  });

  it("send rejects negative amount", async () => {
    await assert.rejects(
      () => wallet.send(VALID_ADDR, -5),
      PayValidationError,
    );
  });

  it("send rejects NaN", async () => {
    await assert.rejects(
      () => wallet.send(VALID_ADDR, NaN),
      PayValidationError,
    );
  });

  it("send rejects Infinity", async () => {
    await assert.rejects(
      () => wallet.send(VALID_ADDR, Infinity),
      PayValidationError,
    );
  });

  it("openTab rejects amount below $5 minimum", async () => {
    await assert.rejects(
      () => wallet.openTab(VALID_ADDR, 3, 1),
      PayValidationError,
    );
  });

  it("openTab rejects zero maxChargePerCall", async () => {
    await assert.rejects(
      () => wallet.openTab(VALID_ADDR, 10, 0),
      PayValidationError,
    );
  });

  it("openTab rejects invalid provider address", async () => {
    await assert.rejects(
      () => wallet.openTab("bad-addr", 10, 1),
      PayValidationError,
    );
  });

  it("mint rejects on mainnet", async () => {
    await assert.rejects(() => wallet.mint(10), PayError);
  });

  it("micro amount conversion works", async () => {
    // $5 micro amount should not fail validation for tab (need network for full test)
    await assert.rejects(
      () => wallet.openTab(VALID_ADDR, { micro: 5_000_000 }, { micro: 100_000 }),
      // Will fail on network (can't reach server), not validation
      (err: Error) => !(err instanceof PayValidationError),
    );
  });

  it("micro amount rejects negative", async () => {
    await assert.rejects(
      () => wallet.send(VALID_ADDR, { micro: -1 }),
      PayValidationError,
    );
  });

  it("micro amount rejects non-integer", async () => {
    await assert.rejects(
      () => wallet.send(VALID_ADDR, { micro: 1.5 }),
      PayValidationError,
    );
  });
});
