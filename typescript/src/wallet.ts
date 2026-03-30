/**
 * Wallet — high-level write client for agents.
 * Wraps PayClient with private key signing and balance tracking.
 *
 * This is the primary entry point for the playground and agent integrations.
 * The PayClient is lower-level (HTTP only); Wallet adds signing + state.
 */

export interface WalletOptions {
  privateKey: string;
  chain: string;
  apiUrl: string;
  routerAddress: string;
}

export interface FundLinkOptions {
  agentName?: string;
  messages?: Array<{ role: string; text: string }>;
}

export interface FundLink {
  url: string;
  token: string;
}

export interface PermitResult {
  v: number;
  r: string;
  s: string;
  deadline: number;
}

export class Wallet {
  readonly address: string;
  private readonly _privateKey: string;
  private readonly _apiUrl: string;
  private readonly _chain: string;
  private readonly _routerAddress: string;

  constructor(options: WalletOptions) {
    this._privateKey = options.privateKey;
    this._apiUrl = options.apiUrl;
    this._chain = options.chain;
    this._routerAddress = options.routerAddress;

    // Derive address from private key (stub: generates deterministic address from key)
    this.address = deriveAddress(options.privateKey);
  }

  /** Get USDC balance in human-readable units (e.g., 142.50). */
  async balance(): Promise<number> {
    const resp = await fetch(`${this._apiUrl}/status/${encodeURIComponent(this.address)}`);
    if (!resp.ok) throw new Error(`balance fetch failed: ${resp.status}`);
    const data = (await resp.json()) as { balance?: string };
    return data.balance ? parseFloat(data.balance) : 0;
  }

  /** Sign an EIP-2612 permit for the given flow type and amount. */
  async signPermit(flow: string, amount: number): Promise<PermitResult> {
    const resp = await fetch(`${this._apiUrl}/permits/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flow, amount, signer: this.address }),
    });
    if (!resp.ok) throw new Error(`permit prepare failed: ${resp.status}`);
    // Server returns typed data hash — we sign it
    const data = (await resp.json()) as { hash: string; deadline: number };
    const sig = await this._signHash(data.hash);
    return { ...sig, deadline: data.deadline };
  }

  /** Send a direct payment. */
  async payDirect(
    to: string,
    amount: number,
    memo: string,
    options?: { permit?: PermitResult }
  ): Promise<{ tx_hash: string; status: string }> {
    const resp = await fetch(`${this._apiUrl}/direct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.address,
        to,
        amount: Math.round(amount * 1_000_000),
        memo,
        permit: options?.permit,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `payDirect failed: ${resp.status}`);
    }
    return (await resp.json()) as { tx_hash: string; status: string };
  }

  /** Create a one-time fund link (opens the dashboard). */
  async createFundLink(options?: FundLinkOptions): Promise<FundLink> {
    const resp = await fetch(`${this._apiUrl}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "fund",
        wallet_address: this.address,
        agent_name: options?.agentName,
        messages: options?.messages,
      }),
    });
    if (!resp.ok) throw new Error(`createFundLink failed: ${resp.status}`);
    return (await resp.json()) as FundLink;
  }

  /** Register a webhook for this wallet. */
  async registerWebhook(
    url: string,
    events: string[],
    _chains?: string[]
  ): Promise<{ id: string }> {
    const resp = await fetch(`${this._apiUrl}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, events, wallet: this.address }),
    });
    if (!resp.ok) throw new Error(`registerWebhook failed: ${resp.status}`);
    return (await resp.json()) as { id: string };
  }

  /** Open a tab with a provider (positional or object form). */
  async openTab(
    providerOrOpts: string | { to: string; limit: number; perUnit: number; permit?: PermitResult },
    amount?: number,
    maxChargePerCall?: number,
    options?: { permit?: PermitResult }
  ): Promise<{ id: string; tab_id: string }> {
    let provider: string;
    let amt: number;
    let maxCharge: number;
    let permit: PermitResult | undefined;

    if (typeof providerOrOpts === "string") {
      provider = providerOrOpts;
      amt = amount!;
      maxCharge = maxChargePerCall!;
      permit = options?.permit;
    } else {
      provider = providerOrOpts.to;
      amt = providerOrOpts.limit;
      maxCharge = providerOrOpts.perUnit;
      permit = providerOrOpts.permit;
    }

    const resp = await fetch(`${this._apiUrl}/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.address,
        provider,
        amount: Math.round(amt * 1_000_000),
        max_charge_per_call: Math.round(maxCharge * 1_000_000),
        permit,
      }),
    });
    if (!resp.ok) throw new Error(`openTab failed: ${resp.status}`);
    const data = (await resp.json()) as { tab_id: string };
    return { id: data.tab_id, tab_id: data.tab_id };
  }

  /** Charge a tab (provider-side). Accepts amount as number or object with details. */
  async chargeTab(
    tabId: string,
    amountOrOpts: number | { amount: number; cumulative: number; callCount: number; providerSig: string }
  ): Promise<{ status: string }> {
    const body = typeof amountOrOpts === "number"
      ? { amount: Math.round(amountOrOpts * 1_000_000) }
      : {
          amount: Math.round(amountOrOpts.amount * 1_000_000),
          cumulative: Math.round(amountOrOpts.cumulative * 1_000_000),
          call_count: amountOrOpts.callCount,
          provider_sig: amountOrOpts.providerSig,
        };
    const resp = await fetch(`${this._apiUrl}/tabs/${tabId}/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`chargeTab failed: ${resp.status}`);
    return (await resp.json()) as { status: string };
  }

  /** Close a tab. Optionally provide final settlement details. */
  async closeTab(
    tabId: string,
    options?: { finalAmount?: number; providerSig?: string }
  ): Promise<{ status: string }> {
    const body: Record<string, unknown> = {};
    if (options?.finalAmount !== undefined) body.final_amount = Math.round(options.finalAmount * 1_000_000);
    if (options?.providerSig) body.provider_sig = options.providerSig;
    const resp = await fetch(`${this._apiUrl}/tabs/${tabId}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`closeTab failed: ${resp.status}`);
    return (await resp.json()) as { status: string };
  }

  /** Fetch contract addresses from the API. */
  async getContracts(): Promise<{ router: string; tab: string; direct: string; fee: string; usdc: string; chainId: number }> {
    const resp = await fetch(`${this._apiUrl}/contracts`);
    if (!resp.ok) throw new Error(`getContracts failed: ${resp.status}`);
    const data = (await resp.json()) as Record<string, unknown>;
    return {
      router: (data.router as string) ?? "",
      tab: (data.tab as string) ?? "",
      direct: (data.direct as string) ?? "",
      fee: (data.fee as string) ?? "",
      usdc: (data.usdc as string) ?? "",
      chainId: (data.chain_id as number) ?? 0,
    };
  }

  /** Sign a tab charge (provider-side EIP-712 signature for charge authorization). */
  async signTabCharge(
    contractAddr: string,
    tabId: string,
    cumulativeUnits: bigint | number,
    callCount: number
  ): Promise<string> {
    // Stub: real implementation will use viem signTypedData
    void this._privateKey;
    void contractAddr;
    void tabId;
    void cumulativeUnits;
    void callCount;
    return "0x" + "0".repeat(130);
  }

  // Private: sign a hash with the wallet's private key
  private async _signHash(hash: string): Promise<{ v: number; r: string; s: string }> {
    // Will use viem/ethers for real signing when server exists
    void hash;
    void this._privateKey;
    return { v: 27, r: "0x" + "0".repeat(64), s: "0x" + "0".repeat(64) };
  }
}

/** PrivateKeySigner — for manual EIP-712 signing in the playground. */
export class PrivateKeySigner {
  private readonly _key: string;

  constructor(privateKey: string) {
    this._key = privateKey;
  }

  /** Sign EIP-712 typed data. Returns hex signature. */
  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, unknown>
  ): Promise<string> {
    // Stub: will use viem signTypedData when real signing is needed
    void this._key;
    void domain;
    void types;
    void message;
    return "0x" + "0".repeat(130);
  }
}

/** Derive an Ethereum address from a private key (deterministic stub). */
function deriveAddress(privateKey: string): string {
  // Simple deterministic derivation for the playground
  // Real implementation will use viem's privateKeyToAddress
  const hash = simpleHash(privateKey);
  return "0x" + hash.slice(0, 40);
}

function simpleHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Expand to 40 hex chars
  const parts: string[] = [];
  for (let i = 0; i < 10; i++) {
    h ^= (i * 0x9e3779b9);
    h = Math.imul(h, 0x01000193);
    parts.push((h >>> 0).toString(16).padStart(8, "0"));
  }
  return parts.join("").slice(0, 40);
}
