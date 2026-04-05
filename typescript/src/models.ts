/** Tab lifecycle states. */
export type TabStatus = "open" | "closed";

/** Result of a direct payment. */
export interface DirectPaymentResult {
  txHash: string;
  status: string;
  /** Amount in USDC micro-units (6 decimals). */
  amount: number;
  /** Fee deducted in USDC micro-units. */
  fee: number;
}

/** Tab state. */
export interface Tab {
  tabId: string;
  provider: string;
  /** Total locked amount in USDC micro-units. */
  amount: number;
  /** Remaining balance in USDC micro-units. */
  balanceRemaining: number;
  /** Total charged so far in USDC micro-units. */
  totalCharged: number;
  /** Number of charges made. */
  chargeCount: number;
  /** Max per-charge limit in USDC micro-units. */
  maxChargePerCall: number;
  /** Total withdrawn so far in USDC micro-units. */
  totalWithdrawn: number;
  status: TabStatus;
}

/** Wallet status. */
export interface StatusResponse {
  address: string;
  /** USDC balance in micro-units. */
  balance: number;
  openTabs: Tab[];
}

/** Registered webhook. */
export interface WebhookRegistration {
  webhookId: string;
  url: string;
  events: string[];
}

// ── x402 V2 Wire Types ──────────────────────────────────────────

/** A single payment option in a v2 402 response. */
export interface PaymentRequirementsV2 {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: {
    name?: string;
    version?: string;
    facilitator?: string;
    settlement?: string;
  };
}

/** Top-level v2 PAYMENT-REQUIRED header (base64-encoded). */
export interface PaymentRequired {
  x402Version: number;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirementsV2[];
  extensions: Record<string, unknown>;
}
