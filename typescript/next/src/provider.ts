/**
 * Provider-side Next.js App Router wrapper.
 *
 * Gates a route handler behind an x402 paywall. Unpaid requests get 402.
 * Paid requests are verified via the facilitator before the handler runs.
 *
 * @example
 * ```ts
 * // app/api/premium/route.ts
 * import { withPaywall } from "@pay-skill/next";
 *
 * export const GET = withPaywall(
 *   {
 *     price: 0.01,
 *     settlement: "tab",
 *     providerAddress: "0x...",
 *   },
 *   async (_req, payment) => {
 *     return Response.json({ data: "premium", paidBy: payment.from });
 *   },
 * );
 * ```
 *
 * @module
 */

import type {
  PaymentInfo,
  PaymentOffer,
  PaymentRequirements,
  PaywallHandler,
  VerifyRequest,
  VerifyResponse,
  WithPaywallOptions,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────────

const MAINNET_FACILITATOR = "https://pay-skill.com/x402";
const MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TESTNET_FACILITATOR = "https://testnet.pay-skill.com/x402";
const TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const MAINNET_NETWORK = "eip155:8453";
const TESTNET_NETWORK = "eip155:84532";

const VERIFY_TIMEOUT_MS = 5000;

// ── Public ───────────────────────────────────────────────────────────

/**
 * Wrap a Next.js App Router route handler with x402 payment verification.
 *
 * Unpaid requests return 402 with the PAYMENT-REQUIRED header. Paid
 * requests are verified via the facilitator, and the handler is called
 * with the verified payment info.
 *
 * @param options - Price, settlement mode, provider address, facilitator config.
 * @param handler - The route handler. Receives (req, payment) after verification.
 * @returns A Next.js-compatible route handler function.
 */
export function withPaywall<Req extends Request = Request>(
  options: WithPaywallOptions,
  handler: PaywallHandler<Req>,
): (req: Req) => Promise<Response> {
  const {
    price,
    settlement,
    providerAddress,
    failMode = "closed",
  } = options;

  const facilitatorUrl = options.facilitatorUrl ?? MAINNET_FACILITATOR;
  const isTestnet = facilitatorUrl.includes("testnet");
  const network = isTestnet ? TESTNET_NETWORK : MAINNET_NETWORK;
  const asset = options.asset ?? (isTestnet ? TESTNET_USDC : MAINNET_USDC);
  const amountMicro = Math.round(price * 1_000_000).toString();

  return async (req: Req): Promise<Response> => {
    const paymentHeader =
      req.headers.get("payment-signature") ??
      req.headers.get("PAYMENT-SIGNATURE");

    // No payment — return 402
    if (!paymentHeader) {
      return build402(req, amountMicro, network, asset, providerAddress, settlement, facilitatorUrl);
    }

    // Decode payment payload
    let paymentPayload: unknown;
    try {
      paymentPayload = JSON.parse(
        Buffer.from(paymentHeader, "base64").toString("utf-8"),
      );
    } catch {
      return build402(
        req,
        amountMicro,
        network,
        asset,
        providerAddress,
        settlement,
        facilitatorUrl,
        "Invalid PAYMENT-SIGNATURE header: base64/JSON decode failed",
      );
    }

    const offer = buildOffer(amountMicro, network, asset, providerAddress, settlement, facilitatorUrl);

    // Verify via facilitator
    let verifyResult: VerifyResponse | null;
    try {
      verifyResult = await verifyPayment(facilitatorUrl, paymentPayload, offer);
    } catch {
      verifyResult = null;
    }

    // Facilitator unreachable
    if (verifyResult === null) {
      if (failMode === "open") {
        const fallbackPayment: PaymentInfo = {
          from: "",
          amount: parseInt(amountMicro, 10),
          settlement,
          verified: true,
        };
        return handler(req, fallbackPayment);
      }
      return Response.json(
        {
          error: "facilitator_unavailable",
          message: "Payment facilitator is unreachable. Try again later.",
        },
        { status: 503 },
      );
    }

    // Payment invalid
    if (!verifyResult.isValid) {
      return build402(
        req,
        amountMicro,
        network,
        asset,
        providerAddress,
        settlement,
        facilitatorUrl,
        verifyResult.invalidReason,
      );
    }

    // Payment valid — call handler with payment info
    const payment: PaymentInfo = {
      from: verifyResult.payer ?? "",
      amount: parseInt(amountMicro, 10),
      settlement,
      verified: true,
    };

    return handler(req, payment);
  };
}

// ── Internal ─────────────────────────────────────────────────────────

function buildOffer(
  amount: string,
  network: string,
  asset: string,
  payTo: string,
  settlement: string,
  facilitator: string,
): PaymentOffer {
  return {
    scheme: "exact",
    network,
    amount,
    asset,
    payTo,
    maxTimeoutSeconds: 60,
    extra: {
      settlement,
      facilitator,
    },
  };
}

function build402(
  req: Request,
  amount: string,
  network: string,
  asset: string,
  payTo: string,
  settlement: string,
  facilitator: string,
  reason?: string,
): Response {
  const offer = buildOffer(amount, network, asset, payTo, settlement, facilitator);

  const url = new URL(req.url);
  const requirements: PaymentRequirements = {
    x402Version: 2,
    accepts: [offer],
    resource: {
      url: url.pathname + url.search,
      mimeType: "application/json",
    },
    extensions: {},
  };

  const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");

  return Response.json(
    {
      error: "payment_required",
      message: reason ?? `This endpoint requires payment of $${(parseInt(amount, 10) / 1_000_000).toFixed(2)}`,
      requirements,
    },
    {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encoded,
      },
    },
  );
}

async function verifyPayment(
  facilitatorUrl: string,
  paymentPayload: unknown,
  paymentRequirements: PaymentOffer,
): Promise<VerifyResponse> {
  const body: VerifyRequest = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const resp = await fetch(`${facilitatorUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      return { isValid: false, invalidReason: `Facilitator returned ${resp.status}` };
    }

    return (await resp.json()) as VerifyResponse;
  } finally {
    clearTimeout(timeout);
  }
}
