/**
 * Wallet — the single entry point for the pay SDK.
 *
 * Zero-config for agents:  new Wallet()          (reads PAYSKILL_KEY env)
 * Explicit key:            new Wallet({ privateKey: "0x..." })
 * OS keychain (CLI key):   await Wallet.create()
 * OWS wallet extension:    await Wallet.fromOws({ walletId: "..." })
 */

import { type Hex, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { buildAuthHeaders, buildAuthHeadersSigned } from "./auth.js";
import { signTransferAuthorization, combinedSignature } from "./eip3009.js";
import { readFromKeychain } from "./keychain.js";
import {
  PayError,
  PayValidationError,
  PayNetworkError,
  PayServerError,
  PayInsufficientFundsError,
} from "./errors.js";

// ── Constants ────────────────────────────────────────────────────────

const MAINNET_API_URL = "https://pay-skill.com/api/v1";
const TESTNET_API_URL = "https://testnet.pay-skill.com/api/v1";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const DIRECT_MIN_MICRO = 1_000_000; // $1.00
const TAB_MIN_MICRO = 5_000_000; // $5.00
const TAB_MULTIPLIER = 10;
const DEFAULT_TIMEOUT = 30_000;

// Internal sentinel for OWS construction
const _OWS_INIT = Symbol("ows-init");

// ── Public Types ─────────────────────────────────────────────────────

/** Dollar amount (default) or micro-USDC for precision. */
export type Amount = number | { micro: number };

export interface WalletOptions {
  /** Hex private key. If omitted, reads from PAYSKILL_KEY env var. */
  privateKey?: string;
  /** Use Base Sepolia testnet. Default: false (mainnet). Also reads PAYSKILL_TESTNET env. */
  testnet?: boolean;
  /** Request timeout in ms. Default: 30000. */
  timeout?: number;
}

export interface OwsWalletOptions {
  /** OWS wallet name or UUID (e.g. "pay-my-agent"). */
  walletId: string;
  /** OWS API key token (passed as passphrase to OWS signing calls). */
  owsApiKey?: string;
  /** Use Base Sepolia testnet. Default: false (mainnet). */
  testnet?: boolean;
  /** Request timeout in ms. Default: 30000. */
  timeout?: number;
  /** @internal Inject OWS module for testing. */
  _owsModule?: unknown;
}

export interface SendResult {
  txHash: string;
  status: string;
  amount: number;
  fee: number;
}

export interface Tab {
  id: string;
  provider: string;
  amount: number;
  balanceRemaining: number;
  totalCharged: number;
  chargeCount: number;
  maxChargePerCall: number;
  totalWithdrawn: number;
  status: "open" | "closed";
  pendingChargeCount: number;
  pendingChargeTotal: number;
  effectiveBalance: number;
}

export interface ChargeResult {
  chargeId: string;
  status: string;
}

export interface Balance {
  total: number;
  locked: number;
  available: number;
}

export interface Status {
  address: string;
  balance: Balance;
  openTabs: number;
}

export interface DiscoverService {
  name: string;
  description: string;
  baseUrl: string;
  category: string;
  keywords: string[];
  routes: {
    path: string;
    method?: string;
    price?: string;
    settlement?: string;
  }[];
  docsUrl?: string;
}

export interface DiscoverOptions {
  sort?: string;
  category?: string;
  settlement?: string;
}

export interface FundLinkOptions {
  message?: string;
  agentName?: string;
}

export interface WebhookRegistration {
  id: string;
  url: string;
  events: string[];
}

export interface MintResult {
  txHash: string;
  amount: number;
}

// ── Private Types ────────────────────────────────────────────────────

interface Contracts {
  router: Address;
  tab: Address;
  direct: Address;
  fee: Address;
  usdc: Address;
  chainId: number;
  relayer: Address;
}

interface Permit {
  nonce: string;
  deadline: number;
  v: number;
  r: string;
  s: string;
}

type SignTypedDataFn = (params: {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}) => Promise<string>;

// Raw server response (snake_case)
interface RawTab {
  tab_id: string;
  provider: string;
  amount: number;
  balance_remaining: number;
  total_charged: number;
  charge_count: number;
  max_charge_per_call: number;
  total_withdrawn: number;
  status: "open" | "closed";
  pending_charge_count: number;
  pending_charge_total: number;
  effective_balance: number;
}

/** Subset of @open-wallet-standard/core we call at runtime. */
interface OwsModule {
  getWallet(
    nameOrId: string,
    vaultPath?: string,
  ): {
    id: string;
    name: string;
    accounts: Array<{
      chainId: string;
      address: string;
      derivationPath: string;
    }>;
  };
  signTypedData(
    wallet: string,
    chain: string,
    typedDataJson: string,
    passphrase?: string,
    index?: number,
    vaultPath?: string,
  ): { signature: string; recoveryId?: number };
}

// ── Helpers ──────────────────────────────────────────────────────────

function normalizeKey(key: string): Hex {
  const clean = key.startsWith("0x") ? key : "0x" + key;
  if (!KEY_RE.test(clean)) {
    throw new PayValidationError(
      "Invalid private key: must be 32 bytes hex",
      "privateKey",
    );
  }
  return clean as Hex;
}

function validateAddress(address: string): void {
  if (!ADDRESS_RE.test(address)) {
    throw new PayValidationError(
      `Invalid Ethereum address: ${address}`,
      "address",
    );
  }
}

function toMicro(amount: Amount): number {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new PayValidationError(
        "Amount must be a positive finite number",
        "amount",
      );
    }
    return Math.round(amount * 1_000_000);
  }
  if (!Number.isInteger(amount.micro) || amount.micro < 0) {
    throw new PayValidationError(
      "Micro amount must be a non-negative integer",
      "amount",
    );
  }
  return amount.micro;
}

function toDollars(micro: number): number {
  return micro / 1_000_000;
}

function parseTab(raw: RawTab): Tab {
  return {
    id: raw.tab_id,
    provider: raw.provider,
    amount: toDollars(raw.amount),
    balanceRemaining: toDollars(raw.balance_remaining),
    totalCharged: toDollars(raw.total_charged),
    chargeCount: raw.charge_count,
    maxChargePerCall: toDollars(raw.max_charge_per_call),
    totalWithdrawn: toDollars(raw.total_withdrawn),
    status: raw.status,
    pendingChargeCount: raw.pending_charge_count,
    pendingChargeTotal: toDollars(raw.pending_charge_total),
    effectiveBalance: toDollars(raw.effective_balance),
  };
}

function parseSig(signature: string): { v: number; r: string; s: string } {
  const sig = signature.startsWith("0x")
    ? signature.slice(2)
    : signature;
  return {
    v: parseInt(sig.slice(128, 130), 16),
    r: "0x" + sig.slice(0, 64),
    s: "0x" + sig.slice(64, 128),
  };
}

function resolveApiUrl(testnet: boolean): string {
  return (
    process.env.PAYSKILL_API_URL ??
    (testnet ? TESTNET_API_URL : MAINNET_API_URL)
  );
}

function createOwsSignTypedData(
  ows: OwsModule,
  walletId: string,
  owsApiKey?: string,
): SignTypedDataFn {
  return async (params) => {
    // Build EIP712Domain type from domain fields
    const domainType: Array<{ name: string; type: string }> = [];
    const d = params.domain;
    if (d.name !== undefined)
      domainType.push({ name: "name", type: "string" });
    if (d.version !== undefined)
      domainType.push({ name: "version", type: "string" });
    if (d.chainId !== undefined)
      domainType.push({ name: "chainId", type: "uint256" });
    if (d.verifyingContract !== undefined)
      domainType.push({ name: "verifyingContract", type: "address" });

    const fullTypedData = {
      types: {
        EIP712Domain: domainType,
        ...Object.fromEntries(
          Object.entries(params.types).map(([k, v]) => [k, [...v]]),
        ),
      },
      primaryType: params.primaryType,
      domain: params.domain,
      message: params.message,
    };

    const json = JSON.stringify(fullTypedData, (_key, v) =>
      typeof v === "bigint" ? v.toString() : (v as unknown),
    );

    const result = ows.signTypedData(walletId, "evm", json, owsApiKey);

    const sig = result.signature.startsWith("0x")
      ? result.signature.slice(2)
      : result.signature;
    if (sig.length === 130) return `0x${sig}` as `0x${string}`;
    const v = (result.recoveryId ?? 0) + 27;
    return `0x${sig}${v.toString(16).padStart(2, "0")}` as `0x${string}`;
  };
}

// ── Standalone discover (no wallet needed) ───────────────────────────

export async function discover(
  query?: string,
  options?: DiscoverOptions & { testnet?: boolean },
): Promise<DiscoverService[]> {
  const testnet = options?.testnet ?? !!process.env.PAYSKILL_TESTNET;
  const apiUrl = resolveApiUrl(testnet);
  return discoverImpl(apiUrl, DEFAULT_TIMEOUT, query, options);
}

async function discoverImpl(
  apiUrl: string,
  timeout: number,
  query?: string,
  options?: DiscoverOptions,
): Promise<DiscoverService[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (options?.sort) params.set("sort", options.sort);
  if (options?.category) params.set("category", options.category);
  if (options?.settlement) params.set("settlement", options.settlement);
  const qs = params.toString();
  const url = `${apiUrl}/discover${qs ? `?${qs}` : ""}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!resp.ok) {
    throw new PayServerError(`discover failed: ${resp.status}`, resp.status);
  }
  const data = (await resp.json()) as {
    services: Array<Record<string, unknown>>;
  };
  return data.services.map((s) => ({
    name: String(s.name ?? ""),
    description: String(s.description ?? ""),
    baseUrl: String(s.base_url ?? s.baseUrl ?? ""),
    category: String(s.category ?? ""),
    keywords: (s.keywords as string[]) ?? [],
    routes: (s.routes as DiscoverService["routes"]) ?? [],
    docsUrl: s.docs_url != null || s.docsUrl != null
      ? String(s.docs_url ?? s.docsUrl)
      : undefined,
  }));
}

// ── Wallet ───────────────────────────────────────────────────────────

export class Wallet {
  readonly address: string;

  // Signing: signTypedData works for both private key and OWS.
  // rawKey is non-null only for private-key wallets (needed for x402 direct / EIP-3009).
  #signTypedData: SignTypedDataFn;
  #rawKey: Hex | null;
  #apiUrl: string;
  #basePath: string;
  #testnet: boolean;
  #timeout: number;
  #contracts: Contracts | null = null;

  /**
   * Sync constructor. Resolves key from: privateKey arg -> PAYSKILL_KEY env -> error.
   * For OS keychain, use `await Wallet.create()`.
   * For OWS, use `await Wallet.fromOws({ walletId })`.
   */
  constructor(options?: WalletOptions) {
    // Check for internal OWS init (symbol key hidden from public API)
    const raw = options as Record<symbol, unknown> | undefined;
    if (raw && raw[_OWS_INIT]) {
      const init = raw as unknown as {
        [_OWS_INIT]: true;
        _address: string;
        _signTypedData: SignTypedDataFn;
        _testnet: boolean;
        _timeout: number;
      };
      this.address = init._address;
      this.#signTypedData = init._signTypedData;
      this.#rawKey = null;
      this.#testnet = init._testnet;
      this.#timeout = init._timeout;
      this.#apiUrl = resolveApiUrl(this.#testnet);
      try {
        this.#basePath = new URL(this.#apiUrl).pathname.replace(
          /\/+$/,
          "",
        );
      } catch {
        this.#basePath = "";
      }
      return;
    }

    const key = options?.privateKey ?? process.env.PAYSKILL_KEY;
    if (!key) {
      throw new PayError(
        "No private key found. Provide { privateKey }, set PAYSKILL_KEY env var, " +
          "or use Wallet.create() to read from OS keychain.",
      );
    }
    this.#rawKey = normalizeKey(key);
    const account = privateKeyToAccount(this.#rawKey);
    this.address = account.address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.#signTypedData = (p) => account.signTypedData(p as any);
    this.#testnet = options?.testnet ?? !!process.env.PAYSKILL_TESTNET;
    this.#timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.#apiUrl = resolveApiUrl(this.#testnet);
    try {
      this.#basePath = new URL(this.#apiUrl).pathname.replace(/\/+$/, "");
    } catch {
      this.#basePath = "";
    }
  }

  /** Async factory. Resolves key from: privateKey arg -> OS keychain -> PAYSKILL_KEY env -> error. */
  static async create(options?: WalletOptions): Promise<Wallet> {
    if (options?.privateKey) return new Wallet(options);
    const keychainKey = await readFromKeychain();
    if (keychainKey) {
      return new Wallet({ ...options, privateKey: keychainKey });
    }
    return new Wallet(options);
  }

  /** Sync factory. Reads key from PAYSKILL_KEY env var only. */
  static fromEnv(options?: { testnet?: boolean }): Wallet {
    const key = process.env.PAYSKILL_KEY;
    if (!key) throw new PayError("PAYSKILL_KEY env var not set");
    return new Wallet({ privateKey: key, testnet: options?.testnet });
  }

  /** Async factory. Creates a wallet backed by an OWS (Open Wallet Standard) wallet. */
  static async fromOws(options: OwsWalletOptions): Promise<Wallet> {
    let owsModule: OwsModule;
    if (options._owsModule) {
      owsModule = options._owsModule as OwsModule;
    } else {
      try {
        const moduleName = "@open-wallet-standard/core";
        owsModule = (await import(moduleName)) as unknown as OwsModule;
      } catch {
        throw new PayError(
          "@open-wallet-standard/core is not installed. " +
            "Install it with: npm install @open-wallet-standard/core",
        );
      }
    }

    let walletInfo;
    try {
      walletInfo = owsModule.getWallet(options.walletId);
    } catch (e) {
      throw new PayError(
        `Failed to get OWS wallet '${options.walletId}': ${e instanceof Error ? e.message : e}`,
      );
    }
    const evmAccount = walletInfo.accounts.find(
      (a) => a.chainId === "evm" || a.chainId.startsWith("eip155:"),
    );
    if (!evmAccount) {
      throw new PayError(
        `No EVM account found in OWS wallet '${options.walletId}'. ` +
          `Available chains: ${walletInfo.accounts.map((a) => a.chainId).join(", ") || "none"}.`,
      );
    }

    const signFn = createOwsSignTypedData(
      owsModule,
      options.walletId,
      options.owsApiKey,
    );

    // Use the internal init path through the constructor
    return new Wallet({
      [_OWS_INIT]: true,
      _address: evmAccount.address,
      _signTypedData: signFn,
      _testnet: options.testnet ?? !!process.env.PAYSKILL_TESTNET,
      _timeout: options.timeout ?? DEFAULT_TIMEOUT,
    } as unknown as WalletOptions);
  }

  // ── Internal: contracts ──────────────────────────────────────────

  private async ensureContracts(): Promise<Contracts> {
    if (this.#contracts) return this.#contracts;
    let resp: Response;
    try {
      resp = await fetch(`${this.#apiUrl}/contracts`, {
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (e) {
      throw new PayNetworkError(`Failed to reach server: ${e}`);
    }
    if (!resp.ok) {
      throw new PayNetworkError(
        `Failed to fetch contracts: ${resp.status}`,
      );
    }
    const data = (await resp.json()) as Record<string, unknown>;
    this.#contracts = {
      router: String(data.router ?? "") as Address,
      tab: String(data.tab ?? "") as Address,
      direct: String(data.direct ?? "") as Address,
      fee: String(data.fee ?? "") as Address,
      usdc: String(data.usdc ?? "") as Address,
      chainId: Number(data.chain_id ?? 0),
      relayer: String(data.relayer ?? "") as Address,
    };
    return this.#contracts;
  }

  // ── Internal: HTTP ───────────────────────────────────────────────

  private async authFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const contracts = await this.ensureContracts();
    const method = (init.method ?? "GET").toUpperCase();
    const pathOnly = path.split("?")[0];
    const signPath = this.#basePath + pathOnly;
    const config = {
      chainId: contracts.chainId,
      routerAddress: contracts.router,
    };

    const headers = this.#rawKey
      ? await buildAuthHeaders(this.#rawKey, method, signPath, config)
      : await buildAuthHeadersSigned(
          this.address,
          this.#signTypedData,
          method,
          signPath,
          config,
        );

    return fetch(`${this.#apiUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(this.#timeout),
      headers: {
        "Content-Type": "application/json",
        ...headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  private async get<T>(path: string): Promise<T> {
    let resp: Response;
    try {
      resp = await this.authFetch(path);
    } catch (e) {
      if (e instanceof PayError) throw e;
      throw new PayNetworkError(String(e));
    }
    return this.handleResponse<T>(resp);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let resp: Response;
    try {
      resp = await this.authFetch(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e instanceof PayError) throw e;
      throw new PayNetworkError(String(e));
    }
    return this.handleResponse<T>(resp);
  }

  private async del(path: string): Promise<void> {
    let resp: Response;
    try {
      resp = await this.authFetch(path, { method: "DELETE" });
    } catch (e) {
      if (e instanceof PayError) throw e;
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
        const body = (await resp.json()) as {
          error?: string;
          code?: string;
        };
        msg = body.error ?? `Server error: ${resp.status}`;
        if (
          body.code === "insufficient_funds" ||
          msg.toLowerCase().includes("insufficient")
        ) {
          throw new PayInsufficientFundsError(msg);
        }
      } catch (e) {
        if (e instanceof PayInsufficientFundsError) throw e;
        msg = `Server error: ${resp.status}`;
      }
      throw new PayServerError(msg, resp.status);
    }
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
  }

  // ── Internal: permits ────────────────────────────────────────────

  private async signPermit(
    flow: "direct" | "tab" | "withdraw",
    microAmount: number,
  ): Promise<Permit> {
    const contracts = await this.ensureContracts();
    const spender =
      flow === "tab"
        ? contracts.tab
        : flow === "withdraw"
          ? contracts.relayer
          : contracts.direct;
    const prep = await this.post<{
      hash: string;
      nonce: string;
      deadline: number;
    }>("/permit/prepare", { amount: microAmount, spender });

    if (this.#rawKey) {
      // Private key path: sign the pre-computed hash directly
      const account = privateKeyToAccount(this.#rawKey);
      const signature = await account.sign({
        hash: prep.hash as `0x${string}`,
      });
      return { nonce: prep.nonce, deadline: prep.deadline, ...parseSig(signature) };
    }

    // OWS path: sign full EIP-2612 permit typed data
    const signature = await this.#signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: contracts.chainId,
        verifyingContract: contracts.usdc as string,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: this.address,
        spender: spender as string,
        value: BigInt(microAmount),
        nonce: BigInt(prep.nonce),
        deadline: BigInt(prep.deadline),
      },
    });
    return { nonce: prep.nonce, deadline: prep.deadline, ...parseSig(signature) };
  }

  // ── Internal: x402 ───────────────────────────────────────────────

  private async parse402(resp: Response): Promise<{
    settlement: string;
    amount: number;
    to: string;
    accepted?: Record<string, unknown>;
  }> {
    const prHeader = resp.headers.get("payment-required");
    if (prHeader) {
      try {
        const decoded = JSON.parse(atob(prHeader)) as Record<
          string,
          unknown
        >;
        return extract402(decoded);
      } catch {
        /* fall through to body */
      }
    }
    const body = (await resp.json()) as Record<string, unknown>;
    return extract402(
      (body.requirements ?? body) as Record<string, unknown>,
    );
  }

  private async handle402(
    resp: Response,
    url: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
  ): Promise<Response> {
    const reqs = await this.parse402(resp);
    if (reqs.settlement === "tab") {
      return this.settleViaTab(url, method, body, headers, reqs);
    }
    return this.settleViaDirect(url, method, body, headers, reqs);
  }

  private async settleViaDirect(
    url: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
    reqs: {
      amount: number;
      to: string;
      accepted?: Record<string, unknown>;
    },
  ): Promise<Response> {
    if (!this.#rawKey) {
      throw new PayError(
        "x402 direct settlement requires a private key. " +
          "OWS wallets only support tab settlement. " +
          "Ask the provider to enable tab settlement, or use a private key wallet.",
      );
    }
    const contracts = await this.ensureContracts();
    const auth = await signTransferAuthorization(
      this.#rawKey,
      reqs.to as Address,
      reqs.amount,
      contracts.chainId,
      contracts.usdc,
    );
    const paymentPayload = {
      x402Version: 2,
      accepted: reqs.accepted ?? {
        scheme: "exact",
        network: `eip155:${contracts.chainId}`,
        amount: String(reqs.amount),
        payTo: reqs.to,
      },
      payload: {
        signature: combinedSignature(auth),
        authorization: {
          from: auth.from,
          to: auth.to,
          value: String(reqs.amount),
          validAfter: "0",
          validBefore: "0",
          nonce: auth.nonce,
        },
      },
      extensions: {},
    };
    return fetch(url, {
      method,
      body,
      signal: AbortSignal.timeout(this.#timeout),
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": btoa(JSON.stringify(paymentPayload)),
      },
    });
  }

  private async settleViaTab(
    url: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
    reqs: {
      amount: number;
      to: string;
      accepted?: Record<string, unknown>;
    },
  ): Promise<Response> {
    const contracts = await this.ensureContracts();
    const rawTabs = await this.get<RawTab[]>("/tabs");
    let tab = rawTabs.find(
      (t) => t.provider === reqs.to && t.status === "open",
    );

    if (!tab) {
      const tabMicro = Math.max(
        reqs.amount * TAB_MULTIPLIER,
        TAB_MIN_MICRO,
      );
      const bal = await this.balance();
      const tabDollars = toDollars(tabMicro);
      if (bal.available < tabDollars) {
        throw new PayInsufficientFundsError(
          `Insufficient balance for tab: have $${bal.available.toFixed(2)}, need $${tabDollars.toFixed(2)}`,
          bal.available,
          tabDollars,
        );
      }
      const permit = await this.signPermit("tab", tabMicro);
      tab = await this.post<RawTab>("/tabs", {
        provider: reqs.to,
        amount: tabMicro,
        max_charge_per_call: reqs.amount,
        permit,
      });
    }

    const charge = await this.post<{ charge_id?: string }>(
      `/tabs/${tab.tab_id}/charge`,
      { amount: reqs.amount },
    );

    const paymentPayload = {
      x402Version: 2,
      accepted: reqs.accepted ?? {
        scheme: "exact",
        network: `eip155:${contracts.chainId}`,
        amount: String(reqs.amount),
        payTo: reqs.to,
      },
      payload: {
        authorization: { from: this.address },
      },
      extensions: {
        pay: {
          settlement: "tab",
          tabId: tab.tab_id,
          chargeId: charge.charge_id ?? "",
        },
      },
    };
    return fetch(url, {
      method,
      body,
      signal: AbortSignal.timeout(this.#timeout),
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": btoa(JSON.stringify(paymentPayload)),
      },
    });
  }

  // ── Public: Direct Payment ───────────────────────────────────────

  async send(
    to: string,
    amount: Amount,
    memo?: string,
  ): Promise<SendResult> {
    validateAddress(to);
    const micro = toMicro(amount);
    if (micro < DIRECT_MIN_MICRO) {
      throw new PayValidationError(
        "Amount below minimum ($1.00)",
        "amount",
      );
    }
    const permit = await this.signPermit("direct", micro);
    const raw = await this.post<{
      tx_hash: string;
      status: string;
      amount: number;
      fee: number;
    }>("/direct", {
      to,
      amount: micro,
      memo: memo ?? "",
      permit,
    });
    return {
      txHash: raw.tx_hash,
      status: raw.status,
      amount: toDollars(raw.amount),
      fee: toDollars(raw.fee),
    };
  }

  // ── Public: Tabs ─────────────────────────────────────────────────

  async openTab(
    provider: string,
    amount: Amount,
    maxChargePerCall: Amount,
  ): Promise<Tab> {
    validateAddress(provider);
    const microAmount = toMicro(amount);
    const microMax = toMicro(maxChargePerCall);
    if (microAmount < TAB_MIN_MICRO) {
      throw new PayValidationError(
        "Tab amount below minimum ($5.00)",
        "amount",
      );
    }
    if (microMax <= 0) {
      throw new PayValidationError(
        "maxChargePerCall must be positive",
        "maxChargePerCall",
      );
    }
    const permit = await this.signPermit("tab", microAmount);
    const raw = await this.post<RawTab>("/tabs", {
      provider,
      amount: microAmount,
      max_charge_per_call: microMax,
      permit,
    });
    return parseTab(raw);
  }

  async closeTab(tabId: string): Promise<Tab> {
    const raw = await this.post<RawTab>(`/tabs/${tabId}/close`, {});
    return parseTab(raw);
  }

  async topUpTab(tabId: string, amount: Amount): Promise<Tab> {
    const micro = toMicro(amount);
    if (micro <= 0) {
      throw new PayValidationError(
        "Amount must be positive",
        "amount",
      );
    }
    const permit = await this.signPermit("tab", micro);
    const raw = await this.post<RawTab>(`/tabs/${tabId}/topup`, {
      amount: micro,
      permit,
    });
    return parseTab(raw);
  }

  async listTabs(): Promise<Tab[]> {
    const raw = await this.get<RawTab[]>("/tabs");
    return raw.map(parseTab);
  }

  async getTab(tabId: string): Promise<Tab> {
    const raw = await this.get<RawTab>(`/tabs/${tabId}`);
    return parseTab(raw);
  }

  async chargeTab(tabId: string, amount: Amount): Promise<ChargeResult> {
    const micro = toMicro(amount);
    const raw = await this.post<{ charge_id?: string; status: string }>(
      `/tabs/${tabId}/charge`,
      { amount: micro },
    );
    return { chargeId: raw.charge_id ?? "", status: raw.status };
  }

  // ── Public: x402 ─────────────────────────────────────────────────

  /**
   * Make an HTTP request. If the server returns 402, automatically
   * settles via x402 (direct or tab) and retries.
   *
   * @example
   * ```ts
   * const resp = await wallet.request("https://api.example.com/data");
   * const data = await resp.json();
   * ```
   */
  async request(
    url: string,
    options?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const method = options?.method ?? "GET";
    const headers = options?.headers ?? {};
    const bodyStr = options?.body
      ? JSON.stringify(options.body)
      : undefined;
    const resp = await fetch(url, {
      method,
      body: bodyStr,
      headers,
      signal: AbortSignal.timeout(this.#timeout),
    });
    if (resp.status !== 402) return resp;
    return this.handle402(resp, url, method, bodyStr, headers);
  }

  /**
   * Settle a 402 Payment Required response that you already have.
   * Used by `createPayFetch()` to avoid double-fetching. Most users
   * should use `request()` or `createPayFetch()` instead.
   *
   * @param resp - A Response with status 402
   * @param url - The original request URL
   * @param init - The original request init (method, body, headers)
   * @returns The retried response after payment, plus settlement metadata
   */
  async settle(
    resp: Response,
    url: string,
    init?: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    },
  ): Promise<{ response: Response; amount: number; settlement: string }> {
    // Clone so parse402 in both paths can read the body independently
    const metaClone = resp.clone();
    const reqs = await this.parse402(metaClone);
    const method = init?.method ?? "GET";
    const headers = init?.headers ?? {};
    const body = init?.body;
    const response = await this.handle402(resp, url, method, body, headers);
    return {
      response,
      amount: reqs.amount,
      settlement: reqs.settlement,
    };
  }

  // ── Public: Wallet ───────────────────────────────────────────────

  async balance(): Promise<Balance> {
    const raw = await this.get<{
      balance_usdc: string | null;
      total_locked: number;
    }>("/status");
    const total = raw.balance_usdc
      ? Number(raw.balance_usdc) / 1_000_000
      : 0;
    const locked = (raw.total_locked ?? 0) / 1_000_000;
    return { total, locked, available: total - locked };
  }

  async status(): Promise<Status> {
    const raw = await this.get<{
      wallet: string;
      balance_usdc: string | null;
      total_locked: number;
      open_tabs: number;
    }>("/status");
    const total = raw.balance_usdc
      ? Number(raw.balance_usdc) / 1_000_000
      : 0;
    const locked = (raw.total_locked ?? 0) / 1_000_000;
    return {
      address: raw.wallet,
      balance: { total, locked, available: total - locked },
      openTabs: raw.open_tabs,
    };
  }

  // ── Public: Discovery ────────────────────────────────────────────

  async discover(
    query?: string,
    options?: DiscoverOptions,
  ): Promise<DiscoverService[]> {
    return discoverImpl(this.#apiUrl, this.#timeout, query, options);
  }

  // ── Public: Funding ──────────────────────────────────────────────

  private async ensureWithdrawApproved(): Promise<void> {
    const maxValue = Number.MAX_SAFE_INTEGER;
    const permit = await this.signPermit("withdraw", maxValue);
    await this.post("/relayer-approval", {
      value: maxValue,
      deadline: permit.deadline,
      v: permit.v,
      r: permit.r,
      s: permit.s,
    });
  }

  async createFundLink(options?: FundLinkOptions): Promise<string> {
    await this.ensureWithdrawApproved();
    const data = await this.post<{ url: string }>("/links/fund", {
      messages: options?.message ? [{ text: options.message }] : [],
      agent_name: options?.agentName,
    });
    return data.url;
  }

  async createWithdrawLink(options?: FundLinkOptions): Promise<string> {
    await this.ensureWithdrawApproved();
    const data = await this.post<{ url: string }>("/links/withdraw", {
      messages: options?.message ? [{ text: options.message }] : [],
      agent_name: options?.agentName,
    });
    return data.url;
  }

  // ── Public: Webhooks ─────────────────────────────────────────────

  async registerWebhook(
    url: string,
    events?: string[],
    secret?: string,
  ): Promise<WebhookRegistration> {
    const payload: Record<string, unknown> = { url };
    if (events) payload.events = events;
    if (secret) payload.secret = secret;
    const raw = await this.post<{
      id: string;
      url: string;
      events: string[];
    }>("/webhooks", payload);
    return { id: raw.id, url: raw.url, events: raw.events };
  }

  async listWebhooks(): Promise<WebhookRegistration[]> {
    const raw = await this.get<
      { id: string; url: string; events: string[] }[]
    >("/webhooks");
    return raw.map((w) => ({ id: w.id, url: w.url, events: w.events }));
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.del(`/webhooks/${webhookId}`);
  }

  // ── Public: Testnet ──────────────────────────────────────────────

  async mint(amount: Amount): Promise<MintResult> {
    if (!this.#testnet) {
      throw new PayError("mint is only available on testnet");
    }
    const micro = toMicro(amount);
    const raw = await this.post<{ tx_hash: string; amount: number }>(
      "/mint",
      { amount: micro },
    );
    return { txHash: raw.tx_hash, amount: toDollars(raw.amount) };
  }
}

// ── x402 helpers ─────────────────────────────────────────────────────

function extract402(obj: Record<string, unknown>): {
  settlement: string;
  amount: number;
  to: string;
  accepted?: Record<string, unknown>;
} {
  const accepts = obj.accepts as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(accepts) && accepts.length > 0) {
    const offer = accepts[0];
    const extra = (offer.extra ?? {}) as Record<string, unknown>;
    return {
      settlement: String(extra.settlement ?? "direct"),
      amount: Number(offer.amount ?? 0),
      to: String(offer.payTo ?? ""),
      accepted: offer,
    };
  }
  return {
    settlement: String(obj.settlement ?? "direct"),
    amount: Number(obj.amount ?? 0),
    to: String(obj.to ?? ""),
  };
}
