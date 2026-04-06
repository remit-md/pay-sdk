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
  /** Number of charges buffered awaiting batch settlement. */
  pendingChargeCount: number;
  /** Total amount of pending charges in USDC micro-units. */
  pendingChargeTotal: number;
  /** balance_remaining minus pending charges — the true available balance. */
  effectiveBalance: number;
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
