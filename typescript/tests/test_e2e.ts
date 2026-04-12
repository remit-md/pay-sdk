/**
 * E2E acceptance tests — run against live testnet.
 *
 * Skip unless PAYSKILL_TESTNET_KEY is set.
 *
 * Usage:
 *   PAYSKILL_TESTNET_KEY=0xdead... node --import tsx --test tests/test_e2e.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet, PayValidationError } from "../src/index.js";

const TESTNET_KEY = process.env.PAYSKILL_TESTNET_KEY ?? "";
const skip = !TESTNET_KEY;

function makeWallet(): Wallet {
  return new Wallet({ privateKey: TESTNET_KEY, testnet: true });
}

describe("E2E: Status + Balance", { skip }, () => {
  let wallet: Wallet;
  before(() => { wallet = makeWallet(); });

  it("status returns valid response", async () => {
    const status = await wallet.status();
    assert.ok(status.address.startsWith("0x"));
    assert.ok(status.balance.total >= 0);
    assert.ok(typeof status.openTabs === "number");
  });

  it("balance returns total/locked/available", async () => {
    const bal = await wallet.balance();
    assert.ok(typeof bal.total === "number");
    assert.ok(typeof bal.locked === "number");
    assert.ok(typeof bal.available === "number");
    assert.ok(bal.available <= bal.total);
  });
});

describe("E2E: Mint testnet USDC", { skip }, () => {
  let wallet: Wallet;
  before(() => { wallet = makeWallet(); });

  it("mints $10 USDC", async () => {
    const result = await wallet.mint(10);
    assert.ok(result.txHash);
    assert.equal(result.amount, 10);
  });
});

describe("E2E: Webhook CRUD", { skip }, () => {
  let wallet: Wallet;
  let hookId = "";
  before(() => { wallet = makeWallet(); });

  it("registers a webhook", async () => {
    const slug = randomUUID().slice(0, 8);
    const wh = await wallet.registerWebhook(
      `https://example.com/hook/${slug}`,
      ["payment.completed"],
      `whsec_test_${slug}`,
    );
    assert.ok(wh.id);
    assert.ok(wh.url.startsWith("https://"));
    hookId = wh.id;
  });

  it("lists webhooks", async () => {
    const hooks = await wallet.listWebhooks();
    assert.ok(hooks.some((h) => h.id === hookId));
  });

  it("deletes the webhook", async () => {
    await wallet.deleteWebhook(hookId);
    const hooks = await wallet.listWebhooks();
    assert.ok(!hooks.some((h) => h.id === hookId));
  });
});

describe("E2E: Validation still works", { skip }, () => {
  let wallet: Wallet;
  before(() => { wallet = makeWallet(); });

  it("rejects invalid address", async () => {
    await assert.rejects(
      () => wallet.send("not-an-address", 5),
      PayValidationError,
    );
  });

  it("rejects amount below minimum", async () => {
    await assert.rejects(
      () => wallet.send("0x" + "a1".repeat(20), 0.5),
      PayValidationError,
    );
  });
});
