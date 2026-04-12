import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PayError,
  PayValidationError,
  PayNetworkError,
  PayServerError,
  PayInsufficientFundsError,
} from "../src/errors.js";

describe("error hierarchy", () => {
  it("all errors extend PayError", () => {
    assert.ok(new PayValidationError("x") instanceof PayError);
    assert.ok(new PayNetworkError("x") instanceof PayError);
    assert.ok(new PayServerError("x", 400) instanceof PayError);
    assert.ok(new PayInsufficientFundsError("x") instanceof PayError);
  });

  it("PayValidationError has field and code", () => {
    const err = new PayValidationError("bad input", "amount");
    assert.equal(err.code, "validation_error");
    assert.equal(err.field, "amount");
    assert.equal(err.message, "bad input");
  });

  it("PayServerError has statusCode", () => {
    const err = new PayServerError("not found", 404);
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, "server_error");
  });

  it("PayNetworkError has code", () => {
    const err = new PayNetworkError("connection refused");
    assert.equal(err.code, "network_error");
  });

  it("PayInsufficientFundsError includes fund link hint", () => {
    const err = new PayInsufficientFundsError("low balance", 5, 10);
    assert.ok(err.message.includes("createFundLink"));
    assert.equal(err.balance, 5);
    assert.equal(err.required, 10);
    assert.equal(err.code, "insufficient_funds");
  });
});
