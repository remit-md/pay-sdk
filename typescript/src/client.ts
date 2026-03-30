/**
 * PayClient — single entry point for the pay SDK.
 */

import type {
  DirectPaymentResult,
  StatusResponse,
  Tab,
  WebhookRegistration,
} from "./models.js";
import { PayNetworkError, PayServerError, PayValidationError } from "./errors.js";
import type { Signer } from "./signer.js";
import { createSigner } from "./signer.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DIRECT_MIN = 1_000_000; // $1.00 USDC
const TAB_MIN = 5_000_000; // $5.00 USDC

export const DEFAULT_API_URL = "https://pay-skill.com/api/v1";

function validateAddress(address: string, field = "address"): void {
  if (!ADDRESS_RE.test(address)) {
    throw new PayValidationError(`Invalid Ethereum address: ${address}`, field);
  }
}

function validateAmount(amount: number, minimum: number, field = "amount"): void {
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
    callback?: (hash: Uint8Array) => Uint8Array;
  };
}

export class PayClient {
  private readonly apiUrl: string;
  private readonly signer: Signer;

  constructor(options: PayClientOptions = {}) {
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    if (typeof options.signer === "object") {
      this.signer = options.signer;
    } else {
      this.signer = createSigner(options.signer ?? "cli", options.signerOptions ?? {});
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
    const data = await this.post<DirectPaymentResult>("/direct", {
      to,
      amount,
      memo: options.memo ?? "",
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
    return this.post<Tab>("/tabs", {
      provider,
      amount,
      max_charge_per_call: options.maxChargePerCall,
    });
  }

  async closeTab(tabId: string): Promise<Tab> {
    return this.post<Tab>(`/tabs/${tabId}/close`, {});
  }

  async topUpTab(tabId: string, amount: number): Promise<Tab> {
    validateAmount(amount, 1, "amount");
    return this.post<Tab>(`/tabs/${tabId}/topup`, { amount });
  }

  async listTabs(): Promise<Tab[]> {
    return this.get<Tab[]>("/tabs");
  }

  async getTab(tabId: string): Promise<Tab> {
    return this.get<Tab>(`/tabs/${tabId}`);
  }

  // ── x402 ────────────────────────────────────────────────────────

  async request(
    url: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    // Stub: full x402 flow will be implemented when server endpoints exist
    const resp = await fetch(url, {
      method: options.method ?? "GET",
      body: options.body ? JSON.stringify(options.body) : undefined,
      headers: options.headers,
    });
    // TODO: handle 402 → sign → retry
    return resp;
  }

  // ── Wallet ──────────────────────────────────────────────────────

  async getStatus(): Promise<StatusResponse> {
    return this.get<StatusResponse>("/status");
  }

  // ── Webhooks ────────────────────────────────────────────────────

  async registerWebhook(
    url: string,
    options: { events?: string[]; secret?: string } = {}
  ): Promise<WebhookRegistration> {
    const payload: Record<string, unknown> = { url };
    if (options.events) payload.events = options.events;
    if (options.secret) payload.secret = options.secret;
    return this.post<WebhookRegistration>("/webhooks", payload);
  }

  async listWebhooks(): Promise<WebhookRegistration[]> {
    return this.get<WebhookRegistration[]>("/webhooks");
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.delete(`/webhooks/${webhookId}`);
  }

  // ── Funding ─────────────────────────────────────────────────────

  async createFundLink(amount?: number): Promise<string> {
    const params = amount ? `?amount=${amount}` : "";
    const data = await this.get<{ url: string }>(`/fund-link${params}`);
    return data.url;
  }

  async createWithdrawLink(amount?: number): Promise<string> {
    const params = amount ? `?amount=${amount}` : "";
    const data = await this.get<{ url: string }>(`/withdraw-link${params}`);
    return data.url;
  }

  // ── HTTP helpers ────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(`${this.apiUrl}${path}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      throw new PayNetworkError(String(e));
    }
    return this.handleResponse<T>(resp);
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(`${this.apiUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new PayNetworkError(String(e));
    }
    return this.handleResponse<T>(resp);
  }

  private async delete(path: string): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(`${this.apiUrl}${path}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
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
