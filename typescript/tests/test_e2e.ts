/**
 * E2E acceptance tests — run against live testnet.
 *
 * Skip unless PAYSKILL_TESTNET_KEY is set. These hit the real testnet server
 * and exercise the full SDK → server round-trip with REAL authentication.
 *
 * Usage:
 *   PAYSKILL_TESTNET_KEY=0xdead... \
 *   PAYSKILL_TESTNET_URL=http://204.168.133.111:3001/api/v1 \
 *   node --import tsx --test tests/test_e2e.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { PayClient, PayValidationError, PayServerError, buildAuthHeaders } from "../src/index.js";
import type { WebhookRegistration, AuthHeaders } from "../src/index.js";
import type { Hex } from "viem";

const TESTNET_URL =
  process.env.PAYSKILL_TESTNET_URL ?? "http://204.168.133.111:3001/api/v1";
const TESTNET_KEY = process.env.PAYSKILL_TESTNET_KEY ?? "";

// Testnet contract addresses (Base Sepolia)
const CHAIN_ID = 84532;
const ROUTER_ADDRESS = "0x3A6d9C4d5f0ef2E2f282A6BB0BDf6d4707ea3B95";

const skip = !TESTNET_KEY;

function makeClient(): PayClient {
  return new PayClient({
    apiUrl: TESTNET_URL,
    privateKey: TESTNET_KEY,
    chainId: CHAIN_ID,
    routerAddress: ROUTER_ADDRESS,
  });
}

// ── Auth Verification ──────────────────────────────────────────────

describe("E2E: Auth works with real signing", { skip }, () => {
  let client: PayClient;

  before(() => {
    client = makeClient();
  });

  it("status endpoint returns valid response with real auth", async () => {
    const status = await client.getStatus();
    assert.ok(typeof status.address === "string");
    assert.ok(status.address.startsWith("0x"));
    assert.ok(typeof status.balance === "number");
    assert.ok(status.balance >= 0);
    assert.ok(Array.isArray(status.openTabs));
  });

  it("rejects request without auth headers (raw fetch)", async () => {
    const resp = await fetch(`${TESTNET_URL}/status`);
    assert.equal(resp.status, 400, "should reject unauthenticated request");
    const body = (await resp.json()) as { error: string };
    assert.equal(body.error, "auth_missing");
  });
});

// ── Mint (Testnet Faucet) ──────────────────────────────────────────

describe("E2E: Mint testnet USDC", { skip }, () => {
  let client: PayClient;

  before(() => {
    client = makeClient();
  });

  it("mints $10 USDC to the authenticated wallet", async () => {
    const headers = await buildAuthHeaders(
      TESTNET_KEY as Hex,
      "POST",
      "/mint",
      { chainId: CHAIN_ID, routerAddress: ROUTER_ADDRESS }
    );
    const resp = await fetch(`${TESTNET_URL}/mint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ amount: 10_000_000 }),
    });
    assert.equal(resp.status, 200, `mint failed: ${await resp.text()}`);
    const body = (await resp.json()) as { tx_hash: string; amount: number; to: string };
    assert.ok(body.tx_hash, "should return a tx_hash");
    assert.equal(body.amount, 10_000_000);
    assert.ok(body.to.startsWith("0x"));
  });
});

// ── Webhook CRUD ───────────────────────────────────────────────────

describe("E2E: Webhook CRUD with real auth", { skip }, () => {
  let client: PayClient;
  let whId = "";

  before(() => {
    client = makeClient();
  });

  it("registers a webhook", async () => {
    const slug = randomUUID().slice(0, 8);
    const wh = await client.registerWebhook(
      `https://example.com/hook/${slug}`,
      {
        events: ["tab.charged", "payment.completed"],
        secret: `whsec_test_${slug}`,
      }
    );
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

// ── Client-side validation still works ─────────────────────────────

describe("E2E: Client validation", { skip }, () => {
  let client: PayClient;

  before(() => {
    client = makeClient();
  });

  it("rejects invalid address", () => {
    assert.throws(
      () => client.payDirect("not-an-address", 1_000_000),
      (err: unknown) => err instanceof PayValidationError
    );
  });

  it("rejects amount below minimum", () => {
    assert.throws(
      () => client.payDirect("0x" + "a1".repeat(20), 500_000),
      (err: unknown) => err instanceof PayValidationError
    );
  });
});
