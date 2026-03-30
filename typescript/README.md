# @pay-skill/sdk

TypeScript SDK for [pay](https://pay-skill.com) — payment infrastructure for AI agents.

## Install

```bash
npm install @pay-skill/sdk
```

## Usage

```typescript
import { PayClient } from "@pay-skill/sdk";

const client = new PayClient({ signer: "cli" });

// Direct payment
await client.payDirect("0xprovider...", 5_000_000, { memo: "task-42" });

// Open a tab
const tab = await client.openTab("0xprovider...", 20_000_000, { maxChargePerCall: 500_000 });

// x402 request
const response = await client.request("https://api.example.com/data");
```

## License

MIT
