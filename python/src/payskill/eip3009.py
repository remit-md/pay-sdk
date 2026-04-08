"""EIP-3009 TransferWithAuthorization signing for USDC.

Signs a TransferWithAuthorization EIP-712 typed data message using
the agent's private key. Used for direct x402 settlement where the
SDK signs locally instead of hitting the server's /direct endpoint.

Domain: { name: "USD Coin", version: "2", chainId, verifyingContract }
Type:   TransferWithAuthorization(address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce)
"""

from __future__ import annotations

import os
from typing import Any

from eth_account import Account
from eth_account.messages import encode_typed_data


def sign_transfer_authorization(
    private_key: str,
    to: str,
    value: int,
    chain_id: int,
    usdc_address: str,
) -> dict[str, Any]:
    """Sign an EIP-3009 TransferWithAuthorization.

    Args:
        private_key: Hex-encoded private key (with or without 0x prefix).
        to: Recipient address (0x-prefixed).
        value: Amount in micro-USDC (integer, 6 decimals).
        chain_id: Chain ID (8453 for Base mainnet, 84532 for testnet).
        usdc_address: USDC contract address for this chain.

    Returns:
        Dict with: from, to, value, validAfter, validBefore, nonce, signature.
        All values are strings suitable for the x402 v2 payload.
    """
    account = Account.from_key(private_key)
    nonce = "0x" + os.urandom(32).hex()

    domain_data = {
        "name": "USD Coin",
        "version": "2",
        "chainId": chain_id,
        "verifyingContract": usdc_address,
    }

    message_types = {
        "TransferWithAuthorization": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"},
        ],
    }

    message_data = {
        "from": account.address,
        "to": to,
        "value": value,
        "validAfter": 0,
        "validBefore": 0,
        "nonce": bytes.fromhex(nonce[2:]),
    }

    signable = encode_typed_data(
        domain_data,
        message_types,
        message_data,
    )
    signed = account.sign_message(signable)

    sig_bytes = signed.signature
    if isinstance(sig_bytes, int):
        sig_bytes = sig_bytes.to_bytes(65, "big")
    signature = "0x" + sig_bytes.hex()

    return {
        "from": account.address,
        "to": to,
        "value": str(value),
        "validAfter": "0",
        "validBefore": "0",
        "nonce": nonce,
        "signature": signature,
    }
