"""Crypto round-trip tests for the pay Python SDK.

Proves that:
1. Address derivation uses real secp256k1
2. EIP-712 signing produces valid recoverable signatures
3. build_auth_headers produces valid auth headers
"""

from eth_account import Account
from eth_account.messages import encode_typed_data

from payskill.auth import build_auth_headers, derive_address

# Anvil account #0 -- well-known test key
ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

TEST_ROUTER = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
TEST_CHAIN_ID = 8453


class TestAddressDerivation:
    def test_derive_address_from_anvil_key(self) -> None:
        addr = derive_address(ANVIL_PK)
        assert addr.lower() == ANVIL_ADDRESS.lower()

    def test_derive_address_without_prefix(self) -> None:
        addr = derive_address(ANVIL_PK[2:])
        assert addr.lower() == ANVIL_ADDRESS.lower()


class TestBuildAuthHeaders:
    def test_produces_valid_headers(self) -> None:
        headers = build_auth_headers(ANVIL_PK, "POST", "/api/v1/direct", TEST_CHAIN_ID, TEST_ROUTER)

        assert headers["X-Pay-Agent"].lower() == ANVIL_ADDRESS.lower()
        assert headers["X-Pay-Signature"].startswith("0x") or len(headers["X-Pay-Signature"]) > 0
        assert int(headers["X-Pay-Timestamp"]) > 0
        assert headers["X-Pay-Nonce"].startswith("0x")
        assert len(headers["X-Pay-Nonce"]) == 66  # 0x + 64 hex chars

    def test_signature_recovers_to_correct_address(self) -> None:
        """Full round-trip: build auth headers, recompute hash, recover signer."""
        headers = build_auth_headers(ANVIL_PK, "POST", "/api/v1/direct", TEST_CHAIN_ID, TEST_ROUTER)

        domain_data = {
            "name": "pay",
            "version": "0.1",
            "chainId": TEST_CHAIN_ID,
            "verifyingContract": TEST_ROUTER,
        }
        message_types = {
            "APIRequest": [
                {"name": "method", "type": "string"},
                {"name": "path", "type": "string"},
                {"name": "timestamp", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ],
        }
        nonce_hex = headers["X-Pay-Nonce"]
        message_data = {
            "method": "POST",
            "path": "/api/v1/direct",
            "timestamp": int(headers["X-Pay-Timestamp"]),
            "nonce": bytes.fromhex(nonce_hex[2:]),
        }

        signable = encode_typed_data(domain_data, message_types, message_data)

        sig_hex = headers["X-Pay-Signature"]
        sig_bytes = bytes.fromhex(sig_hex[2:] if sig_hex.startswith("0x") else sig_hex)

        recovered = Account.recover_message(signable, signature=sig_bytes)
        assert recovered.lower() == ANVIL_ADDRESS.lower()


class TestDifferentInputsDifferentHashes:
    def test_different_methods(self) -> None:
        h1 = build_auth_headers(ANVIL_PK, "POST", "/api/v1/direct", TEST_CHAIN_ID, TEST_ROUTER)
        h2 = build_auth_headers(ANVIL_PK, "GET", "/api/v1/direct", TEST_CHAIN_ID, TEST_ROUTER)
        assert h1["X-Pay-Signature"] != h2["X-Pay-Signature"]

    def test_different_paths(self) -> None:
        h1 = build_auth_headers(ANVIL_PK, "POST", "/api/v1/direct", TEST_CHAIN_ID, TEST_ROUTER)
        h2 = build_auth_headers(ANVIL_PK, "POST", "/api/v1/tabs", TEST_CHAIN_ID, TEST_ROUTER)
        assert h1["X-Pay-Signature"] != h2["X-Pay-Signature"]
