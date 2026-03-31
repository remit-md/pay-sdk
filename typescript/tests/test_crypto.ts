/**
 * Crypto round-trip tests — proves that:
 * 1. Address derivation uses real secp256k1 (not FNV hash)
 * 2. EIP-712 signing produces valid signatures that the server can recover
 * 3. buildAuthHeaders produces valid auth headers
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { recoverAddress, type Hex, type Address } from "viem";

import { PrivateKeySigner, Wallet } from "../src/wallet.js";
import { RawKeySigner } from "../src/signer.js";
import { buildAuthHeaders, computeEip712Hash } from "../src/auth.js";

// Anvil account #0 — well-known test key
const ANVIL_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

const TEST_ROUTER = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const TEST_CHAIN_ID = 8453;

describe("Address derivation", () => {
  it("derives correct address from Anvil #0 private key via Wallet", () => {
    const wallet = new Wallet({
      privateKey: ANVIL_PK,
      chain: "8453",
      apiUrl: "http://localhost:3000/api/v1",
      routerAddress: TEST_ROUTER,
    });
    assert.equal(wallet.address, ANVIL_ADDRESS);
  });

  it("derives correct address via PrivateKeySigner", () => {
    const signer = new PrivateKeySigner(ANVIL_PK);
    assert.equal(signer.address, ANVIL_ADDRESS);
  });

  it("derives correct address via RawKeySigner", () => {
    const signer = new RawKeySigner(ANVIL_PK);
    assert.equal(signer.address, ANVIL_ADDRESS);
  });

  it("works without 0x prefix", () => {
    const signer = new PrivateKeySigner(ANVIL_PK.slice(2));
    assert.equal(signer.address, ANVIL_ADDRESS);
  });
});

describe("EIP-712 signing round-trip", () => {
  it("PrivateKeySigner produces recoverable EIP-712 signature", async () => {
    const signer = new PrivateKeySigner(ANVIL_PK);

    const domain = {
      name: "pay",
      version: "0.1",
      chainId: BigInt(TEST_CHAIN_ID),
      verifyingContract: TEST_ROUTER,
    };
    const types = {
      APIRequest: [
        { name: "method", type: "string" },
        { name: "path", type: "string" },
        { name: "timestamp", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };
    const nonce =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const message = {
      method: "POST",
      path: "/api/v1/direct",
      timestamp: BigInt(1741400000),
      nonce,
    };

    const signature = await signer.signTypedData(domain, types, message);

    assert.ok(signature.startsWith("0x"), "signature should be hex");
    assert.equal(signature.length, 132, "signature should be 65 bytes hex");
    assert.notEqual(
      signature,
      "0x" + "0".repeat(130),
      "signature must not be zeros (stub)"
    );

    // Recover the signer address from the signature
    const recovered = await recoverAddress({
      hash: (await import("viem")).hashTypedData({
        domain,
        types,
        primaryType: "APIRequest",
        message,
      }),
      signature: signature as Hex,
    });

    assert.equal(
      recovered.toLowerCase(),
      ANVIL_ADDRESS.toLowerCase(),
      "recovered address must match signer"
    );
  });
});

describe("buildAuthHeaders", () => {
  it("produces valid auth headers with correct address", async () => {
    const headers = await buildAuthHeaders(ANVIL_PK, "POST", "/api/v1/direct", {
      chainId: TEST_CHAIN_ID,
      routerAddress: TEST_ROUTER,
    });

    assert.equal(headers["X-Pay-Agent"], ANVIL_ADDRESS);
    assert.ok(
      headers["X-Pay-Signature"].startsWith("0x"),
      "signature should be hex"
    );
    assert.equal(
      headers["X-Pay-Signature"].length,
      132,
      "signature should be 65 bytes"
    );
    assert.ok(
      Number(headers["X-Pay-Timestamp"]) > 0,
      "timestamp should be positive"
    );
    assert.ok(
      headers["X-Pay-Nonce"].startsWith("0x"),
      "nonce should be hex"
    );
    assert.equal(
      headers["X-Pay-Nonce"].length,
      66,
      "nonce should be 32 bytes hex"
    );
  });

  it("signature recovers to the correct address", async () => {
    const headers = await buildAuthHeaders(ANVIL_PK, "POST", "/api/v1/direct", {
      chainId: TEST_CHAIN_ID,
      routerAddress: TEST_ROUTER,
    });

    // Recompute the hash and recover
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

    assert.equal(
      recovered.toLowerCase(),
      ANVIL_ADDRESS.toLowerCase(),
      "recovered address must match signer"
    );
  });
});

describe("computeEip712Hash", () => {
  it("produces deterministic output", () => {
    const nonce =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex;
    const h1 = computeEip712Hash(
      "POST",
      "/api/v1/direct",
      BigInt(1741400000),
      nonce,
      TEST_CHAIN_ID,
      TEST_ROUTER
    );
    const h2 = computeEip712Hash(
      "POST",
      "/api/v1/direct",
      BigInt(1741400000),
      nonce,
      TEST_CHAIN_ID,
      TEST_ROUTER
    );
    assert.deepEqual(h1, h2);
  });

  it("different methods produce different hashes", () => {
    const nonce =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex;
    const h1 = computeEip712Hash(
      "POST",
      "/api/v1/direct",
      BigInt(1741400000),
      nonce,
      TEST_CHAIN_ID,
      TEST_ROUTER
    );
    const h2 = computeEip712Hash(
      "GET",
      "/api/v1/direct",
      BigInt(1741400000),
      nonce,
      TEST_CHAIN_ID,
      TEST_ROUTER
    );
    assert.notDeepEqual(h1, h2);
  });

  it("different chain IDs produce different hashes", () => {
    const nonce =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex;
    const h1 = computeEip712Hash(
      "POST",
      "/api/v1/direct",
      BigInt(1741400000),
      nonce,
      8453,
      TEST_ROUTER
    );
    const h2 = computeEip712Hash(
      "POST",
      "/api/v1/direct",
      BigInt(1741400000),
      nonce,
      84531,
      TEST_ROUTER
    );
    assert.notDeepEqual(h1, h2);
  });
});
