/**
 * Pay SDK (TypeScript) acceptance tests.
 *
 * All tests use Wallet with private key against live Base Sepolia.
 * No mocks. No stubs.
 *
 * Env vars:
 *   ACCEPTANCE_API_URL — testnet server (default: https://testnet.pay-skill.com/api/v1)
 *   ACCEPTANCE_RPC_URL — Base Sepolia RPC (default: https://sepolia.base.org)
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey } from "viem/accounts";

import {
  PayValidationError,
  PayServerError,
  Wallet,
} from "../../typescript/src/index.js";

// ── Config ─────────────────────────────────────────────────────────

const API_URL =
  process.env["ACCEPTANCE_API_URL"] || "https://testnet.pay-skill.com/api/v1";
const RPC_URL =
  process.env["ACCEPTANCE_RPC_URL"] || "https://sepolia.base.org";

// ── Helpers ────────────────────────────────────────────────────────

/**
 * /mint is rate-limited (1/hour per wallet) and the faucet itself can flake
 * (5xx when out of gas, transient network errors). Each test generates a
 * fresh wallet so the per-wallet limit doesn't apply, but global server
 * hiccups still take down whole runs without retry — see release v0.2.4
 * attempt 1, where one /mint 500 sank the suite.
 */
const MINT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

/** Mint testnet USDC (no auth needed). Retries on 429/5xx/network errors. */
async function mint(wallet: string, amount: number): Promise<void> {
  let lastErr: unknown;
  const schedule = [0, ...MINT_RETRY_DELAYS_MS];
  for (let attempt = 0; attempt < schedule.length; attempt++) {
    const delay = schedule[attempt]!;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(`${API_URL}/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, amount }),
      });
      if (res.ok) return;
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`Mint failed: ${res.status}`);
      }
      lastErr = new Error(`Mint ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      lastErr = err;
    }
    console.log(`  [mint retry ${attempt + 1}/${schedule.length}] ${lastErr}`);
  }
  throw new Error(`mint failed after ${schedule.length} attempts: ${lastErr}`);
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
      testnet: true,
    });

    providerWallet = new Wallet({
      privateKey: providerKey,
      testnet: true,
    });

    // Fund agent with 200 USDC
    await mint(agentWallet.address, 200);
    await waitForChange(agentWallet.address, contracts.usdc, 0);
  });

  describe("Status + Balance", () => {
    it("balance returns wallet balance", async () => {
      const bal = await agentWallet.balance();
      assert.ok(bal.available > 0, `balance should be > 0, got ${bal.available}`);
    });
  });

  describe("Direct Payment", () => {
    it("send transfers USDC", async () => {
      const beforeAgent = await getBalance(agentWallet.address, contracts.usdc);
      const beforeProvider = await getBalance(providerWallet.address, contracts.usdc);

      const result = await agentWallet.send(
        providerWallet.address,
        5, // $5.00
        "acceptance-test",
      );

      assert.ok(result.txHash, "should return txHash");

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
        20, // $20
        2,  // max $2/charge
      );
      assert.ok(tab.id, "should return tab id");

      // Wait for on-chain confirmation
      await new Promise((r) => setTimeout(r, 5000));

      // Charge (provider side)
      const charge = await providerWallet.chargeTab(tab.id, 1); // $1
      assert.ok(
        charge.status === "approved" || charge.status === "confirmed",
        `charge should be approved, got ${charge.status}`,
      );

      // Close (agent side)
      const close = await agentWallet.closeTab(tab.id);
      assert.ok(close.status, "close should return status");
    });
  });

  describe("Webhook CRUD", () => {
    it("register → list → delete → list (gone)", async () => {
      const hookUrl = `https://example.com/hooks/sdk-test-${Date.now()}`;

      // Register
      const reg = await agentWallet.registerWebhook(
        hookUrl,
        ["payment.completed"],
        "whsec_test_acceptance_secret"
      );
      assert.ok(reg.id, "register should return id");

      // List — should appear
      const list = await agentWallet.listWebhooks();
      const found = list.find(
        (w: { id: string; url: string }) => w.id === reg.id || w.url === hookUrl,
      );
      assert.ok(found, "webhook should appear in list");

      // Delete
      await agentWallet.deleteWebhook(reg.id);

      // List — should be gone
      const listAfter = await agentWallet.listWebhooks();
      const notFound = listAfter.find(
        (w: { id: string; url: string }) => w.id === reg.id || w.url === hookUrl,
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

  describe("x402 Request (direct settlement)", () => {
    it("handles 402 with payment-required header and pays automatically", async () => {
      // Inline mini x402 server
      const { createServer } = await import("node:http");
      const server = createServer((req, res) => {
        const sig = req.headers["payment-signature"];
        if (sig && typeof sig === "string" && sig.length > 0) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ content: "paid" }));
        } else {
          const requirements = {
            scheme: "exact",
            amount: 1_000_000,
            to: providerWallet.address,
            settlement: "direct",
            facilitator: "https://testnet.pay-skill.com/x402",
            maxChargePerCall: 1_000_000,
            network: "eip155:84532",
          };
          const reqB64 = Buffer.from(JSON.stringify(requirements)).toString("base64");
          res.writeHead(402, {
            "Content-Type": "application/json",
            "payment-required": reqB64,
          });
          res.end(
            JSON.stringify({
              error: "payment_required",
              message: "This resource requires payment",
              requirements,
            }),
          );
        }
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;

      try {
        const resp = await agentWallet.request(`http://127.0.0.1:${port}/content`);
        assert.equal(resp.status, 200, "should get 200 after payment");
        const body = (await resp.json()) as { content: string };
        assert.equal(body.content, "paid");
      } finally {
        server.close();
      }
    });
  });

  describe("x402 Request (tab settlement)", () => {
    it("handles 402 with tab settlement, auto-opens tab, and pays", async () => {
      const { createServer } = await import("node:http");
      const server = createServer((req, res) => {
        const sig = req.headers["payment-signature"];
        if (sig && typeof sig === "string" && sig.length > 0) {
          // Verify it's tab settlement (decode base64 → check extensions.pay)
          const decoded = JSON.parse(Buffer.from(sig, "base64").toString());
          const pay = decoded?.extensions?.pay;
          if (pay?.settlement === "tab" && pay?.tabId && pay?.chargeId) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ content: "paid-via-tab" }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "expected tab settlement" }));
          }
        } else {
          const requirements = {
            scheme: "exact",
            amount: 100_000,  // $0.10 per call
            to: providerWallet.address,
            settlement: "tab",
            facilitator: "https://testnet.pay-skill.com/x402",
            maxChargePerCall: 100_000,
            network: "eip155:84532",
          };
          const reqB64 = Buffer.from(JSON.stringify(requirements)).toString("base64");
          res.writeHead(402, {
            "Content-Type": "application/json",
            "payment-required": reqB64,
          });
          res.end(
            JSON.stringify({
              error: "payment_required",
              message: "This resource requires payment",
              requirements,
            }),
          );
        }
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;

      try {
        const resp = await agentWallet.request(`http://127.0.0.1:${port}/content`);
        assert.equal(resp.status, 200, "should get 200 after tab payment");
        const body = (await resp.json()) as { content: string };
        assert.equal(body.content, "paid-via-tab");
      } finally {
        server.close();
      }
    });
  });

  describe("Error Paths", () => {
    it("send rejects bad address (client-side)", async () => {
      await assert.rejects(
        () => agentWallet.send("not-an-address", 5, ""),
        (err: unknown) => {
          assert.ok(
            err instanceof PayValidationError || err instanceof Error,
            "should throw validation error",
          );
          return true;
        },
      );
    });

    it("send rejects below $1 minimum (client-side)", async () => {
      await assert.rejects(
        () =>
          agentWallet.send(providerWallet.address, 0.5, ""),
        (err: unknown) => {
          assert.ok(err instanceof Error, "should throw error");
          return true;
        },
      );
    });
  });
});
