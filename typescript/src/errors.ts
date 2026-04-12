/** Base error for all pay SDK errors. */
export class PayError extends Error {
  readonly code: string;

  constructor(message: string, code = "pay_error") {
    super(message);
    this.name = "PayError";
    this.code = code;
  }
}

/** Input validation failed. */
export class PayValidationError extends PayError {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, "validation_error");
    this.name = "PayValidationError";
    this.field = field;
  }
}

/** Network or server communication failed. */
export class PayNetworkError extends PayError {
  constructor(message: string) {
    super(message, "network_error");
    this.name = "PayNetworkError";
  }
}

/** Server returned an error response. */
export class PayServerError extends PayError {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message, "server_error");
    this.name = "PayServerError";
    this.statusCode = statusCode;
  }
}

/** Insufficient USDC balance. Includes fund link hint for agents. */
export class PayInsufficientFundsError extends PayError {
  readonly balance: number;
  readonly required: number;

  constructor(message: string, balance = 0, required = 0) {
    const hint =
      '\nUse wallet.createFundLink({ message: "Need funds" }) to request funding.';
    super(message + hint, "insufficient_funds");
    this.name = "PayInsufficientFundsError";
    this.balance = balance;
    this.required = required;
  }
}
