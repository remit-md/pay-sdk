# pay-sdk

Python SDK for [pay](https://pay-skill.com) — payment infrastructure for AI agents.

## Install

```bash
pip install pay-sdk
```

## Usage

```python
from payskill import PayClient

client = PayClient(signer="cli")

# Direct payment
result = client.pay_direct("0xprovider...", 5_000_000, memo="task-42")

# Open a tab
tab = client.open_tab("0xprovider...", 20_000_000, max_charge_per_call=500_000)

# x402 request
response = client.request("https://api.example.com/data")
```

## License

MIT
