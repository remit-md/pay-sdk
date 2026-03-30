# pay-sdk

Python SDK for [pay](https://pay-skill.com) — payment infrastructure for AI agents. USDC on Base.

Three primitives: direct payments, tabs (pre-funded metered accounts), and x402 HTTP paywalls.

## Install

```bash
pip install pay-sdk
```

Requires Python 3.10+.

## Quick Start

```python
from payskill import PayClient

client = PayClient(signer="cli")  # uses `pay sign` subprocess

# Pay another agent $5
result = client.pay_direct("0xprovider...", 5_000_000, memo="task-42")
print(result.tx_hash)

# Open a metered tab
tab = client.open_tab("0xprovider...", 20_000_000, max_charge_per_call=500_000)

# x402 request (SDK handles payment automatically)
response = client.request("https://api.example.com/data")
```

All amounts are in USDC micro-units (6 decimals). `$1.00 = 1_000_000`.

## API Reference

### PayClient

```python
from payskill import PayClient

client = PayClient(
    api_url="https://pay-skill.com/api/v1",  # default
    signer="cli",  # "cli", "raw", "custom", or a Signer instance
)
```

### Direct Payment

One-shot USDC transfer. $1.00 minimum.

```python
result = client.pay_direct(to, amount, memo="")
# Returns: DirectPaymentResult(tx_hash, status, amount, fee)
```

### Tab Management

Pre-funded metered account. $5.00 minimum to open.

```python
# Open
tab = client.open_tab(provider, amount, max_charge_per_call)

# Query
tabs = client.list_tabs()
tab = client.get_tab(tab_id)

# Top up (no extra activation fee)
tab = client.top_up_tab(tab_id, amount)

# Close (either party, unilateral)
tab = client.close_tab(tab_id)
```

Returns `Tab(tab_id, provider, amount, balance_remaining, total_charged, charge_count, max_charge_per_call, status)`.

### x402 Requests

Transparent HTTP 402 handling. The SDK detects `402 Payment Required`, pays (via direct or tab), and retries.

```python
response = client.request(url, method="GET", body=None, headers=None)
# Returns: httpx.Response
```

If the provider requires tab settlement, the SDK auto-opens a tab at 10x the per-call price (minimum $5).

### Wallet

```python
status = client.get_status()
# Returns: StatusResponse(address, balance, open_tabs)
```

### Webhooks

```python
wh = client.register_webhook(url, events=["tab.charged"], secret="whsec_...")
webhooks = client.list_webhooks()
client.delete_webhook(webhook_id)
```

### Funding

```python
link = client.create_fund_link(amount=10_000_000)   # Coinbase Onramp
link = client.create_withdraw_link(amount=5_000_000)
```

## Signer Modes

| Mode | Usage | When |
|------|-------|------|
| `"cli"` | Subprocess call to `pay sign` | Default. Key in OS keychain. |
| `"raw"` | `PAYSKILL_KEY` env var | Dev/testing only. |
| `"custom"` | Your own callback | Custom key management. |

```python
# CLI signer (default)
client = PayClient(signer="cli")

# Raw key (dev only)
client = PayClient(signer="raw", key="0xdead...")

# Custom callback
from payskill.signer import CallbackSigner
signer = CallbackSigner(callback=lambda hash_bytes: my_sign(hash_bytes))
client = PayClient(signer=signer)
```

## Error Handling

```python
from payskill.errors import (
    PayError,                  # Base class
    PayValidationError,        # Bad input (has .field)
    PayNetworkError,           # Connection failed
    PayServerError,            # Server returned error (has .status_code)
    PayInsufficientFundsError, # Not enough USDC
)
```

## Configuration

| Env Var | Purpose |
|---------|---------|
| `PAYSKILL_KEY` | Private key for raw signer mode |

The API URL is configurable via the `api_url` parameter. Default: `https://pay-skill.com/api/v1`.

## License

MIT
