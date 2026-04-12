/**
 * Crypto round-trip tests — proves that:
 * 1. Address derivation uses real secp256k1
 * 2. buildAuthHeaders produces valid recoverable signatures
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recoverAddress, type Hex, type Address } from "viem";

import { Wallet } from "../src/wallet.js";
import { buildAuthHeaders, buildAuthHeadersSigned, computeEip712Hash } from "../src/auth.js";

// Anvil account #0 — well-known test key
const ANVIL_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ANVIL_ADDRESS =
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

const TEST_ROUTER =
  "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const TEST_CHAIN_ID = 8453;

describe("Address derivation", () => {
  it("derives correct address from Anvil #0 private key", () => {
    const wallet = new Wallet({ privateKey: ANVIL_PK });
    assert.equal(wallet.address, ANVIL_ADDRESS);
  });

  it("works without 0x prefix", () => {
    const wallet = new Wallet({ privateKey: ANVIL_PK.slice(2) });
    assert.equal(wallet.address, ANVIL_ADDRESS);
  });
});

describe("buildAuthHeaders", () => {
  it("produces valid auth headers with correct address", async () => {
    const headers = await buildAuthHeaders(
      ANVIL_PK,
      "POST",
      "/api/v1/direct",
      { chainId: TEST_CHAIN_ID, routerAddress: TEST_ROUTER },
    );
    assert.equal(headers["X-Pay-Agent"], ANVIL_ADDRESS);
    assert.ok(headers["X-Pay-Signature"].startsWith("0x"));
    assert.equal(headers["X-Pay-Signature"].length, 132);
    assert.ok(Number(headers["X-Pay-Timestamp"]) > 0);
    assert.ok(headers["X-Pay-Nonce"].startsWith("0x"));
    assert.equal(headers["X-Pay-Nonce"].length, 66);
  });

  it("signature recovers to the correct address", async () => {
    const headers = await buildAuthHeaders(
      ANVIL_PK,
      "POST",
      "/api/v1/direct",
      { chainId: TEST_CHAIN_ID, routerAddress: TEST_ROUTER },
    );
    const { hashTypedData } = await import("viem");
    const hash = hashTypedData({
      domain: {
        name: "pay",
        version: "0.1",
        chainId: TEST_CHAIN_ID,
        verifyingContract: TEST_ROUTER,
      },
      types: {
        APIRequest: [
          { name: "method", type: "string" },
          { name: "path", type: "string" },
          { name: "timestamp", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "APIRequest",
      message: {
        method: "POST",
        path: "/api/v1/direct",
        timestamp: BigInt(headers["X-Pay-Timestamp"]),
        nonce: headers["X-Pay-Nonce"] as Hex,
      },
    });
    const recovered = await recoverAddress({
      hash,
      signature: headers["X-Pay-Signature"] as Hex,
    });
    assert.equal(recovered.toLowerCase(), ANVIL_ADDRESS.toLowerCase());
  });
});

describe("buildAuthHeadersSigned", () => {
  it("produces same-structure headers as buildAuthHeaders", async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(ANVIL_PK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signFn = (p: any) => account.signTypedData(p);

    const headers = await buildAuthHeadersSigned(
      ANVIL_ADDRESS,
      signFn,
      "GET",
      "/api/v1/status",
      { chainId: TEST_CHAIN_ID, routerAddress: TEST_ROUTER },
    );
    assert.equal(headers["X-Pay-Agent"], ANVIL_ADDRESS);
    assert.ok(headers["X-Pay-Signature"].startsWith("0x"));
    assert.equal(headers["X-Pay-Signature"].length, 132);
  });
});

describe("computeEip712Hash", () => {
  const nonce =
    "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex;

  it("produces deterministic output", () => {
    const h1 = computeEip712Hash(
      "POST", "/api/v1/direct", BigInt(1741400000),
      nonce, TEST_CHAIN_ID, TEST_ROUTER,
    );
    const h2 = computeEip712Hash(
      "POST", "/api/v1/direct", BigInt(1741400000),
      nonce, TEST_CHAIN_ID, TEST_ROUTER,
    );
    assert.deepEqual(h1, h2);
  });

  it("different methods produce different hashes", () => {
    const h1 = computeEip712Hash(
      "POST", "/api/v1/direct", BigInt(1741400000),
      nonce, TEST_CHAIN_ID, TEST_ROUTER,
    );
    const h2 = computeEip712Hash(
      "GET", "/api/v1/direct", BigInt(1741400000),
      nonce, TEST_CHAIN_ID, TEST_ROUTER,
    );
    assert.notDeepEqual(h1, h2);
  });
});
