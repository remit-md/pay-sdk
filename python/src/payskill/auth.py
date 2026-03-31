"""EIP-712 authentication for pay API requests.

Every authenticated request includes four headers:
  X-Pay-Agent     — wallet address (0x-prefixed, checksummed)
  X-Pay-Signature — EIP-712 signature (0x-prefixed hex, 65 bytes)
  X-Pay-Timestamp — unix timestamp in seconds
  X-Pay-Nonce     — random 32-byte hex (0x-prefixed)

The EIP-712 domain:
  name: "pay"
  version: "0.1"
  chainId: <from config>
  verifyingContract: <router address>

The typed data:
  APIRequest(string method, string path, uint256 timestamp, bytes32 nonce)
"""

from __future__ import annotations

import os
import time

from eth_account import Account
from eth_account.messages import encode_typed_data


def build_auth_headers(
    private_key: str,
    method: str,
    path: str,
    chain_id: int,
    router_address: str,
) -> dict[str, str]:
    """Build X-Pay-* auth headers for an API request.

    Args:
        private_key: Hex-encoded private key (with or without 0x prefix).
        method: HTTP method (GET, POST, DELETE, etc.).
        path: Request path (e.g., /api/v1/direct).
        chain_id: Chain ID for EIP-712 domain.
        router_address: Router contract address for EIP-712 domain.

    Returns:
        Dict with X-Pay-Agent, X-Pay-Signature, X-Pay-Timestamp, X-Pay-Nonce.
    """
    account = Account.from_key(private_key)
    timestamp = int(time.time())
    nonce = "0x" + os.urandom(32).hex()

    domain_data = {
        "name": "pay",
        "version": "0.1",
        "chainId": chain_id,
        "verifyingContract": router_address,
    }

    message_types = {
        "APIRequest": [
            {"name": "method", "type": "string"},
            {"name": "path", "type": "string"},
            {"name": "timestamp", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"},
        ],
    }

    message_data = {
        "method": method.upper(),
        "path": path,
        "timestamp": timestamp,
        "nonce": bytes.fromhex(nonce[2:]),
    }

    signable = encode_typed_data(
        domain_data,
        message_types,
        message_data,
    )
    signed = account.sign_message(signable)

    return {
        "X-Pay-Agent": account.address,
        "X-Pay-Signature": signed.signature.hex()
        if isinstance(signed.signature, bytes)
        else hex(signed.signature),
        "X-Pay-Timestamp": str(timestamp),
        "X-Pay-Nonce": nonce,
    }


def derive_address(private_key: str) -> str:
    """Derive an Ethereum address from a private key.

    Args:
        private_key: Hex-encoded private key (with or without 0x prefix).

    Returns:
        Checksummed Ethereum address.
    """
    account = Account.from_key(private_key)
    return account.address
