import type { Hex } from "viem";

import { freeze } from "./freeze.ts";
import type { RevertReason } from "./revert.ts";
import type { ContractName } from "./types.ts";

// The codes are kebab-case strings (not an enum) so vector failure cases name
// them verbatim; the tuple is the closed set `Fiat24Error.code` may take.
const errorCodes = [
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
] as const;

export const fiat24ErrorCodes: typeof errorCodes = /* @__PURE__ */ freeze(errorCodes);

export type Fiat24ErrorCode = (typeof fiat24ErrorCodes)[number];

// The on-chain fact behind an `unavailable` code (pause flags, F24Sales
// emptiness, f24IsActive, maxDigitForSale); read at run time, never embedded.
export type UnavailableReason =
  | "account-paused"
  | "token-paused"
  | "deposit-paused"
  | "card-paused"
  | "f24-sales-paused"
  | "f24-sales-empty"
  | "f24-inactive"
  | "mint-digits";

// The pinned value that drifted on a `contract-changed` code (§4.1).
export type DriftField = "implementation" | "admin" | "priceList" | "f24" | "f24Sales" | "usdc";

export type Fiat24ErrorDetail = {
  readonly contract?: ContractName;
  readonly field?: DriftField;
  readonly reason?: UnavailableReason;
  readonly status?: number;
  readonly endpoint?: string;
  readonly revert?: RevertReason;
  readonly txHash?: Hex;
};

const EMPTY_DETAIL: Fiat24ErrorDetail = Object.freeze({});

/**
 * Single error type of the SDK; `code` is the closed discriminator shared with the failure cases in
 * vectors/. `message` is a fixed English template (it may interpolate a ContractName, a Currency, a
 * caller-supplied decimal id or amount, an HTTP status or an endpoint template) and never echoes
 * the raw input of a parser. No `cause` is ever attached: viem errors embed RPC URLs and calldata,
 * fetch errors embed URLs with queries.
 */
export class Fiat24Error extends Error {
  override readonly name = "Fiat24Error";
  readonly code: Fiat24ErrorCode;
  readonly detail: Fiat24ErrorDetail;

  constructor(code: Fiat24ErrorCode, message: string, detail?: Fiat24ErrorDetail) {
    super(message);
    this.code = code;
    this.detail = detail === undefined ? EMPTY_DETAIL : Object.freeze({ ...detail });
  }
}

export function isFiat24Error(value: unknown): value is Fiat24Error {
  return value instanceof Fiat24Error;
}
