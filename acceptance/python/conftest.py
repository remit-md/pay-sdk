"""
Shared fixtures for Pay SDK Python acceptance tests.

Provides wallet generation, minting, and balance checking
against live Base Sepolia. No mocks.
"""

import os
import json
import httpx
from eth_account import Account

API_URL = os.environ.get("ACCEPTANCE_API_URL", "https://testnet.pay-skill.com/api/v1")
RPC_URL = os.environ.get("ACCEPTANCE_RPC_URL", "https://sepolia.base.org")


def generate_wallet() -> tuple[str, str]:
    """Generate a fresh random wallet. Returns (private_key, address)."""
    acct = Account.create()
    return acct.key.hex(), acct.address


def mint(address: str, amount: int) -> str:
    """Mint testnet USDC. Returns tx_hash."""
    resp = httpx.post(
        f"{API_URL}/mint",
        json={"wallet": address, "amount": amount},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["tx_hash"]


def get_contracts() -> dict:
    """Fetch contract addresses from server."""
    resp = httpx.get(f"{API_URL}/contracts", timeout=10)
    resp.raise_for_status()
    return resp.json()


def get_on_chain_balance(address: str, usdc_address: str) -> int:
    """Get USDC balance via RPC eth_call. Returns micro-USDC."""
    padded = address.lower().replace("0x", "").zfill(64)
    data = f"0x70a08231{padded}"
    resp = httpx.post(
        RPC_URL,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [{"to": usdc_address, "data": data}, "latest"],
        },
        timeout=10,
    )
    result = resp.json().get("result", "0x0")
    return int(result, 16)


def wait_for_balance_change(
    address: str, usdc_address: str, before: int, max_wait_s: int = 60
) -> int:
    """Poll until balance changes."""
    import time

    start = time.time()
    delay = 2.0
    while time.time() - start < max_wait_s:
        current = get_on_chain_balance(address, usdc_address)
        if current != before:
            return current
        time.sleep(delay)
        delay = min(delay * 1.5, 10)
    return get_on_chain_balance(address, usdc_address)
