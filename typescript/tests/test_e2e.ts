/**
 * E2E acceptance tests — run against live testnet.
 *
 * Skip unless PAYSKILL_TESTNET_KEY is set. These hit the real testnet server
 * and exercise the full SDK → server → chain round-trip.
 *
 * Usage:
 *   PAYSKILL_TESTNET_KEY=0xdead... node --import tsx --test tests/test_e2e.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { PayClient, CallbackSigner, PayValidationError } from "../src/index.js";
import type { Tab, WebhookRegistration } from "../src/index.js";

const TESTNET_URL = process.env.PAYSKILL_TESTNET_URL ?? "https://testnet.pay-skill.com/api/v1";
const TESTNET_KEY = process.env.PAYSKILL_TESTNET_KEY ?? "";
const PROVIDER_ADDR = process.env.PAYSKILL_TESTNET_PROVIDER ?? ("0x" + "b2".repeat(20));

const skip = !TESTNET_KEY;

function makeSigner(): CallbackSigner {
  // Dummy signer — server may accept unsigned requests on testnet
  return new CallbackSigner((_hash: Uint8Array) => new Uint8Array(65));
}

let client: PayClient;

// ── Connectivity ────────────────────────────────────────────────────

describe("E2E: Status", { skip }, () => {
  before(() => {
    client = new PayClient({ apiUrl: TESTNET_URL, signer: makeSigner() });
  });

  it("returns valid status from testnet", async () => {
    const status = await client.getStatus();
    assert.ok(typeof status.address === "string");
    assert.ok(typeof status.balance === "number");
    assert.ok(status.balance >= 0);
    assert.ok(Array.isArray(status.openTabs));
  });
});

// ── Direct Payment ──────────────────────────────────────────────────

describe("E2E: Direct Payment", { skip }, () => {
  before(() => {
    client = new PayClient({ apiUrl: TESTNET_URL, signer: makeSigner() });
  });

  it("client-side validation catches bad inputs", () => {
    assert.throws(
      () => client.payDirect("not-an-address", 1_000_000),
      (err: unknown) => err instanceof PayValidationError
    );
  });

  it("sends $1 USDC via direct payment", async () => {
    const result = await client.payDirect(PROVIDER_ADDR, 1_000_000, { memo: "e2e-test" });
    assert.ok(result.txHash);
    assert.ok(["confirmed", "pending"].includes(result.status));
    assert.equal(result.amount, 1_000_000);
    assert.ok(result.fee > 0); // 1% fee
  });
});

// ── Tab Lifecycle ───────────────────────────────────────────────────

describe("E2E: Tab Lifecycle", { skip }, () => {
  let tabId = "";

  before(() => {
    client = new PayClient({ apiUrl: TESTNET_URL, signer: makeSigner() });
  });

  it("opens a $5 tab", async () => {
    const tab = await client.openTab(PROVIDER_ADDR, 5_000_000, { maxChargePerCall: 500_000 });
    assert.ok(tab.tabId);
    assert.equal(tab.provider, PROVIDER_ADDR);
    assert.equal(tab.status, "open");
    assert.equal(tab.maxChargePerCall, 500_000);
    assert.equal(tab.chargeCount, 0);
    // Activation fee deducted
    assert.ok(tab.balanceRemaining <= 5_000_000);
    tabId = tab.tabId;
  });

  it("lists tabs including the new one", async () => {
    const tabs = await client.listTabs();
    assert.ok(Array.isArray(tabs));
    const ids = tabs.map((t: Tab) => t.tabId);
    assert.ok(ids.includes(tabId));
  });

  it("gets the specific tab", async () => {
    const tab = await client.getTab(tabId);
    assert.equal(tab.tabId, tabId);
    assert.equal(tab.status, "open");
  });

  it("tops up the tab", async () => {
    const before = await client.getTab(tabId);
    const tab = await client.topUpTab(tabId, 5_000_000);
    assert.ok(tab.balanceRemaining > before.balanceRemaining);
  });

  it("closes the tab", async () => {
    const tab = await client.closeTab(tabId);
    assert.equal(tab.status, "closed");
  });
});

// ── Webhooks ────────────────────────────────────────────────────────

describe("E2E: Webhook CRUD", { skip }, () => {
  let whId = "";

  before(() => {
    client = new PayClient({ apiUrl: TESTNET_URL, signer: makeSigner() });
  });

  it("registers a webhook", async () => {
    const slug = randomUUID().slice(0, 8);
    const wh = await client.registerWebhook(`https://example.com/hook/${slug}`, {
      events: ["tab.charged", "payment.completed"],
      secret: `whsec_test_${slug}`,
    });
    assert.ok(wh.webhookId);
    assert.ok(wh.url.startsWith("https://"));
    assert.ok(wh.events.includes("tab.charged"));
    whId = wh.webhookId;
  });

  it("lists webhooks including the new one", async () => {
    const webhooks = await client.listWebhooks();
    assert.ok(Array.isArray(webhooks));
    const ids = webhooks.map((w: WebhookRegistration) => w.webhookId);
    assert.ok(ids.includes(whId));
  });

  it("deletes the webhook", async () => {
    await client.deleteWebhook(whId);
    const webhooks = await client.listWebhooks();
    const ids = webhooks.map((w: WebhookRegistration) => w.webhookId);
    assert.ok(!ids.includes(whId));
  });
});

// ── Funding Links ───────────────────────────────────────────────────

describe("E2E: Funding Links", { skip }, () => {
  before(() => {
    client = new PayClient({ apiUrl: TESTNET_URL, signer: makeSigner() });
  });

  it("returns a fund link", async () => {
    const link = await client.createFundLink(10_000_000);
    assert.ok(link);
    assert.ok(link.startsWith("https://"));
  });

  it("returns a withdraw link", async () => {
    const link = await client.createWithdrawLink(5_000_000);
    assert.ok(link);
    assert.ok(link.startsWith("https://"));
  });
});
