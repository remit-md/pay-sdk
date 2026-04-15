# @pay-skill/next

Next.js App Router middleware for x402 payments — both consumer and provider sides. Thin adapter over [`@pay-skill/sdk`](https://www.npmjs.com/package/@pay-skill/sdk) for Next.js 13.4+ (App Router only, Node.js runtime only).

Full docs: https://pay-skill.com/docs/middleware/next

## Install

```bash
npm install @pay-skill/sdk @pay-skill/next
```

## Provider — Gate a route behind an x402 paywall

```typescript
// app/api/quote/route.ts
import { withPaywall } from "@pay-skill/next";

export const dynamic = "force-dynamic";

export const GET = withPaywall(
  {
    price: 0.01,
    settlement: "tab",
    providerAddress: "0xYourProviderWallet...",
  },
  async (_req, payment) => {
    return Response.json({
      quote: "Whereof one cannot speak, thereof one must be silent.",
      paidBy: payment.from,
    });
  },
);
```

Unpaid requests receive a 402 with the `PAYMENT-REQUIRED` header. The handler runs only after the facilitator verifies payment and receives a `PaymentInfo` object (`from`, `amount`, `settlement`, `verified`).

## Consumer — Auto-pay outbound x402 calls

```typescript
// app/api/forecast/route.ts
import { withPay } from "@pay-skill/next";
import { Wallet } from "@pay-skill/sdk";

const wallet = await Wallet.create();

export const dynamic = "force-dynamic";

export const GET = withPay(
  wallet,
  async (req, pay) => {
    const data = await pay.fetch("https://api.example.com/forecast");
    return Response.json(await data.json());
  },
  { maxPerRequest: 1.00, maxTotal: 100.00 },
);
```

`pay.fetch` is a pay-enabled `fetch` backed by [`createPayFetch`](https://pay-skill.com/docs/sdk/fetch). It auto-settles x402 402 responses via tab or direct and retries — your handler never sees the 402.

## What's Not Supported

- **Edge runtime** — cannot hold wallet state or sign transactions
- **Pages Router** — use [`@pay-skill/express`](https://www.npmjs.com/package/@pay-skill/express) via a custom server
- **Server Actions** — use an App Router route handler with `withPay` instead
- **`middleware.ts`** — runs on Edge; put gating inside `withPaywall` handlers

## License

MIT
