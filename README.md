# pay-sdk

Python and TypeScript SDKs for Pay -- the complete x402 payment stack for AI agents. USDC on Base.

## Install

**TypeScript:**
```bash
npm install @pay-skill/sdk
```

**Python:**
```bash
pip install payskill
```

## Quick Start

**TypeScript:**
```typescript
import { Wallet } from "@pay-skill/sdk";

const wallet = await Wallet.create();  // OS keychain (same key as CLI)
await wallet.send("0xprovider", 5);  // send $5
const response = await wallet.request("https://api.example.com/data");  // x402 auto-pay
```

**Python:**
```python
from payskill import Wallet

wallet = Wallet()  # reads key from OS keychain
wallet.send("0xprovider", 5)  # send $5
response = wallet.request("https://api.example.com/data")  # x402 auto-pay
```

Both SDKs have identical API surfaces: 17 methods covering direct payments, tabs, x402 requests, webhooks, discovery, and wallet management. Dollar amounts by default.

## SDK Documentation

- [TypeScript SDK Reference](https://pay-skill.com/docs/sdk/typescript)
- [Python SDK Reference](https://pay-skill.com/docs/sdk/python)
- [TypeScript README](./typescript/README.md)
- [Python README](./python/README.md)

## Part of Pay

Pay is the complete x402 payment stack -- gateway, facilitator, SDKs, CLI, and MCP server -- that lets AI agents pay for APIs with USDC on Base.

- [Documentation](https://pay-skill.com/docs/)
- [Architecture](https://pay-skill.com/docs/architecture)
- [CLI](https://github.com/pay-skill/pay-cli) -- Command-line tool
- [pay-gate](https://github.com/pay-skill/gate) -- x402 payment gateway
- [MCP Server](https://github.com/pay-skill/mcp) -- Claude Desktop / Cursor / VS Code
- [Protocol](https://github.com/pay-skill/pay-protocol) -- Smart contracts

## License

MIT
