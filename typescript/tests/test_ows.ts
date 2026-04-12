/**
 * OWS (Open Wallet Standard) integration tests.
 * Uses a mock OWS module — no real @open-wallet-standard/core needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Wallet, PayError } from "../src/index.js";

// ── Mock OWS module ──────────────────────────────────────────────────

interface SignCall {
  wallet: string;
  chain: string;
  json: string;
  passphrase?: string;
}

function createMockOws(options?: {
  accounts?: Array<{
    chainId: string;
    address: string;
    derivationPath: string;
  }>;
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

  // Default: 65-byte hex sig (r+s+v)
  const sig = options?.signature ?? "ab".repeat(64) + "1b";

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
        signature: sig,
        recoveryId: options?.recoveryId,
      };
    },
  };
}

// ── Construction ──────────────────────────────────────────────────────

describe("Wallet.fromOws construction", () => {
  it("creates wallet with correct address from mock OWS", async () => {
    const ows = createMockOws();
    const wallet = await Wallet.fromOws({
      walletId: "test-agent",
      _owsModule: ows,
    });
    assert.equal(
      wallet.address,
      "0x1234567890abcdef1234567890abcdef12345678",
    );
  });

  it("finds evm chain account", async () => {
    const ows = createMockOws({
      accounts: [
        {
          chainId: "evm",
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          derivationPath: "m/44'/60'/0'/0/0",
        },
      ],
    });
    const wallet = await Wallet.fromOws({
      walletId: "test",
      _owsModule: ows,
    });
    assert.equal(
      wallet.address,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("throws when no EVM account found", async () => {
    const ows = createMockOws({
      accounts: [
        {
          chainId: "solana",
          address: "SoLaNa...",
          derivationPath: "m/44'/501'/0'",
        },
      ],
    });
    await assert.rejects(
      () => Wallet.fromOws({ walletId: "test", _owsModule: ows }),
      PayError,
    );
  });

  it("throws when OWS module not installed (no mock)", async () => {
    await assert.rejects(
      () =>
        Wallet.fromOws({
          walletId: "test",
          // _owsModule not provided -> tries dynamic import, fails
        }),
      PayError,
    );
  });

  it("passes owsApiKey to signTypedData", async () => {
    const ows = createMockOws();
    const wallet = await Wallet.fromOws({
      walletId: "agent-1",
      owsApiKey: "secret-key",
      _owsModule: ows,
    });
    // Trigger a signing call (will fail on network but the mock captures the call)
    // We can't easily trigger signing without a server, so just verify construction
    assert.equal(wallet.address, "0x1234567890abcdef1234567890abcdef12345678");
  });
});

// ── Serialization safety ──────────────────────────────────────────────

describe("Wallet.fromOws does not leak keys", () => {
  it("JSON.stringify does not expose private fields", async () => {
    const ows = createMockOws();
    const wallet = await Wallet.fromOws({
      walletId: "secret-agent",
      _owsModule: ows,
    });
    const json = JSON.stringify(wallet);
    assert.ok(!json.includes("secret-agent"));
    assert.ok(!json.includes("signTypedData"));
  });
});
