/**
 * Shared types for @pay-skill/express middleware.
 * @module
 */

import type { PayFetchOptions } from "@pay-skill/sdk";

// ── Consumer types ───────────────────────────────────────────────────

/** Options for payMiddleware (consumer-side). */
export interface PayMiddlewareOptions extends PayFetchOptions {
  // Inherits maxPerRequest, maxTotal, onPayment from PayFetchOptions.
  // No additional options for now.
}

// ── Provider types ───────────────────────────────────────────────────

/** Options for requirePayment (provider-side). */
export interface RequirePaymentOptions {
  /** Dollar amount to charge per request. */
  price: number;

  /** Settlement mode: "tab" for micropayments, "direct" for $1+ one-shot. */
  settlement: "tab" | "direct";

  /** Provider wallet address (checksummed 0x...). */
  providerAddress: string;

  /** Facilitator URL. Defaults to mainnet. */
  facilitatorUrl?: string;

  /** Behavior when facilitator is unreachable. Default: "closed" (block). */
  failMode?: "closed" | "open";

  /** USDC contract address. Auto-detected from facilitatorUrl if omitted. */
  asset?: string;
}

/** Payment info attached to req.payment after successful verification. */
export interface PaymentInfo {
  /** Payer wallet address. */
  from: string;

  /** Amount paid in micro-USDC. */
  amount: number;

  /** Settlement mode used. */
  settlement: "tab" | "direct" | string;

  /** Tab ID if tab-backed. */
  tabId?: string;

  /** Always true when middleware passes control to next(). */
  verified: true;
}

// ── x402 wire format types ───────────────────────────────────────────

/** x402 V2 payment requirements (PAYMENT-REQUIRED header). */
export interface PaymentRequirements {
  x402Version: 2;
  accepts: PaymentOffer[];
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  extensions?: Record<string, unknown>;
}

/** A single payment offer within requirements. */
export interface PaymentOffer {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    settlement: string;
    facilitator: string;
    [key: string]: unknown;
  };
}

/** Facilitator /verify request body. */
export interface VerifyRequest {
  x402Version: 2;
  paymentPayload: unknown;
  paymentRequirements: PaymentOffer;
}

/** Facilitator /verify response. */
export interface VerifyResponse {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}

// ── Express augmentation ─────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Attached by payMiddleware (consumer-side). */
      pay?: {
        fetch: typeof globalThis.fetch;
        wallet: import("@pay-skill/sdk").Wallet;
      };
      /** Attached by requirePayment (provider-side). */
      payment?: PaymentInfo;
    }
  }
}
