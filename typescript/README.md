# @pay-skill/sdk

TypeScript SDK for [pay](https://pay-skill.com) -- payment infrastructure for AI agents. USDC on Base.

```ts
import { Wallet } from "@pay-skill/sdk";

const wallet = await Wallet.create();  // OS keychain (same key as CLI)
await wallet.send("0xProvider...", 5, "for API access");
```

## Install

```bash
npm install @pay-skill/sdk
```

## Quick Start

### OS keychain (recommended -- same key as `pay` CLI)

```ts
const wallet = await Wallet.create();
const { txHash } = await wallet.send("0xRecipient...", 10);
```

### Environment variable

Set `PAYSKILL_KEY` to your hex private key (CI/containers):

```ts
const wallet = new Wallet();  // reads PAYSKILL_KEY
```

### Explicit key (testing only)

```ts
const wallet = new Wallet({ privateKey: "0xdead..." });
```

### OWS (Open Wallet Standard)

```ts
const wallet = await Wallet.fromOws({ walletId: "my-agent" });
```

Requires `@open-wallet-standard/core` as a peer dependency.

## API

All amounts are in dollars by default. Use `{ micro: N }` for micro-USDC precision.

### Payments

```ts
await wallet.send(to, 5);                    // $5 direct payment
await wallet.send(to, 5, "invoice #42");     // with memo
await wallet.send(to, { micro: 5_000_000 }); // micro-USDC
```

### Tabs (pre-funded metered accounts)

```ts
const tab = await wallet.openTab(provider, 50, 1);  // $50 tab, $1 max/charge
await wallet.chargeTab(tab.id, 0.01);                // charge $0.01
await wallet.topUpTab(tab.id, 25);                   // add $25
await wallet.closeTab(tab.id);                       // close + settle
const tabs = await wallet.listTabs();
const tab = await wallet.getTab(tabId);
```

### x402 (paid HTTP)

```ts
const resp = await wallet.request("https://api.example.com/data");
// Handles 402 responses automatically: pays, retries, returns final response
```

### Wallet

```ts
const bal = await wallet.balance();  // { total, locked, available }
const info = await wallet.status();  // { address, balance, openTabs }
```

### Discovery

```ts
const services = await wallet.discover("weather");
// Or without a wallet:
import { discover } from "@pay-skill/sdk";
const services = await discover("weather");
```

### Funding

```ts
const url = await wallet.createFundLink({ message: "Need $50 for API calls" });
const url = await wallet.createWithdrawLink();
```

### Webhooks

```ts
const wh = await wallet.registerWebhook("https://example.com/hook", ["payment.completed"]);
const hooks = await wallet.listWebhooks();
await wallet.deleteWebhook(wh.id);
```

### Testnet

```ts
await wallet.mint(100); // mint $100 test USDC (testnet only)
```

## Errors

```ts
import {
  PayError,                  // base
  PayValidationError,        // invalid input
  PayNetworkError,           // network failure
  PayServerError,            // server 4xx/5xx
  PayInsufficientFundsError, // low balance (hints createFundLink)
} from "@pay-skill/sdk";
```

## Requirements

- Node.js 18+
- ESM only

## License

MIT
