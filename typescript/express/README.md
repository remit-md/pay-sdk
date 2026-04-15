# @pay-skill/express

Express.js middleware for x402 payments — both consumer and provider sides. Thin adapter over [`@pay-skill/sdk`](https://www.npmjs.com/package/@pay-skill/sdk) for Express 4 and 5.

Full docs: https://pay-skill.com/docs/middleware/express

## Install

```bash
npm install @pay-skill/sdk @pay-skill/express express
```

## Provider — Gate a route behind an x402 paywall

```typescript
import express from "express";
import { requirePayment } from "@pay-skill/express";

const app = express();

app.get("/api/data", requirePayment({
  price: 0.01,
  settlement: "tab",
  providerAddress: "0xYourProviderWallet...",
}), (req, res) => {
  res.json({ data: "premium", paidBy: req.payment!.from });
});
```

Unpaid requests receive a 402 with the `PAYMENT-REQUIRED` header. Verified requests have `req.payment` populated (`from`, `amount`, `settlement`) and `X-Pay-Verified` / `X-Pay-From` / `X-Pay-Amount` / `X-Pay-Settlement` headers set for downstream middleware.

## Consumer — Auto-pay outbound x402 calls

```typescript
import express from "express";
import { Wallet } from "@pay-skill/sdk";
import { payMiddleware } from "@pay-skill/express";

const wallet = await Wallet.create();
const app = express();

app.use(payMiddleware(wallet, {
  maxPerRequest: 1.00,
  maxTotal: 100.00,
}));

app.get("/forecast", async (req, res) => {
  const data = await req.pay!.fetch("https://api.example.com/forecast");
  res.json(await data.json());
});
```

`req.pay.fetch` is a pay-enabled `fetch` backed by [`createPayFetch`](https://pay-skill.com/docs/sdk/fetch). It auto-settles x402 402 responses via tab or direct and retries — your handler never sees the 402.

## License

MIT
