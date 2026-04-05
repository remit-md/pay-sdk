export { PayClient, DEFAULT_API_URL } from "./client.js";
export type { PayClientOptions } from "./client.js";

export {
  PayError,
  PayValidationError,
  PayNetworkError,
  PayServerError,
  PayInsufficientFundsError,
} from "./errors.js";

export type {
  DirectPaymentResult,
  PaymentRequired,
  PaymentRequirementsV2,
  Tab,
  TabStatus,
  StatusResponse,
  WebhookRegistration,
} from "./models.js";

export type { Signer } from "./signer.js";
export {
  CliSigner,
  RawKeySigner,
  CallbackSigner,
  createSigner,
} from "./signer.js";

export { OwsSigner } from "./ows-signer.js";
export type { OwsSignerOptions } from "./ows-signer.js";

export { Wallet, PrivateKeySigner } from "./wallet.js";
export type {
  WalletOptions,
  FundLinkOptions,
  PermitResult,
} from "./wallet.js";

export {
  buildAuthHeaders,
  buildAuthHeadersWithSigner,
  computeEip712Hash,
} from "./auth.js";
export type { AuthConfig, AuthHeaders } from "./auth.js";
