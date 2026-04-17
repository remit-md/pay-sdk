"""
Shared fixtures for Pay SDK Python acceptance tests.

Provides wallet generation, minting, and balance checking
against live Base Sepolia. No mocks.
"""

import os
import time
import json
import httpx
from eth_account import Account

API_URL = os.environ.get("ACCEPTANCE_API_URL", "https://testnet.pay-skill.com/api/v1")
RPC_URL = os.environ.get("ACCEPTANCE_RPC_URL", "https://sepolia.base.org")


def generate_wallet() -> tuple[str, str]:
    """Generate a fresh random wallet. Returns (private_key, address)."""
    acct = Account.create()
    return acct.key.hex(), acct.address


# /mint is rate-limited (1/hour per wallet) and the faucet itself can flake
# (5xx when out of gas, transient network errors). Each test generates a
# fresh wallet so the per-wallet limit normally doesn't apply, but global
# server hiccups still take down whole runs without retry — see release
# v0.2.4 attempt 1, where one /mint 500 sank the suite.
#
# 429 is treated as success: the server only returns it when the wallet was
# minted within the last hour, which means the funds are already there. The
# rate-limit window is 60 minutes — retrying for 110s and giving up is
# strictly worse than letting wait_for_balance_change confirm balance.
_MINT_RETRY_DELAYS = (5, 15, 30, 60)


def mint(address: str, amount: int) -> str:
    """Mint testnet USDC. Returns tx_hash ('' if 429-skipped). Retries on 5xx/network errors."""
    last_err: Exception | None = None
    for attempt, delay in enumerate((0,) + _MINT_RETRY_DELAYS):
        if delay:
            time.sleep(delay)
        try:
            resp = httpx.post(
                f"{API_URL}/mint",
                json={"wallet": address, "amount": amount},
                timeout=60,
            )
            if resp.status_code == 429:
                print(f"  [mint] 429 rate-limited — wallet has funds from prior mint, skipping")
                return ""
            if resp.status_code < 500:
                resp.raise_for_status()
                return resp.json()["tx_hash"]
            last_err = httpx.HTTPStatusError(
                f"mint {resp.status_code}: {resp.text[:200]}",
                request=resp.request,
                response=resp,
            )
        except (httpx.RequestError, httpx.HTTPStatusError) as err:
            last_err = err
        print(f"  [mint retry {attempt + 1}/{len(_MINT_RETRY_DELAYS) + 1}] {last_err}")
    raise RuntimeError(f"mint failed after {len(_MINT_RETRY_DELAYS) + 1} attempts: {last_err}")


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
