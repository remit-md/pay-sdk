export {
  PayError,
  PayValidationError,
  PayNetworkError,
  PayServerError,
  PayInsufficientFundsError,
} from "./errors.js";

export { Wallet, discover } from "./wallet.js";
export type {
  Amount,
  WalletOptions,
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
