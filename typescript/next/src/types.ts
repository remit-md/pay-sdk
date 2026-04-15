/**
 * Shared types for @pay-skill/next.
 * @module
 */

import type { PayFetchOptions, Wallet } from "@pay-skill/sdk";

// ── Consumer types ───────────────────────────────────────────────────

/** Options for withPay (consumer-side). */
export type WithPayOptions = PayFetchOptions;

/** Context object passed to the withPay handler. */
export interface PayContext {
  /** Pay-enabled fetch that auto-settles x402 responses. */
  fetch: typeof globalThis.fetch;
  /** The wallet instance (for direct payments, tab management). */
  wallet: Wallet;
}

/** Handler signature for withPay. */
export type PayHandler<Req extends Request = Request> = (
  req: Req,
  pay: PayContext,
) => Response | Promise<Response>;

// ── Provider types ───────────────────────────────────────────────────

/** Options for withPaywall (provider-side). */
export interface WithPaywallOptions {
  /** Dollar amount to charge per request. */
  price: number;

  /** Settlement mode: "tab" for micropayments, "direct" for $1+ one-shot. */
  settlement: "tab" | "direct";

  /** Provider wallet address (checksummed 0x...). */
  providerAddress: string;

  /** Facilitator URL. Defaults to mainnet. */
  facilitatorUrl?: string;

  /** Behavior when facilitator is unreachable. Default: "closed". */
  failMode?: "closed" | "open";

  /** USDC contract address. Auto-detected from facilitatorUrl if omitted. */
  asset?: string;
}

/** Payment info passed to the withPaywall handler. */
export interface PaymentInfo {
  from: string;
  amount: number;
  settlement: "tab" | "direct" | string;
  tabId?: string;
  verified: true;
}

/** Handler signature for withPaywall. */
export type PaywallHandler<Req extends Request = Request> = (
  req: Req,
  payment: PaymentInfo,
) => Response | Promise<Response>;

// ── x402 wire format (internal) ──────────────────────────────────────

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

export interface VerifyRequest {
  x402Version: 2;
  paymentPayload: unknown;
  paymentRequirements: PaymentOffer;
}

export interface VerifyResponse {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}
