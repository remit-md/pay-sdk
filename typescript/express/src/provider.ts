/**
 * Provider-side Express middleware.
 *
 * Gates routes behind x402 paywalls. Unpaid requests get 402.
 * Paid requests are verified via the facilitator and forwarded
 * with X-Pay-* headers.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { requirePayment } from "@pay-skill/express";
 *
 * const app = express();
 *
 * app.get("/api/data", requirePayment({
 *   price: 0.01,
 *   settlement: "tab",
 *   providerAddress: "0x...",
 * }), (req, res) => {
 *   res.json({ data: "premium", paidBy: req.payment!.from });
 * });
 * ```
 *
 * @module
 */

import type { RequestHandler, Request, Response } from "express";
import type {
  RequirePaymentOptions,
  PaymentOffer,
  PaymentRequirements,
  VerifyRequest,
  VerifyResponse,
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
 * Create Express middleware that requires x402 payment for a route.
 *
 * @param options - Price, settlement mode, provider address, and facilitator config.
 * @returns Express middleware function.
 */
export function requirePayment(options: RequirePaymentOptions): RequestHandler {
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

  return async (req: Request, res: Response, next) => {
    const paymentHeader = req.headers["payment-signature"] as string | undefined;

    // No payment — return 402
    if (!paymentHeader) {
      return send402(res, req, amountMicro, network, asset, providerAddress, settlement, facilitatorUrl);
    }

    // Decode payment payload
    let paymentPayload: unknown;
    try {
      paymentPayload = JSON.parse(
        Buffer.from(paymentHeader, "base64").toString("utf-8"),
      );
    } catch {
      return send402(res, req, amountMicro, network, asset, providerAddress, settlement, facilitatorUrl, "Invalid PAYMENT-SIGNATURE header: base64/JSON decode failed");
    }

    // Build the offer that was originally presented
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
        return next();
      }
      res.status(503).json({
        error: "facilitator_unavailable",
        message: "Payment facilitator is unreachable. Try again later.",
      });
      return;
    }

    // Payment invalid
    if (!verifyResult.isValid) {
      return send402(res, req, amountMicro, network, asset, providerAddress, settlement, facilitatorUrl, verifyResult.invalidReason);
    }

    // Payment valid — set headers and payment info
    req.headers["x-pay-verified"] = "true";
    req.headers["x-pay-from"] = verifyResult.payer ?? "";
    req.headers["x-pay-amount"] = amountMicro;
    req.headers["x-pay-settlement"] = settlement;

    req.payment = {
      from: verifyResult.payer ?? "",
      amount: parseInt(amountMicro, 10),
      settlement,
      verified: true,
    };

    // Strip payment signature from downstream
    delete req.headers["payment-signature"];

    next();
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

function send402(
  res: Response,
  req: Request,
  amount: string,
  network: string,
  asset: string,
  payTo: string,
  settlement: string,
  facilitator: string,
  reason?: string,
): void {
  const offer = buildOffer(amount, network, asset, payTo, settlement, facilitator);

  const requirements: PaymentRequirements = {
    x402Version: 2,
    accepts: [offer],
    resource: {
      url: req.originalUrl,
      mimeType: "application/json",
    },
    extensions: {},
  };

  const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");

  res
    .status(402)
    .set("PAYMENT-REQUIRED", encoded)
    .json({
      error: "payment_required",
      message: reason ?? `This endpoint requires payment of $${(parseInt(amount, 10) / 1_000_000).toFixed(2)}`,
      requirements,
    });
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
