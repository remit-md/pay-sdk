export {
  PayError,
  PayValidationError,
  PayNetworkError,
  PayServerError,
  PayInsufficientFundsError,
  PayBudgetExceededError,
} from "./errors.js";

export { Wallet, discover } from "./wallet.js";
export type {
  Amount,
  WalletOptions,
  OwsWalletOptions,
  SendResult,
  Tab,
  ChargeResult,
  Balance,
  Status,
  DiscoverService,
  DiscoverOptions,
  FundLinkOptions,
  WebhookRegistration,
  MintResult,
} from "./wallet.js";

export { createPayFetch, register } from "./fetch.js";
export type { PayFetchOptions, PaymentEvent } from "./fetch.js";
