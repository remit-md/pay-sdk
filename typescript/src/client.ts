/**
 * PayClient — single entry point for the pay SDK.
 */

import type {
  DirectPaymentResult,
  StatusResponse,
  Tab,
  WebhookRegistration,
} from "./models.js";
import {
  PayNetworkError,
  PayServerError,
  PayValidationError,
} from "./errors.js";
import type { Signer } from "./signer.js";
import { createSigner } from "./signer.js";
import {
  buildAuthHeaders,
  buildAuthHeadersWithSigner,
  type AuthConfig,
  type AuthHeaders,
} from "./auth.js";
import type { Hex, Address } from "viem";
import { sign as viemSign, serializeSignature } from "viem/accounts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DIRECT_MIN = 1_000_000; // $1.00 USDC
const TAB_MIN = 5_000_000; // $5.00 USDC

export const DEFAULT_API_URL = "https://pay-skill.com/api/v1";

function validateAddress(address: string, field = "address"): void {
  if (!ADDRESS_RE.test(address)) {
    throw new PayValidationError(
      `Invalid Ethereum address: ${address}`,
      field
    );
  }
}

function validateAmount(
  amount: number,
  minimum: number,
  field = "amount"
): void {
  if (amount < minimum) {
    const minUsd = minimum / 1_000_000;
    throw new PayValidationError(
      `Amount ${amount} below minimum ($${minUsd.toFixed(2)})`,
      field
    );
  }
}

export interface PayClientOptions {
  apiUrl?: string;
  signer?: Signer | "cli" | "raw" | "custom";
  signerOptions?: {
    command?: string;
    key?: string;
    address?: string;
    callback?: (hash: Uint8Array) => Uint8Array;
  };
  /** Private key for direct auth signing (alternative to signer). */
  privateKey?: string;
  /** Chain ID for EIP-712 domain (default: 8453 for Base). */
  chainId?: number;
  /** Router contract address for EIP-712 domain. */
  routerAddress?: string;
}

export class PayClient {
  private readonly apiUrl: string;
  /** URL path prefix extracted from apiUrl (e.g., "/api/v1"). */
  private readonly _basePath: string;
  private readonly signer: Signer;
  private readonly _privateKey: Hex | null;
  private readonly _authConfig: AuthConfig | null;

  constructor(options: PayClientOptions = {}) {
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    // Extract the URL path to prepend to auth signing paths.
    // e.g., "http://host:3001/api/v1" → "/api/v1"
    try {
      this._basePath = new URL(this.apiUrl).pathname.replace(/\/+$/, "");
    } catch {
      this._basePath = "";
    }
    if (typeof options.signer === "object") {
      this.signer = options.signer;
    } else {
      this.signer = createSigner(options.signer ?? "cli", {
        ...options.signerOptions,
        key: options.signerOptions?.key ?? options.privateKey,
      });
    }

    // Private key for direct signing (preferred over Signer for auth)
    this._privateKey = options.privateKey
      ? ((options.privateKey.startsWith("0x")
          ? options.privateKey
          : "0x" + options.privateKey) as Hex)
      : null;

    // Auth config for EIP-712 domain
    if (options.chainId && options.routerAddress) {
      this._authConfig = {
        chainId: options.chainId,
        routerAddress: options.routerAddress as Address,
      };
    } else {
      this._authConfig = null;
    }
  }

  // ── Direct Payment ──────────────────────────────────────────────

  async payDirect(
    to: string,
    amount: number,
    options: { memo?: string } = {}
  ): Promise<DirectPaymentResult> {
    validateAddress(to, "to");
    validateAmount(amount, DIRECT_MIN);

    // Get contract addresses to determine the spender
    const contracts = await this.get<{ direct: string }>("/contracts");
    const permit = await this.prepareAndSignPermit(amount, contracts.direct);

    const data = await this.post<DirectPaymentResult>("/direct", {
      to,
      amount,
      memo: options.memo ?? "",
      permit,
    });
    return data;
  }

  // ── Tab Management ──────────────────────────────────────────────

  async openTab(
    provider: string,
    amount: number,
    options: { maxChargePerCall: number }
  ): Promise<Tab> {
    validateAddress(provider, "provider");
    validateAmount(amount, TAB_MIN);
    if (options.maxChargePerCall <= 0) {
      throw new PayValidationError(
        "maxChargePerCall must be positive",
        "maxChargePerCall"
      );
    }
    const contracts = await this.get<{ tab: string }>("/contracts");
    const permit = await this.prepareAndSignPermit(amount, contracts.tab);

    return this.post<Tab>("/tabs", {
      provider,
      amount,
      max_charge_per_call: options.maxChargePerCall,
      permit,
    });
  }

  async closeTab(tabId: string): Promise<Tab> {
    return this.post<Tab>(`/tabs/${tabId}/close`, {});
  }

  async withdrawTab(tabId: string): Promise<Tab> {
    return this.post<Tab>(`/tabs/${tabId}/withdraw`, {});
  }

  async topUpTab(tabId: string, amount: number): Promise<Tab> {
    validateAmount(amount, 1, "amount");
    const contracts = await this.get<{ tab: string }>("/contracts");
    const permit = await this.prepareAndSignPermit(amount, contracts.tab);
    return this.post<Tab>(`/tabs/${tabId}/topup`, { amount, permit });
  }

  async listTabs(): Promise<Tab[]> {
    return this.get<Tab[]>("/tabs");
  }

  async getTab(tabId: string): Promise<Tab> {
    return this.get<Tab>(`/tabs/${tabId}`);
  }

  // ── x402 ────────────────────────────────────────────────────────

  private static readonly X402_TAB_MULTIPLIER = 10;

  async request(
    url: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {}
  ): Promise<Response> {
    const method = options.method ?? "GET";
    const headers = options.headers ?? {};
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

    const resp = await fetch(url, { method, body: bodyStr, headers });

    if (resp.status !== 402) return resp;

    return this.handle402(resp, url, method, bodyStr, headers);
  }

  /**
   * Parse x402 V2 payment requirements from a 402 response.
   *
   * Checks PAYMENT-REQUIRED header first (base64-encoded JSON),
   * falls back to response body for requirements.
   */
  private async parse402Requirements(resp: Response): Promise<{
    settlement: string;
    amount: number;
    to: string;
  }> {
    // V2: check PAYMENT-REQUIRED header (base64-encoded JSON)
    const prHeader = resp.headers.get("payment-required");
    if (prHeader) {
      try {
        const decoded = JSON.parse(atob(prHeader)) as Record<string, unknown>;
        return {
          settlement: String(decoded.settlement ?? "direct"),
          amount: Number(decoded.amount ?? 0),
          to: String(decoded.to ?? ""),
        };
      } catch {
        // Fall through to body parsing
      }
    }

    // Fallback: parse from response body
    const body = (await resp.json()) as Record<string, unknown>;
    const requirements = (body.requirements ?? body) as Record<string, unknown>;
    return {
      settlement: String(requirements.settlement ?? "direct"),
      amount: Number(requirements.amount ?? 0),
      to: String(requirements.to ?? ""),
    };
  }

  private async handle402(
    resp: Response,
    url: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>
  ): Promise<Response> {
    const { settlement, amount, provider } = await (async () => {
      const r = await this.parse402Requirements(resp);
      return { settlement: r.settlement, amount: r.amount, provider: r.to };
    })();

    if (settlement === "tab") {
      return this.settleViaTab(url, method, body, headers, provider, amount);
    }
    return this.settleViaDirect(url, method, body, headers, provider, amount);
  }

  private async settleViaDirect(
    url: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
    provider: string,
    amount: number
  ): Promise<Response> {
    const result = await this.payDirect(provider, amount);
    // Server returns snake_case (tx_hash) but TS model uses camelCase (txHash).
    const txHash =
      result.txHash ??
      (result as unknown as { tx_hash?: string }).tx_hash ??
      "";

    // V2: send PAYMENT-SIGNATURE header with payment proof JSON
    const paymentSignature = JSON.stringify({
      settlement: "direct",
      tx_hash: txHash,
      status: result.status,
    });

    return fetch(url, {
      method,
      body,
      headers: {
        ...headers,
        "PAYMENT-SIGNATURE": paymentSignature,
      },
    });
  }

  private async settleViaTab(
    url: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
    provider: string,
    amount: number
  ): Promise<Response> {
    const tabs = await this.listTabs();
    let tab = tabs.find((t) => t.provider === provider && t.status === "open");

    if (!tab) {
      const tabAmount = Math.max(
        amount * PayClient.X402_TAB_MULTIPLIER,
        TAB_MIN
      );
      tab = await this.openTab(provider, tabAmount, {
        maxChargePerCall: amount,
      });
    }

    const chargeData = await this.post<{ chargeId: string }>(
      `/tabs/${tab.tabId}/charge`,
      { amount }
    );

    // V2: send PAYMENT-SIGNATURE header with payment proof JSON
    const paymentSignature = JSON.stringify({
      settlement: "tab",
      tab_id: tab.tabId,
      charge_id: chargeData.chargeId ?? "",
    });

    return fetch(url, {
      method,
      body,
      headers: {
        ...headers,
        "PAYMENT-SIGNATURE": paymentSignature,
      },
    });
  }

  // ── Wallet ──────────────────────────────────────────────────────

  async getStatus(): Promise<StatusResponse> {
    const raw = await this.get<{
      wallet: string;
      balance_usdc: string | null;
      open_tabs: number;
      total_locked: number;
    }>("/status");
    return {
      address: raw.wallet,
      balance: raw.balance_usdc ? Number(raw.balance_usdc) : 0,
      openTabs: [],
    };
  }

  // ── Webhooks ────────────────────────────────────────────────────

  async registerWebhook(
    url: string,
    options: { events?: string[]; secret?: string } = {}
  ): Promise<WebhookRegistration> {
    const payload: Record<string, unknown> = { url };
    if (options.events) payload.events = options.events;
    if (options.secret) payload.secret = options.secret;
    const raw = await this.post<{ id: string; wallet: string; url: string; events: string[]; active: boolean }>("/webhooks", payload);
    return { webhookId: raw.id, url: raw.url, events: raw.events };
  }

  async listWebhooks(): Promise<WebhookRegistration[]> {
    const raw = await this.get<{ id: string; wallet: string; url: string; events: string[]; active: boolean }[]>("/webhooks");
    return raw.map(w => ({ webhookId: w.id, url: w.url, events: w.events }));
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.del(`/webhooks/${webhookId}`);
  }

  // ── Funding ─────────────────────────────────────────────────────

  /** Create a one-time fund link via the server. Returns the dashboard URL. */
  async createFundLink(options?: {
    messages?: unknown[];
    agentName?: string;
  }): Promise<string> {
    const data = await this.post<{ url: string }>("/links/fund", {
      messages: options?.messages ?? [],
      agent_name: options?.agentName,
    });
    return data.url;
  }

  /** Create a one-time withdraw link via the server. Returns the dashboard URL. */
  async createWithdrawLink(options?: {
    messages?: unknown[];
    agentName?: string;
  }): Promise<string> {
    const data = await this.post<{ url: string }>("/links/withdraw", {
      messages: options?.messages ?? [],
      agent_name: options?.agentName,
    });
    return data.url;
  }

  // ── Permit signing ────────────────────────────────────────────

  /**
   * Prepare and sign a USDC EIP-2612 permit.
   *
   * 1. Calls GET /api/v1/permit/prepare to get the EIP-712 hash
   * 2. Signs the hash with the agent's private key
   * 3. Returns {nonce, deadline, v, r, s} for inclusion in payment body
   */
  private async prepareAndSignPermit(
    amount: number,
    spender: string
  ): Promise<{ nonce: string; deadline: number; v: number; r: string; s: string }> {
    if (!this._privateKey) {
      throw new PayValidationError(
        "privateKey required for permit signing",
        "privateKey"
      );
    }

    const prepare = await this.post<{
      hash: string;
      nonce: string;
      deadline: number;
    }>("/permit/prepare", { amount, spender });

    // Sign the hash
    const hashHex = prepare.hash as Hex;
    const raw = await viemSign({ hash: hashHex, privateKey: this._privateKey });
    const sigHex = serializeSignature(raw);

    // Parse signature into v, r, s
    const sigBytes = Buffer.from(sigHex.slice(2), "hex");
    const r = "0x" + sigBytes.subarray(0, 32).toString("hex");
    const s = "0x" + sigBytes.subarray(32, 64).toString("hex");
    const v = sigBytes[64];

    return {
      nonce: prepare.nonce,
      deadline: prepare.deadline,
      v,
      r,
      s,
    };
  }

  // ── Auth headers ──────────────────────────────────────────────

  private async authHeaders(
    method: string,
    path: string
  ): Promise<AuthHeaders | null> {
    if (!this._authConfig) return null;

    // Sign only the path portion (no query string) — server verifies against uri.path().
    // e.g., basePath="/api/v1" + path="/status" → "/api/v1/status"
    const fullPath = this._basePath + path.split("?")[0];

    if (this._privateKey) {
      return buildAuthHeaders(
        this._privateKey,
        method,
        fullPath,
        this._authConfig
      );
    }

    if (this.signer.address) {
      return buildAuthHeadersWithSigner(
        this.signer,
        method,
        fullPath,
        this._authConfig
      );
    }

    return null;
  }

  // ── HTTP helpers ────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    let resp: Response;
    try {
      const auth = await this.authHeaders("GET", path);
      resp = await fetch(`${this.apiUrl}${path}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...auth,
        },
      });
    } catch (e) {
      throw new PayNetworkError(String(e));
    }
    return this.handleResponse<T>(resp);
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    let resp: Response;
    try {
      const auth = await this.authHeaders("POST", path);
      resp = await fetch(`${this.apiUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth,
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new PayNetworkError(String(e));
    }
    return this.handleResponse<T>(resp);
  }

  private async del(path: string): Promise<void> {
    let resp: Response;
    try {
      const auth = await this.authHeaders("DELETE", path);
      resp = await fetch(`${this.apiUrl}${path}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...auth,
        },
      });
    } catch (e) {
      throw new PayNetworkError(String(e));
    }
    if (resp.status >= 400) {
      const text = await resp.text();
      throw new PayServerError(text, resp.status);
    }
  }

  private async handleResponse<T>(resp: Response): Promise<T> {
    if (resp.status >= 400) {
      let msg: string;
      try {
        const body = (await resp.json()) as { error?: string };
        msg = body.error ?? (await resp.text());
      } catch {
        msg = await resp.text();
      }
      throw new PayServerError(msg, resp.status);
    }
    if (resp.status === 204) {
      return undefined as T;
    }
    return (await resp.json()) as T;
  }
}
