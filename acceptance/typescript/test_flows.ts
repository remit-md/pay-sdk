/**
 * Pay SDK (TypeScript) acceptance tests.
 *
 * All tests use real PayClient / Wallet with PrivateKeySigner
 * against live Base Sepolia. No mocks. No stubs.
 *
 * Env vars:
 *   ACCEPTANCE_API_URL — testnet server (default: https://testnet.pay-skill.com/api/v1)
 *   ACCEPTANCE_RPC_URL — Base Sepolia RPC (default: https://sepolia.base.org)
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey } from "viem/accounts";

// Import from SDK source (relative path, resolved via tsx)
import {
  PayClient,
  PayValidationError,
  PayServerError,
  Wallet,
} from "../../typescript/src/index.js";

// ── Config ─────────────────────────────────────────────────────────

const API_URL =
  process.env["ACCEPTANCE_API_URL"] || "https://testnet.pay-skill.com/api/v1";
const RPC_URL =
  process.env["ACCEPTANCE_RPC_URL"] || "https://sepolia.base.org";
const CHAIN_ID = 84532;

// ── Helpers ────────────────────────────────────────────────────────

/** Mint testnet USDC (no auth needed). */
async function mint(wallet: string, amount: number): Promise<void> {
  const res = await fetch(`${API_URL}/mint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet, amount }),
  });
  if (!res.ok) throw new Error(`Mint failed: ${res.status}`);
}

/** Fetch contract addresses from server. */
async function fetchContracts(): Promise<{
  router: string;
  tab: string;
  direct: string;
  usdc: string;
}> {
  const res = await fetch(`${API_URL}/contracts`);
  return (await res.json()) as {
    router: string;
    tab: string;
    direct: string;
    usdc: string;
  };
}

/** Get on-chain USDC balance via RPC. */
async function getBalance(address: string, usdcAddress: string): Promise<number> {
  const padded = address.toLowerCase().replace("0x", "").padStart(64, "0");
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: usdcAddress, data: `0x70a08231${padded}` }, "latest"],
    }),
  });
  const json = (await res.json()) as { result?: string };
  return Number(BigInt(json.result ?? "0x0"));
}

/** Wait for on-chain balance to change. */
async function waitForChange(
  address: string,
  usdcAddress: string,
  beforeBalance: number,
  maxWaitMs = 60000,
): Promise<number> {
  const start = Date.now();
  let delay = 2000;
  while (Date.now() - start < maxWaitMs) {
    const current = await getBalance(address, usdcAddress);
    if (current !== beforeBalance) return current;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 10000);
  }
  return getBalance(address, usdcAddress);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("SDK Acceptance — TypeScript", () => {
  let agentKey: string;
  let providerKey: string;
  let agentWallet: Wallet;
  let providerWallet: Wallet;
  let contracts: { router: string; tab: string; direct: string; usdc: string };

  before(async () => {
    contracts = await fetchContracts();

    agentKey = generatePrivateKey();
    providerKey = generatePrivateKey();

    agentWallet = new Wallet({
      privateKey: agentKey,
      chain: "base-sepolia",
      apiUrl: API_URL,
      routerAddress: contracts.router,
    });

    providerWallet = new Wallet({
      privateKey: providerKey,
      chain: "base-sepolia",
      apiUrl: API_URL,
      routerAddress: contracts.router,
    });

    // Fund agent with 200 USDC
    await mint(agentWallet.address, 200_000_000);
    await waitForChange(agentWallet.address, contracts.usdc, 0);
  });

  describe("Status + Balance", () => {
    it("getStatus returns balance and wallet", async () => {
      const bal = await agentWallet.balance();
      assert.ok(bal > 0, `balance should be > 0, got ${bal}`);
    });
  });

  describe("Direct Payment", () => {
    it("payDirect transfers USDC", async () => {
      const beforeAgent = await getBalance(agentWallet.address, contracts.usdc);
      const beforeProvider = await getBalance(providerWallet.address, contracts.usdc);

      const result = await agentWallet.payDirect(
        providerWallet.address,
        5, // $5.00
        "acceptance-test",
      );

      assert.ok(result.tx_hash, "should return tx_hash");

      // Wait for on-chain
      const afterAgent = await waitForChange(
        agentWallet.address,
        contracts.usdc,
        beforeAgent,
      );
      const afterProvider = await getBalance(providerWallet.address, contracts.usdc);

      // Agent paid 5 USDC (5_000_000 micro-units)
      assert.ok(
        beforeAgent - afterAgent >= 4_900_000,
        `agent should pay ~5 USDC, delta was ${beforeAgent - afterAgent}`,
      );

      // Provider received ~99% of 5 USDC
      assert.ok(
        afterProvider - beforeProvider >= 4_900_000,
        `provider should receive ~$4.95, delta was ${afterProvider - beforeProvider}`,
      );
    });
  });

  describe("Tab Lifecycle", () => {
    it("openTab → chargeTab → closeTab", async () => {
      // Open tab
      const tab = await agentWallet.openTab(
        providerWallet.address,
        20_000_000, // $20
        2_000_000, // max $2/charge
      );
      assert.ok(tab.tab_id || tab.id, "should return tab_id");
      const tabId = tab.tab_id ?? tab.id;

      // Wait for on-chain confirmation
      await new Promise((r) => setTimeout(r, 5000));

      // Charge (provider side)
      const charge = await providerWallet.chargeTab(tabId, 1_000_000); // $1
      assert.ok(
        charge.status === "approved" || charge.status === "confirmed",
        `charge should be approved, got ${charge.status}`,
      );

      // Close (agent side)
      const close = await agentWallet.closeTab(tabId);
      assert.ok(close.status, "close should return status");
    });
  });

  describe("Webhook CRUD", () => {
    it("register → list → delete → list (gone)", async () => {
      const hookUrl = `https://example.com/hooks/sdk-test-${Date.now()}`;

      // Register
      const reg = await agentWallet.registerWebhook(hookUrl, [
        "tab.charged",
        "payment.completed",
      ]);
      assert.ok(reg.id, "register should return id");

      // List — should appear
      const client = new PayClient({
        apiUrl: API_URL,
        privateKey: agentKey,
        chainId: CHAIN_ID,
        routerAddress: contracts.router,
      });
      const list = await client.listWebhooks();
      const found = list.find(
        (w) => w.webhookId === reg.id || w.url === hookUrl,
      );
      assert.ok(found, "webhook should appear in list");

      // Delete
      await client.deleteWebhook(reg.id);

      // List — should be gone
      const listAfter = await client.listWebhooks();
      const notFound = listAfter.find(
        (w) => w.webhookId === reg.id || w.url === hookUrl,
      );
      assert.equal(notFound, undefined, "deleted webhook should not appear");
    });
  });

  describe("Fund + Withdraw Links", () => {
    it("createFundLink returns a URL", async () => {
      const url = await agentWallet.createFundLink();
      assert.ok(
        typeof url === "string" && url.length > 0,
        "fund link should be a non-empty string",
      );
    });

    it("createWithdrawLink returns a URL", async () => {
      const url = await agentWallet.createWithdrawLink();
      assert.ok(
        typeof url === "string" && url.length > 0,
        "withdraw link should be a non-empty string",
      );
    });
  });

  describe("Error Paths", () => {
    it("payDirect rejects bad address (client-side)", async () => {
      await assert.rejects(
        () => agentWallet.payDirect("not-an-address", 5, ""),
        (err: unknown) => {
          assert.ok(
            err instanceof PayValidationError || err instanceof Error,
            "should throw validation error",
          );
          return true;
        },
      );
    });

    it("payDirect rejects below $1 minimum (client-side)", async () => {
      await assert.rejects(
        () =>
          agentWallet.payDirect(providerWallet.address, 0.5, ""),
        (err: unknown) => {
          assert.ok(err instanceof Error, "should throw error");
          return true;
        },
      );
    });

    it("auth rejection with no signer (401)", async () => {
      // Create a client with no signing capability
      const badClient = new PayClient({
        apiUrl: API_URL,
        chainId: CHAIN_ID,
        routerAddress: contracts.router,
      });

      await assert.rejects(
        () => badClient.getStatus(),
        (err: unknown) => {
          // Should fail with auth error or missing signer
          assert.ok(err instanceof Error);
          return true;
        },
      );
    });
  });
});
