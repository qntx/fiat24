import * as fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  assertTokenId,
  Fiat24Error,
  fiat24ErrorCodes,
  ibanOf,
  isFiat24Error,
  parseAmount,
} from "../../src/core/index.ts";
import { captureError, messagesAreFixed, okOrCode } from "../helpers.ts";

const INVALID_ACCOUNT_ID = new Set(["invalid-account-id"]);

describe("Fiat24Error", () => {
  test("is an Error carrying name, code and message", () => {
    const error = new Fiat24Error("invalid-argument", "bad input");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(Fiat24Error);
    expect(error.name).toBe("Fiat24Error");
    expect(error.code).toBe("invalid-argument");
    expect(error.message).toBe("bad input");
  });

  test("never attaches a cause", () => {
    const error = new Fiat24Error("unknown-outcome", "undetermined");
    expect(error.cause).toBeUndefined();
  });

  test("detail defaults to a frozen empty object", () => {
    const error = new Fiat24Error("contract-changed", "drift");
    expect(error.detail).toStrictEqual({});
    expect(Object.isFrozen(error.detail)).toBe(true);
  });

  test("detail is a frozen copy of the passed object", () => {
    const detail = { contract: "account" as const, field: "implementation" as const };
    const error = new Fiat24Error("contract-changed", "drift", detail);
    expect(error.detail).toStrictEqual(detail);
    expect(error.detail).not.toBe(detail);
    expect(Object.isFrozen(error.detail)).toBe(true);
    expect(Object.isFrozen(detail)).toBe(false);
  });

  test("isFiat24Error discriminates", () => {
    expect(isFiat24Error(new Fiat24Error("invalid-argument", "x"))).toBe(true);
    expect(isFiat24Error(new Error("x"))).toBe(false);
    expect(isFiat24Error({ name: "Fiat24Error", code: "invalid-argument" })).toBe(false);
    expect(isFiat24Error(undefined)).toBe(false);
    expect(isFiat24Error("invalid-argument")).toBe(false);
  });

  test("fiat24ErrorCodes is exactly the closed code tuple", () => {
    expect(fiat24ErrorCodes).toStrictEqual([
      "invalid-amount",
      "too-many-decimals",
      "amount-out-of-range",
      "invalid-account-id",
      "invalid-address",
      "invalid-argument",
      "internal-account",
      "unlimited-approval",
      "unsupported-currency",
      "unsupported-chain",
      "no-account",
      "not-live",
      "recipient-not-live",
      "stale-recipient",
      "address-ineligible",
      "account-id-taken",
      "insufficient-balance",
      "insufficient-allowance",
      "limit-exceeded",
      "transfer-not-allowed",
      "below-minimum",
      "above-maximum",
      "unavailable",
      "contract-changed",
      "quote-changed",
      "rpc-error",
      "invalid-rpc-response",
      "malformed-log",
      "contract-revert",
      "tx-reverted",
      "network-error",
      "unauthorized",
      "rate-limited",
      "http-error",
      "invalid-response",
      "api-rejected",
      "api-mismatch",
      "session-required",
      "signer-rejected",
      "unknown-outcome",
      "invalid-state",
    ]);
  });

  test("parser messages come from fixed templates and never echo the input", () => {
    // I7-adjacent rule: a thrown message may interpolate caller-supplied
    // decimal ids/amounts, never the unvalidated text of a parser — so any
    // two inputs that produce the same code must produce the same message.
    expect(() =>
      fc.assert(
        fc.property(fc.string(), fc.string(), (a, b) =>
          messagesAreFixed(
            captureError(() => parseAmount("EUR24", a)),
            captureError(() => parseAmount("EUR24", b)),
          ),
        ),
      ),
    ).not.toThrow();
  });

  test("id parsers only throw Fiat24Error with invalid-account-id", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.bigInt(), (tokenId) =>
          [ibanOf, assertTokenId].every((parse) =>
            okOrCode(() => parse(tokenId), INVALID_ACCOUNT_ID),
          ),
        ),
      ),
    ).not.toThrow();
  });
});
