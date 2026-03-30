# @pay-skill/sdk

TypeScript SDK for [pay](https://pay-skill.com) — payment infrastructure for AI agents. USDC on Base.

Three primitives: direct payments, tabs (pre-funded metered accounts), and x402 HTTP paywalls.

## Install

```bash
npm install @pay-skill/sdk
```

Requires Node.js 20+.

## Quick Start

```typescript
import { PayClient } from "@pay-skill/sdk";

const client = new PayClient({ signer: "cli" }); // uses `pay sign` subprocess

// Pay another agent $5
const result = await client.payDirect("0xprovider...", 5_000_000, { memo: "task-42" });
console.log(result.txHash);

// Open a metered tab
const tab = await client.openTab("0xprovider...", 20_000_000, { maxChargePerCall: 500_000 });

// x402 request (SDK handles payment automatically)
const response = await client.request("https://api.example.com/data");
```

All amounts are in USDC micro-units (6 decimals). `$1.00 = 1_000_000`.

## API Reference

### PayClient

```typescript
import { PayClient } from "@pay-skill/sdk";

const client = new PayClient({
  apiUrl: "https://pay-skill.com/api/v1", // default
  signer: "cli", // "cli", "raw", "custom", or a Signer instance
});
```

### Direct Payment

One-shot USDC transfer. $1.00 minimum.

```typescript
const result = await client.payDirect(to, amount, { memo });
// Returns: { txHash, status, amount, fee }
```

### Tab Management

Pre-funded metered account. $5.00 minimum to open.

```typescript
// Open
const tab = await client.openTab(provider, amount, { maxChargePerCall });

// Query
const tabs = await client.listTabs();
const tab = await client.getTab(tabId);

// Top up (no extra activation fee)
const tab = await client.topUpTab(tabId, amount);

// Close (either party, unilateral)
const tab = await client.closeTab(tabId);
```

Returns `Tab { tabId, provider, amount, balanceRemaining, totalCharged, chargeCount, maxChargePerCall, status }`.

### x402 Requests

Transparent HTTP 402 handling. The SDK detects `402 Payment Required`, pays (via direct or tab), and retries.

```typescript
const response = await client.request(url, { method, body, headers });
// Returns: Response (native fetch Response)
```

If the provider requires tab settlement, the SDK auto-opens a tab at 10x the per-call price (minimum $5).

### Wallet

```typescript
const status = await client.getStatus();
// Returns: { address, balance, openTabs }
```

### Webhooks

```typescript
const wh = await client.registerWebhook(url, { events: ["tab.charged"], secret: "whsec_..." });
const webhooks = await client.listWebhooks();
await client.deleteWebhook(webhookId);
```

### Funding

```typescript
const fundUrl = await client.createFundLink(10_000_000);    // Coinbase Onramp
const withdrawUrl = await client.createWithdrawLink(5_000_000);
```

## Signer Modes

| Mode | Usage | When |
|------|-------|------|
| `"cli"` | Subprocess call to `pay sign` | Default. Key in OS keychain. |
| `"raw"` | `PAYSKILL_KEY` env var | Dev/testing only. |
| `"custom"` | Your own callback | Custom key management. |

```typescript
// CLI signer (default)
const client = new PayClient({ signer: "cli" });

// Raw key (dev only)
const client = new PayClient({ signer: "raw", signerOptions: { key: "0xdead..." } });

// Custom callback
import { CallbackSigner } from "@pay-skill/sdk";
const signer = new CallbackSigner((hash: Uint8Array) => mySign(hash));
const client = new PayClient({ signer });
```

## Error Handling

```typescript
import {
  PayError,                  // Base class
  PayValidationError,        // Bad input (has .field)
  PayNetworkError,           // Connection failed
  PayServerError,            // Server returned error (has .statusCode)
  PayInsufficientFundsError, // Not enough USDC
} from "@pay-skill/sdk";
```

## Configuration

| Env Var | Purpose |
|---------|---------|
| `PAYSKILL_KEY` | Private key for raw signer mode |

The API URL is configurable via the `apiUrl` option. Default: `https://pay-skill.com/api/v1`.

## License

MIT
