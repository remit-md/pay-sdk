# pay-skill

Python SDK for [pay](https://pay-skill.com) -- payment infrastructure for AI agents. USDC on Base.

## Install

```bash
pip install pay-skill
```

Optional keychain support (reads key stored by `pay` CLI):

```bash
pip install pay-skill[keychain]
```

Requires Python 3.10+.

## Quick Start

```python
from payskill import Wallet

wallet = Wallet()  # reads PAYSKILL_KEY env var

# Pay another agent $5
result = wallet.send("0xprovider...", 5.0, memo="task-42")
print(result.tx_hash)

# Open a metered tab
tab = wallet.open_tab("0xprovider...", 20.0, max_charge_per_call=0.50)

# x402 request (SDK handles payment automatically)
response = wallet.request("https://api.example.com/data")
print(response.json())
```

## Wallet Initialization

```python
# Zero-config (reads PAYSKILL_KEY env var)
wallet = Wallet()

# Explicit key
wallet = Wallet(private_key="0x...")

# OS keychain (reads key stored by `pay` CLI)
wallet = Wallet.create()

# Env var only
wallet = Wallet.from_env()

# Testnet
wallet = Wallet(testnet=True)
# or set PAYSKILL_TESTNET=1
```

## Amounts

All amounts are in dollars by default. Use `{"micro": int}` for micro-USDC precision:

```python
wallet.send("0x...", 5.0)                # $5.00
wallet.send("0x...", {"micro": 5000000}) # $5.00 (micro-USDC)
wallet.open_tab("0x...", 20.0, 0.10)     # $20 tab, $0.10/call max
```

## All Methods

```python
# Direct payment
result = wallet.send(to, amount, memo?)

# Tabs
tab = wallet.open_tab(provider, amount, max_charge_per_call)
tab = wallet.close_tab(tab_id)
tab = wallet.top_up_tab(tab_id, amount)
tabs = wallet.list_tabs()
tab = wallet.get_tab(tab_id)
charge = wallet.charge_tab(tab_id, amount)

# x402 paid HTTP
response = wallet.request(url, method=, body=, headers=)

# Wallet
bal = wallet.balance()    # Balance(total, locked, available)
st = wallet.status()      # Status(address, balance, open_tabs)

# Discovery (no auth needed)
services = wallet.discover("weather")
# or standalone:
from payskill import discover
services = discover("weather")

# Funding
url = wallet.create_fund_link(message="Need funds")
url = wallet.create_withdraw_link()

# Webhooks
wh = wallet.register_webhook(url, events=["payment.completed"])
webhooks = wallet.list_webhooks()
wallet.delete_webhook(webhook_id)

# Testnet
result = wallet.mint(100)  # mint $100 testnet USDC
```

## Error Handling

```python
from payskill import (
    PayError,
    PayValidationError,
    PayNetworkError,
    PayServerError,
    PayInsufficientFundsError,
)

try:
    wallet.send("0x...", 5.0)
except PayInsufficientFundsError as e:
    print(e.balance, e.required)
    url = wallet.create_fund_link(message="Need funds")
except PayValidationError as e:
    print(e.field)  # which field failed
except PayServerError as e:
    print(e.status_code)
except PayNetworkError:
    print("Server unreachable")
```

## OWS (Open Wallet Standard)

```python
pip install pay-skill[ows]

wallet = Wallet.from_ows(wallet_id="my-agent")
```

## Links

- [Documentation](https://pay-skill.com/docs/)
- [TypeScript SDK](https://www.npmjs.com/package/@pay-skill/sdk)
- [CLI](https://github.com/pay-skill/cli)
