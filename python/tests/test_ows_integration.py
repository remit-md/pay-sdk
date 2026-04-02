"""OWS Signer integration test.

Requires real open-wallet-standard installed with native binaries.
Auto-skips if OWS is not available — safe to run in CI without OWS.

Tests:
- Creating a real OWS wallet
- Constructing OwsSigner from it
- Signing EIP-712 Permit typed data
- Verifying signature recovers to correct address (ecrecover round-trip)
"""

from __future__ import annotations

import time

import pytest

# Check if OWS is available
try:
    import ows  # type: ignore[import-untyped]

    ows.list_wallets()
    OWS_AVAILABLE = True
except Exception:
    OWS_AVAILABLE = False

pytestmark = pytest.mark.skipif(not OWS_AVAILABLE, reason="OWS not installed")


@pytest.mark.asyncio()
async def test_create_signer_from_real_wallet():
    """Create a real OWS wallet, build OwsSigner, sign EIP-712, verify ecrecover."""
    from eth_account import Account
    from eth_account.messages import encode_typed_data

    from payskill.ows_signer import OwsSigner

    # Create a test wallet (unique name)
    wallet_name = f"pay-test-{int(time.time() * 1000)}"
    wallet_info = ows.create_wallet(wallet_name)
    accounts = wallet_info.get("accounts", [])
    evm_account = next(
        (
            a
            for a in accounts
            if a.get("chain_id") == "evm" or a.get("chain_id", "").startswith("eip155:")
        ),
        None,
    )
    assert evm_account is not None, "OWS wallet must have an EVM account"

    # Create OwsSigner
    signer = OwsSigner(wallet_id=wallet_name)
    assert signer.address.lower() == evm_account["address"].lower()

    # Sign an EIP-712 Permit
    domain = {
        "name": "USD Coin",
        "version": "2",
        "chainId": 84532,
        "verifyingContract": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    }
    types = {
        "Permit": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ]
    }
    message = {
        "owner": signer.address,
        "spender": "0x0000000000000000000000000000000000000001",
        "value": "5000000",
        "nonce": "0",
        "deadline": "999999999999",
    }

    signature = await signer.sign_typed_data(domain, types, message)

    # Verify signature format
    assert signature.startswith("0x")
    assert len(signature) == 132, "signature must be 65 bytes (132 hex chars)"

    # Verify ecrecover round-trip
    sig_bytes = bytes.fromhex(signature[2:])
    r = int.from_bytes(sig_bytes[:32], "big")
    s = int.from_bytes(sig_bytes[32:64], "big")
    v = sig_bytes[64]

    # Use eth_account to recover and verify
    typed_data = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            **types,
        },
        "primaryType": "Permit",
        "domain": domain,
        "message": message,
    }
    encoded = encode_typed_data(full_message=typed_data)
    recovered = Account.recover_message(encoded, vrs=(v, r, s))
    assert recovered.lower() == signer.address.lower(), (
        f"ecrecover mismatch: {recovered} != {signer.address}"
    )
