/**
 * Wallet — high-level write client for agents.
 * Wraps PayClient with private key signing and balance tracking.
 *
 * This is the primary entry point for the playground and agent integrations.
 * The PayClient is lower-level (HTTP only); Wallet adds signing + state.
 */

import { type Hex, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { buildAuthHeaders, type AuthConfig } from "./auth.js";

export interface WalletOptions {
  privateKey: string;
  chain: string;
  apiUrl: string;
  routerAddress: string;
  /** Numeric chain ID for EIP-712 domain. If omitted, parsed from `chain`. */
  chainId?: number;
}

export interface FundLinkOptions {
  messages?: unknown[];
  agentName?: string;
}

export interface PermitResult {
  nonce: string;
  deadline: number;
  v: number;
  r: string;
  s: string;
}

/** Map well-known chain names to numeric IDs. */
const CHAIN_IDS: Record<string, number> = {
  "base": 8453,
  "base-sepolia": 84532,
};

export class Wallet {
  readonly address: string;
  private readonly _privateKey: Hex;
  private readonly _apiUrl: string;
  private readonly _chain: string;
  private readonly _chainId: number;
  private readonly _routerAddress: Address;
  private readonly _account: PrivateKeyAccount;

  /** URL path prefix extracted from apiUrl (e.g., "/api/v1"). */
  private readonly _basePath: string;

  /** Cached contracts response. */
  private _contractsCache: { router: string; tab: string; direct: string; fee: string; usdc: string; chainId: number } | null = null;

  constructor(options: WalletOptions) {
    this._privateKey = normalizeKey(options.privateKey);
    this._apiUrl = options.apiUrl;
    this._chain = options.chain;
    this._chainId = options.chainId ?? CHAIN_IDS[options.chain] ?? (parseInt(options.chain, 10) || 8453);
    this._routerAddress = options.routerAddress as Address;
    this._account = privateKeyToAccount(this._privateKey);
    this.address = this._account.address;
    try {
      this._basePath = new URL(options.apiUrl).pathname.replace(/\/+$/, "");
    } catch {
      this._basePath = "";
    }
  }

  private get _authConfig(): AuthConfig {
    return {
      chainId: this._chainId,
      routerAddress: this._routerAddress,
    };
  }

  /** Build authenticated fetch headers for an API request. */
  private async _authFetch(
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    // Sign only the path portion (no query string) — server verifies against uri.path().
    const pathOnly = path.split("?")[0];
    const signPath = this._basePath + pathOnly;
    const authHeaders = await buildAuthHeaders(
      this._privateKey,
      method,
      signPath,
      this._authConfig
    );
    const resp = await fetch(`${this._apiUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    return resp;
  }

  /** Get USDC balance in human-readable units (e.g., 142.50). */
  async balance(): Promise<number> {
    const resp = await this._authFetch("/status");
    if (!resp.ok) throw new Error(`balance fetch failed: ${resp.status}`);
    const data = (await resp.json()) as { balance_usdc?: string };
    if (!data.balance_usdc) return 0;
    const raw = parseFloat(data.balance_usdc);
    // Server returns raw micro-units (USDC 6 decimals). Convert to dollars.
    return raw / 1_000_000;
  }

  /**
   * Sign an EIP-2612 permit for a given spender and amount.
   * Uses the server's /permit/prepare endpoint to get the nonce and hash,
   * then signs the hash locally.
   * @param flow — "direct" or "tab" (used to look up the spender contract address)
   * @param amount — micro-USDC amount
   */
  async signPermit(flow: string, amount: number): Promise<PermitResult> {
    const contracts = await this.getContracts();
    const spender = flow === "tab" ? contracts.tab : contracts.direct;

    // Server prepares the permit: reads nonce via its own RPC, computes EIP-712 hash
    const prepResp = await this._authFetch("/permit/prepare", {
      method: "POST",
      body: JSON.stringify({ amount, spender }),
    });
    if (!prepResp.ok) {
      const err = (await prepResp.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `permit/prepare failed: ${prepResp.status}`);
    }
    const prep = (await prepResp.json()) as {
      hash: string;
      nonce: string;
      deadline: number;
      spender: string;
      amount: number;
    };

    // Sign the pre-computed EIP-712 hash locally (raw ECDSA, no EIP-191 prefix)
    const signature = await this._account.sign({
      hash: prep.hash as `0x${string}`,
    });

    // Parse 65-byte signature into v, r, s
    const sigClean = signature.startsWith("0x") ? signature.slice(2) : signature;
    const r = "0x" + sigClean.slice(0, 64);
    const s = "0x" + sigClean.slice(64, 128);
    const v = parseInt(sigClean.slice(128, 130), 16);

    return { nonce: prep.nonce, deadline: prep.deadline, v, r, s };
  }

  /** Send a direct payment. Auto-signs permit if not provided. */
  async payDirect(
    to: string,
    amount: number,
    memo: string,
    options?: { permit?: PermitResult }
  ): Promise<{ tx_hash: string; status: string }> {
    const microAmount = Math.round(amount * 1_000_000);

    // Auto-sign permit if not provided
    let permit = options?.permit;
    if (!permit) {
      permit = await this.signPermit("direct", microAmount);
    }

    const resp = await this._authFetch("/direct", {
      method: "POST",
      body: JSON.stringify({
        to,
        amount: microAmount,
        memo,
        permit,
      }),
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `payDirect failed: ${resp.status}`);
    }
    return (await resp.json()) as { tx_hash: string; status: string };
  }

  /** Create a one-time fund link via the server. Returns the dashboard URL. */
  async createFundLink(options?: FundLinkOptions): Promise<string> {
    const resp = await this._authFetch("/links/fund", {
      method: "POST",
      body: JSON.stringify({
        messages: options?.messages ?? [],
        agent_name: options?.agentName,
      }),
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `createFundLink failed: ${resp.status}`);
    }
    const data = (await resp.json()) as { url: string };
    return data.url;
  }

  /** Create a one-time withdraw link via the server. Returns the dashboard URL. */
  async createWithdrawLink(options?: FundLinkOptions): Promise<string> {
    const resp = await this._authFetch("/links/withdraw", {
      method: "POST",
      body: JSON.stringify({
        messages: options?.messages ?? [],
        agent_name: options?.agentName,
      }),
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `createWithdrawLink failed: ${resp.status}`);
    }
    const data = (await resp.json()) as { url: string };
    return data.url;
  }

  /** Register a webhook for this wallet. */
  async registerWebhook(
    url: string,
    events: string[],
    secret?: string
  ): Promise<{ id: string }> {
    const payload: Record<string, unknown> = { url, events };
    if (secret) payload.secret = secret;
    const resp = await this._authFetch("/webhooks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`registerWebhook failed: ${resp.status}`);
    return (await resp.json()) as { id: string };
  }

  /** Open a tab with a provider (positional or object form). */
  async openTab(
    providerOrOpts:
      | string
      | {
          to: string;
          limit: number;
          perUnit: number;
          permit?: PermitResult;
        },
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

    const microAmount = Math.round(amt * 1_000_000);

    // Auto-sign permit if not provided
    if (!permit) {
      permit = await this.signPermit("tab", microAmount);
    }

    const resp = await this._authFetch("/tabs", {
      method: "POST",
      body: JSON.stringify({
        provider,
        amount: microAmount,
        max_charge_per_call: Math.round(maxCharge * 1_000_000),
        permit,
      }),
    });
    if (!resp.ok) throw new Error(`openTab failed: ${resp.status}`);
    const data = (await resp.json()) as { tab_id: string };
    return { id: data.tab_id, tab_id: data.tab_id };
  }

  /** Charge a tab (provider-side). */
  async chargeTab(
    tabId: string,
    amountOrOpts:
      | number
      | {
          amount: number;
          cumulative: number;
          callCount: number;
          providerSig: string;
        }
  ): Promise<{ status: string }> {
    const body =
      typeof amountOrOpts === "number"
        ? { amount: Math.round(amountOrOpts * 1_000_000) }
        : {
            amount: Math.round(amountOrOpts.amount * 1_000_000),
            cumulative: Math.round(amountOrOpts.cumulative * 1_000_000),
            call_count: amountOrOpts.callCount,
            provider_sig: amountOrOpts.providerSig,
          };
    const resp = await this._authFetch(`/tabs/${tabId}/charge`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`chargeTab failed: ${resp.status}`);
    return (await resp.json()) as { status: string };
  }

  /** Close a tab. */
  async closeTab(
    tabId: string,
    options?: { finalAmount?: number; providerSig?: string }
  ): Promise<{ status: string }> {
    const body: Record<string, unknown> = {};
    if (options?.finalAmount !== undefined)
      body.final_amount = Math.round(options.finalAmount * 1_000_000);
    if (options?.providerSig) body.provider_sig = options.providerSig;
    const resp = await this._authFetch(`/tabs/${tabId}/close`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`closeTab failed: ${resp.status}`);
    return (await resp.json()) as { status: string };
  }

  /** Fetch contract addresses from the API (public, no auth). */
  async getContracts(): Promise<{
    router: string;
    tab: string;
    direct: string;
    fee: string;
    usdc: string;
    chainId: number;
  }> {
    if (this._contractsCache) return this._contractsCache;
    const resp = await fetch(`${this._apiUrl}/contracts`);
    if (!resp.ok) throw new Error(`getContracts failed: ${resp.status}`);
    const data = (await resp.json()) as Record<string, unknown>;
    this._contractsCache = {
      router: (data.router as string) ?? "",
      tab: (data.tab as string) ?? "",
      direct: (data.direct as string) ?? "",
      fee: (data.fee as string) ?? "",
      usdc: (data.usdc as string) ?? "",
      chainId: (data.chain_id as number) ?? 0,
    };
    return this._contractsCache;
  }

  /** Sign a tab charge (provider-side EIP-712 signature). */
  async signTabCharge(
    contractAddr: string,
    tabId: string,
    cumulativeUnits: bigint | number,
    callCount: number
  ): Promise<string> {
    return this._account.signTypedData({
      domain: {
        name: "pay",
        version: "0.1",
        chainId: this._chainId,
        verifyingContract: contractAddr as Address,
      },
      types: {
        TabCharge: [
          { name: "tabId", type: "string" },
          { name: "cumulativeUnits", type: "uint256" },
          { name: "callCount", type: "uint256" },
        ],
      },
      primaryType: "TabCharge",
      message: {
        tabId,
        cumulativeUnits: BigInt(cumulativeUnits),
        callCount: BigInt(callCount),
      },
    });
  }

  /** Sign a raw hash with the wallet's private key. */
  private async _signHash(
    hash: string
  ): Promise<{ v: number; r: string; s: string }> {
    const signature = await this._account.signMessage({
      message: { raw: hash as Hex },
    });
    // Parse 65-byte signature into v, r, s
    const sigClean = signature.startsWith("0x")
      ? signature.slice(2)
      : signature;
    const r = "0x" + sigClean.slice(0, 64);
    const s = "0x" + sigClean.slice(64, 128);
    const v = parseInt(sigClean.slice(128, 130), 16);
    return { v, r, s };
  }
}

/** PrivateKeySigner — for manual EIP-712 signing in the playground. */
export class PrivateKeySigner {
  private readonly _account: PrivateKeyAccount;
  readonly address: string;

  constructor(privateKey: string) {
    const key = normalizeKey(privateKey);
    this._account = privateKeyToAccount(key);
    this.address = this._account.address;
  }

  /** Sign EIP-712 typed data. Returns hex signature. */
  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, unknown>
  ): Promise<string> {
    return this._account.signTypedData({
      domain: domain as Parameters<
        PrivateKeyAccount["signTypedData"]
      >[0]["domain"],
      types: types as Parameters<
        PrivateKeyAccount["signTypedData"]
      >[0]["types"],
      primaryType: Object.keys(types)[0],
      message,
    });
  }
}

/** Normalize a private key to 0x-prefixed Hex. */
function normalizeKey(key: string): Hex {
  if (key.startsWith("0x")) return key as Hex;
  return ("0x" + key) as Hex;
}
