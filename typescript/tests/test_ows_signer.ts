/**
 * OWS Signer unit tests.
 *
 * Uses a mock OWS module — no real @open-wallet-standard/core needed.
 * Tests construction, EIP-712 typed data building, signature concatenation,
 * BigInt serialization, error paths, and security (no key leakage).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OwsSigner } from "../src/ows-signer.js";

// ── Mock OWS module ──────────────────────────────────────────────────

interface SignCall {
  wallet: string;
  chain: string;
  json: string;
  passphrase?: string;
}

function createMockOws(options?: {
  accounts?: Array<{ chainId: string; address: string; derivationPath: string }>;
  signature?: string;
  recoveryId?: number;
}) {
  const calls: SignCall[] = [];
  const accounts = options?.accounts ?? [
    {
      chainId: "eip155:8453",
      address: "0x1234567890abcdef1234567890abcdef12345678",
      derivationPath: "m/44'/60'/0'/0/0",
    },
  ];

  return {
    calls,
    getWallet(nameOrId: string) {
      return {
        id: `id-${nameOrId}`,
        name: nameOrId,
        accounts,
        createdAt: "2026-04-01T00:00:00Z",
      };
    },
    signTypedData(
      wallet: string,
      chain: string,
      typedDataJson: string,
      passphrase?: string,
    ) {
      calls.push({ wallet, chain, json: typedDataJson, passphrase });
      return {
        signature: options?.signature ?? "aa".repeat(64),
        recoveryId: options?.recoveryId ?? 0,
      };
    },
  };
}

// ── Construction ─────────────────────────────────────────────────────

describe("OwsSigner.create", () => {
  it("creates signer with eip155 chain id", async () => {
    const mock = createMockOws();
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });
    assert.equal(
      signer.address,
      "0x1234567890abcdef1234567890abcdef12345678",
    );
  });

  it("creates signer with evm chain id", async () => {
    const mock = createMockOws({
      accounts: [
        {
          chainId: "evm",
          address: "0xcafe",
          derivationPath: "m/44'/60'/0'/0/0",
        },
      ],
    });
    const signer = await OwsSigner.create({
      walletId: "pay-evm",
      _owsModule: mock,
    });
    assert.equal(signer.address, "0xcafe");
  });

  it("throws when no EVM account found", async () => {
    const mock = createMockOws({
      accounts: [
        {
          chainId: "solana",
          address: "Sol123",
          derivationPath: "m/44'/501'/0'/0'",
        },
      ],
    });
    await assert.rejects(
      () => OwsSigner.create({ walletId: "pay-sol", _owsModule: mock }),
      { message: /No EVM account found/ },
    );
  });

  it("throws when no accounts at all", async () => {
    const mock = createMockOws({ accounts: [] });
    await assert.rejects(
      () => OwsSigner.create({ walletId: "pay-empty", _owsModule: mock }),
      { message: /No EVM account found/ },
    );
  });

  it("throws clear error when OWS not installed", async () => {
    // Without _owsModule, create() will try dynamic import which will fail
    await assert.rejects(
      () => OwsSigner.create({ walletId: "pay-missing" }),
      { message: /not installed/ },
    );
  });
});

// ── signTypedData ────────────────────────────────────────────────────

describe("OwsSigner.signTypedData", () => {
  const domain = {
    name: "Pay",
    version: "1",
    chainId: 8453,
    verifyingContract: "0xrouter" as const,
  };

  const types = {
    Request: [
      { name: "method", type: "string" },
      { name: "path", type: "string" },
    ],
  };

  const value = { method: "POST", path: "/api/v1/direct" };

  it("builds EIP-712 JSON with EIP712Domain injected", async () => {
    const mock = createMockOws();
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });

    await signer.signTypedData(domain, types, value);

    assert.equal(mock.calls.length, 1);
    const parsed = JSON.parse(mock.calls[0].json);

    // EIP712Domain should be auto-generated from domain fields
    assert.deepStrictEqual(parsed.types.EIP712Domain, [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);

    // Original types preserved
    assert.deepStrictEqual(parsed.types.Request, types.Request);

    // Primary type derived from first non-EIP712Domain key
    assert.equal(parsed.primaryType, "Request");

    // Domain and message passed through
    assert.deepStrictEqual(parsed.domain, domain);
    assert.deepStrictEqual(parsed.message, value);
  });

  it("passes chain as evm always", async () => {
    const mock = createMockOws();
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });

    await signer.signTypedData(domain, types, value);
    assert.equal(mock.calls[0].chain, "evm");
  });

  it("passes API key as passphrase", async () => {
    const mock = createMockOws();
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      owsApiKey: "ows_key_secret123",
      _owsModule: mock,
    });

    await signer.signTypedData(domain, types, value);
    assert.equal(mock.calls[0].passphrase, "ows_key_secret123");

    // API key must NOT appear in the JSON payload
    assert.ok(!mock.calls[0].json.includes("ows_key_secret123"));
  });

  it("only includes domain fields that are present", async () => {
    const mock = createMockOws();
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });

    // Domain with only name and chainId
    await signer.signTypedData(
      { name: "Pay", chainId: 8453 },
      types,
      value,
    );

    const parsed = JSON.parse(mock.calls[0].json);
    assert.deepStrictEqual(parsed.types.EIP712Domain, [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
    ]);
  });

  it("serializes BigInt values to strings", async () => {
    const mock = createMockOws();
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });

    await signer.signTypedData(domain, types, {
      method: "POST",
      path: "/direct",
      amount: 5000000n,
    });

    const parsed = JSON.parse(mock.calls[0].json);
    assert.equal(parsed.message.amount, "5000000");
  });
});

// ── Signature concatenation ──────────────────────────────────────────

describe("signature concatenation", () => {
  it("appends v=27 when recoveryId=0", async () => {
    const mock = createMockOws({
      signature: "aa".repeat(64), // 128 hex = r+s only
      recoveryId: 0,
    });
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });

    const sig = await signer.signTypedData({}, { R: [] }, {});
    assert.ok(sig.startsWith("0x"));
    assert.equal(sig.length, 2 + 130); // 0x + 64r + 64s + 2v
    assert.equal(sig.slice(-2), "1b"); // 27 = 0x1b
  });

  it("appends v=28 when recoveryId=1", async () => {
    const mock = createMockOws({
      signature: "bb".repeat(64),
      recoveryId: 1,
    });
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });

    const sig = await signer.signTypedData({}, { R: [] }, {});
    assert.equal(sig.slice(-2), "1c"); // 28 = 0x1c
  });

  it("passes through 130-char RSV signature as-is", async () => {
    const rsv = "cc".repeat(65); // 130 hex = already has v
    const mock = createMockOws({ signature: rsv });
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });

    const sig = await signer.signTypedData({}, { R: [] }, {});
    assert.equal(sig, `0x${rsv}`);
  });

  it("strips 0x prefix from OWS signature", async () => {
    const mock = createMockOws({
      signature: "0x" + "dd".repeat(64),
      recoveryId: 0,
    });
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });

    const sig = await signer.signTypedData({}, { R: [] }, {});
    assert.ok(!sig.includes("0x0x")); // no double prefix
    assert.equal(sig.length, 2 + 130);
  });

  it("defaults recoveryId to 0 when undefined", async () => {
    const mock = createMockOws({
      signature: "ee".repeat(64),
      recoveryId: undefined,
    });
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });

    const sig = await signer.signTypedData({}, { R: [] }, {});
    assert.equal(sig.slice(-2), "1b"); // v=27
  });
});

// ── sign() rejection ─────────────────────────────────────────────────

describe("sign() raw hash rejection", () => {
  it("throws because OWS only supports EIP-712", async () => {
    const mock = createMockOws();
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      _owsModule: mock,
    });

    assert.throws(
      () => signer.sign(new Uint8Array(32)),
      { message: /does not support raw hash signing/ },
    );
  });
});

// ── Security ─────────────────────────────────────────────────────────

describe("security", () => {
  it("toJSON does not expose API key", async () => {
    const mock = createMockOws();
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      owsApiKey: "ows_key_topsecret",
      _owsModule: mock,
    });

    const json = signer.toJSON();
    assert.ok(!JSON.stringify(json).includes("topsecret"));
    assert.equal(json.walletId, "pay-test");
    assert.ok(json.address);
  });

  it("inspect does not expose API key", async () => {
    const mock = createMockOws();
    const signer = await OwsSigner.create({
      walletId: "pay-test",
      owsApiKey: "ows_key_topsecret",
      _owsModule: mock,
    });

    const inspectFn = signer[Symbol.for("nodejs.util.inspect.custom")] as () => string;
    const output = inspectFn.call(signer);
    assert.ok(!output.includes("topsecret"));
    assert.ok(output.includes("pay-test"));
  });
});
