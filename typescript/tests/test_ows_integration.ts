/**
 * OWS Signer integration test.
 *
 * Requires real @open-wallet-standard/core installed with native binaries.
 * Auto-skips if OWS is not available — safe to run in CI without OWS.
 *
 * Tests:
 * - Creating a real OWS wallet
 * - Constructing OwsSigner from it
 * - Signing EIP-712 Permit typed data
 * - Verifying signature recovers to correct address (ecrecover round-trip)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Check if OWS is available before running tests
let owsAvailable = false;
try {
  const ows = await import("@open-wallet-standard/core");
  ows.listWallets();
  owsAvailable = true;
} catch {
  // OWS not installed — tests will be skipped
}

describe("OwsSigner integration (real OWS)", { skip: !owsAvailable }, () => {
  it("creates signer from real OWS wallet and signs EIP-712 data", async () => {
    const { OwsSigner } = await import("../src/ows-signer.js");
    const { verifyTypedData } = await import("viem");

    // Import OWS module
    const ows = await import("@open-wallet-standard/core");

    // Create a test wallet (unique name to avoid collisions)
    const walletName = `pay-test-${Date.now()}`;
    const walletInfo = ows.createWallet(walletName);
    const evmAccount = walletInfo.accounts.find(
      (a: { chainId: string }) =>
        a.chainId === "evm" || a.chainId.startsWith("eip155:"),
    );
    assert.ok(evmAccount, "OWS wallet must have an EVM account");

    // Create OwsSigner from the real wallet
    const signer = await OwsSigner.create({ walletId: walletName });
    assert.equal(
      signer.address.toLowerCase(),
      evmAccount.address.toLowerCase(),
    );

    // Sign an EIP-712 Permit (the most common signing operation in Pay)
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: 84532,
      verifyingContract:
        "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
    };
    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const message = {
      owner: signer.address,
      spender: "0x0000000000000000000000000000000000000001",
      value: "5000000",
      nonce: "0",
      deadline: "999999999999",
    };

    const signature = await signer.signTypedData(domain, types, message);

    // Verify the signature recovers to the signer's address
    assert.ok(signature.startsWith("0x"), "signature must be 0x-prefixed");
    assert.equal(signature.length, 132, "signature must be 65 bytes (132 hex)");

    const valid = await verifyTypedData({
      address: signer.address as `0x${string}`,
      domain,
      types,
      primaryType: "Permit",
      message: message as Record<string, unknown>,
      signature: signature as `0x${string}`,
    });
    assert.ok(valid, "ecrecover must recover signer address");
  });
});
