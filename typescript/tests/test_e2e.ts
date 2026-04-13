/**
 * E2E acceptance tests — run against live testnet.
 *
 * Skip unless PAYSKILL_TESTNET_KEY is set (any truthy value).
 * Each run generates fresh wallets and mints USDC to avoid rate-limit
 * collisions with prior runs.
 *
 * Usage:
 *   PAYSKILL_TESTNET_KEY=1 node --import tsx --test tests/test_e2e.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Wallet, PayValidationError } from "../src/index.js";

const skip = !process.env.PAYSKILL_TESTNET_KEY;

function generateKey(): string {
  return "0x" + randomBytes(32).toString("hex");
}

describe("E2E: Mint testnet USDC", { skip }, () => {
  it("mints $10 USDC to a fresh wallet", async () => {
    const wallet = new Wallet({ privateKey: generateKey(), testnet: true });
    const result = await wallet.mint(10);
    assert.ok(result.txHash);
    assert.equal(result.amount, 10);
  });
});

describe("E2E: Status + Balance", { skip }, () => {
  let wallet: Wallet;
  before(async () => {
    wallet = new Wallet({ privateKey: generateKey(), testnet: true });
    await wallet.mint(50);
    // Wait for on-chain confirmation
    await new Promise((r) => setTimeout(r, 5000));
  });

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

describe("E2E: Webhook CRUD", { skip }, () => {
  let wallet: Wallet;
  let hookId = "";
  before(async () => {
    wallet = new Wallet({ privateKey: generateKey(), testnet: true });
  });

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
  before(() => {
    wallet = new Wallet({ privateKey: generateKey(), testnet: true });
  });

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
