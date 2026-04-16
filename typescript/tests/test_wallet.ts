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

// ── settle() ──────────────────────────────────────────────────────

describe("settle", () => {
  const originalFetch = globalThis.fetch;
  let wallet: Wallet;

  const CONTRACTS = {
    router: "0x" + "11".repeat(20),
    tab: "0x" + "22".repeat(20),
    direct: "0x" + "33".repeat(20),
    fee: "0x" + "44".repeat(20),
    usdc: "0x" + "55".repeat(20),
    relayer: "0x" + "66".repeat(20),
    chain_id: 84532,
  };
  const PROVIDER = "0x" + "aa".repeat(20);

  beforeEach(() => {
    wallet = new Wallet({ privateKey: ANVIL_PK, testnet: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function make402Body(settlement: string, amount = 100000) {
    return {
      accepts: [{
        amount,
        payTo: PROVIDER,
        extra: { settlement },
      }],
    };
  }

  it("direct settlement returns amount and settlement type", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/contracts")) {
        return new Response(JSON.stringify(CONTRACTS));
      }
      // Retry request after payment
      return new Response(JSON.stringify({ data: "paid" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const resp402 = new Response(JSON.stringify(make402Body("direct")), {
      status: 402,
    });
    const result = await wallet.settle(resp402, "https://api.example.com/data");
    assert.equal(result.amount, 100000);
    assert.equal(result.settlement, "direct");
    assert.equal(result.response.status, 200);
  });

  it("tab settlement returns amount and settlement type", async () => {
    let tabsGetCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/contracts")) {
        return new Response(JSON.stringify(CONTRACTS));
      }
      if (url.includes("/status")) {
        return new Response(JSON.stringify({
          balance_usdc: "100.00",
          total_locked: 0,
        }));
      }
      if (url.includes("/permit/prepare")) {
        return new Response(JSON.stringify({
          hash: "0x" + "aa".repeat(32),
          nonce: "1",
          deadline: 9999999999,
        }));
      }
      if (url.includes("/charge")) {
        return new Response(JSON.stringify({
          charge_id: "ch-001",
          status: "buffered",
        }));
      }
      if (url.includes("/tabs")) {
        if (method === "GET" && !tabsGetCalled) {
          tabsGetCalled = true;
          return new Response(JSON.stringify([]), { status: 200 });
        }
        // POST /tabs — open new tab
        return new Response(JSON.stringify({
          id: "tab-001",
          tab_id: "tab-001",
          provider: PROVIDER,
          amount: 5000000,
          status: "open",
        }));
      }
      // Retry request to origin
      return new Response(JSON.stringify({ data: "paid" }), { status: 200 });
    }) as typeof fetch;

    const resp402 = new Response(JSON.stringify(make402Body("tab")), {
      status: 402,
    });
    const result = await wallet.settle(resp402, "https://api.example.com/data");
    assert.equal(result.amount, 100000);
    assert.equal(result.settlement, "tab");
    assert.equal(result.response.status, 200);
  });

  it("forwards method and body to retry request", async () => {
    let lastRequest: { url: string; method?: string; body?: string | null; headers?: Record<string, string> } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/contracts")) {
        return new Response(JSON.stringify(CONTRACTS));
      }
      // Capture the retry request (to api.example.com)
      if (url.includes("api.example.com")) {
        lastRequest = {
          url,
          method: init?.method ?? "GET",
          body: init?.body as string | null,
          headers: Object.fromEntries(
            new Headers(init?.headers as HeadersInit).entries(),
          ),
        };
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const resp402 = new Response(JSON.stringify(make402Body("direct")), {
      status: 402,
    });
    await wallet.settle(resp402, "https://api.example.com/data", {
      method: "POST",
      body: '{"key":"val"}',
    });

    assert.ok(lastRequest, "retry request should have been captured");
    assert.equal(lastRequest!.method, "POST");
    assert.ok(lastRequest!.headers?.["payment-signature"], "should have PAYMENT-SIGNATURE header");
  });
});
