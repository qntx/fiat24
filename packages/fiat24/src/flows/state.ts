import { getAddress, isAddress, isAddressEqual } from "viem";
import type { Hash } from "viem";
import * as z from "zod/mini";

import { mintAccountCall, mintAccountWithEthCall } from "../calls/account.ts";
import { approveCall } from "../calls/approve.ts";
import { exchangeCall } from "../calls/exchange.ts";
import { payoutCall, payoutRefCall } from "../calls/payout.ts";
import { topUpCall } from "../calls/topup.ts";
import { transferCall, transferToAccountCall } from "../calls/transfer.ts";
import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error, fiat24ErrorCodes } from "../core/errors.ts";
import type { Fiat24ErrorCode } from "../core/errors.ts";
import { freeze } from "../core/freeze.ts";
import type {
  TxPhase,
  CardState,
  ExchangeState,
  FlowState,
  OnboardingState,
  PayoutState,
  TopUpState,
  TransferState,
  TxRecord,
} from "./types.ts";

export function invalidState(): never {
  throw new Fiat24Error("invalid-state", "invalid flow state");
}

export function invalidArgument(): never {
  throw new Fiat24Error("invalid-argument", "invalid argument");
}

// §10.2 encoding: bigint fields persist as canonical decimal strings; the
// in-memory form checkedState validates against the same schema is a bigint.
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const HASH = /^0x[0-9a-f]{64}$/;
const MAX_STATE_LENGTH = 65_536;

const bigintField = z.union([
  z.pipe(
    z.string().check(z.regex(DECIMAL)), // oxlint-disable-next-line unicorn/prefer-native-coercion-functions -- the zod pipe needs the (text) => bigint call signature
    z.transform((text) => BigInt(text)),
  ),
  z.bigint(),
]);

const addressField = z.pipe(
  z.string().check(z.refine((text): boolean => isAddress(text, { strict: false }))),
  z.transform((text) => getAddress(text)),
);

const hashField = z.custom<Hash>((value) => typeof value === "string" && HASH.test(value));
const nonceField = z.int().check(z.gte(0));
const currencyField = z.enum(["USD24", "EUR24", "CHF24", "CNH24"]);
const payoutCurrencyField = z.enum(["EUR24", "CHF24"]);
const cardCurrencyField = z.enum(["EUR", "USD", "CHF", "CNH"]);
const phaseField = z.enum([
  "ready",
  "sending",
  "submitted",
  "confirmed",
  "failed",
  "unknown",
  "not-sent",
]);
const errorField = z.enum(fiat24ErrorCodes);
const mismatchField = z.enum(["from", "nonce", "to", "input", "value"]);
const text64 = z.string().check(z.maxLength(64));
const textId = z.string().check(z.minLength(1)).check(z.maxLength(1024));

const txRecordSchema = z.strictObject({
  purpose: z.enum(["approve", "main"]),
  phase: phaseField,
  fromBlock: z.optional(bigintField),
  nonce: z.optional(nonceField),
  hash: z.optional(hashField),
  mismatch: z.optional(mismatchField),
  error: z.optional(errorField),
});

const common = {
  version: z.literal(1),
  owner: addressField,
  txs: z.array(txRecordSchema).check(z.maxLength(2)),
};

const recipientField = z.union([
  z.strictObject({ address: addressField }),
  z.strictObject({ tokenId: bigintField }),
]);

const transferSchema = z.strictObject({
  flow: z.literal("transfer"),
  ...common,
  step: z.enum(["draft", "ready", "tx", "confirmed", "failed", "not-sent"]),
  currency: currencyField,
  amount: bigintField,
  to: recipientField,
});

const quoteFields = {
  input: bigintField,
  output: bigintField,
  rate: bigintField,
  spread: bigintField,
  blockNumber: bigintField,
};

const exchangeSchema = z.strictObject({
  flow: z.literal("exchange"),
  ...common,
  step: z.enum(["draft", "quoted", "tx", "confirmed", "failed", "not-sent"]),
  side: z.enum(["exact-in", "exact-out"]),
  from: currencyField,
  to: currencyField,
  amount: bigintField,
  quote: z.optional(z.strictObject(quoteFields)),
  actual: z.optional(z.strictObject({ input: bigintField, output: bigintField })),
});

const payoutSchema = z.strictObject({
  flow: z.literal("payout"),
  ...common,
  step: z.enum(["verified", "tx", "confirmed", "failed", "not-sent"]),
  tokenId: bigintField,
  currency: payoutCurrencyField,
  amount: bigintField,
  contactId: text64,
  purposeId: z.optional(bigintField),
  ref: z.optional(text64),
});

const cardOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("set-cap"), currency: currencyField, amount: bigintField }),
  z.strictObject({ kind: z.literal("create") }),
  z.strictObject({ kind: z.enum(["block", "unblock"]), externalId: textId }),
  z.strictObject({
    kind: z.literal("set-currency"),
    externalId: textId,
    currency: cardCurrencyField,
  }),
  z.strictObject({
    kind: z.literal("device-token"),
    externalId: textId,
    cardTokenId: textId,
    status: z.enum(["activate", "deactivate"]),
  }),
]);

const cardSchema = z.strictObject({
  flow: z.literal("card"),
  ...common,
  step: z.enum(["ready", "tx", "confirmed", "failed", "not-sent"]),
  tokenId: bigintField,
  operation: cardOperationSchema,
  cap: z.optional(z.strictObject({ currency: currencyField, amount: bigintField })),
});

const kycField = z.enum([
  "not-started",
  "pending-scan",
  "processing",
  "action-required",
  "manual-review",
  "completed",
  "rejected",
  "error",
  "unknown",
]);

const onboardingSchema = z.strictObject({
  flow: z.literal("onboarding"),
  ...common,
  step: z.enum([
    "check",
    "ready",
    "tx",
    "tourist",
    "kyc",
    "live",
    "rejected",
    "failed",
    "not-sent",
  ]),
  tokenId: bigintField,
  payment: z.enum(["f24", "eth"]),
  quote: z.optional(z.strictObject({ input: bigintField, blockNumber: bigintField })),
  kyc: z.optional(kycField),
});

const reasonField = z.enum([
  "account-paused",
  "token-paused",
  "deposit-paused",
  "card-paused",
  "f24-sales-paused",
  "f24-sales-empty",
  "f24-inactive",
  "mint-digits",
]);

const topupSchema = z.strictObject({
  flow: z.literal("top-up"),
  ...common,
  step: z.enum(["check", "quoted", "tx", "confirmed", "unavailable", "failed", "not-sent"]),
  output: currencyField,
  usdcAmount: bigintField,
  quote: z.optional(
    z.strictObject({ input: bigintField, output: bigintField, blockNumber: bigintField }),
  ),
  reason: z.optional(reasonField),
  actual: z.optional(z.strictObject({ input: bigintField, output: bigintField })),
});

const flowStateSchema = z.discriminatedUnion("flow", [
  transferSchema,
  exchangeSchema,
  payoutSchema,
  cardSchema,
  onboardingSchema,
  topupSchema,
]);

type Parsed = z.output<typeof flowStateSchema>;
type ParsedRecord = z.output<typeof txRecordSchema>;
type ParsedTransfer = Extract<Parsed, { readonly flow: "transfer" }>;
type ParsedExchange = Extract<Parsed, { readonly flow: "exchange" }>;
type ParsedPayout = Extract<Parsed, { readonly flow: "payout" }>;
type ParsedCard = Extract<Parsed, { readonly flow: "card" }>;
type ParsedOnboarding = Extract<Parsed, { readonly flow: "onboarding" }>;
type ParsedTopUp = Extract<Parsed, { readonly flow: "top-up" }>;

// §4 decode validation — the per-phase field table for chain transactions
// (R = required, – = forbidden, optional may appear).
const ACTIVE_PHASES: ReadonlySet<TxPhase> = new Set(["ready", "sending", "submitted", "unknown"]);

// §6 card API-write table: the `ready` error set a declined write may carry
// (the write was not executed; retry is a new user action). card.ts shares it —
// a write error with any other code is classified ambiguous instead.
export const API_READY_ERRORS: ReadonlyArray<Fiat24ErrorCode> = /* @__PURE__ */ freeze([
  "unauthorized",
  "rate-limited",
  "http-error",
  "session-required",
  "signer-rejected",
  "network-error",
  "invalid-response",
]);

function chainRecord(record: ParsedRecord): void {
  const { fromBlock, nonce, hash, mismatch, error } = record;
  const none = fromBlock === undefined && nonce === undefined && hash === undefined;
  switch (record.phase) {
    case "ready":
      if (!none || mismatch !== undefined) {
        invalidState();
      }
      if (error !== undefined && error !== "signer-rejected") {
        invalidState();
      }
      return;
    case "sending":
      if (
        fromBlock === undefined ||
        nonce === undefined ||
        hash !== undefined ||
        mismatch !== undefined ||
        error !== undefined
      ) {
        invalidState();
      }
      return;
    case "submitted":
      if (
        fromBlock === undefined ||
        nonce === undefined ||
        hash === undefined ||
        mismatch !== undefined ||
        error !== undefined
      ) {
        invalidState();
      }
      return;
    case "unknown":
      if (fromBlock === undefined || nonce === undefined) {
        invalidState();
      }
      // `mismatch` describes the mined transaction under `hash` — legal only while both
      // the hash and the unknown-outcome marker are present.
      if (error !== "unknown-outcome" || (mismatch !== undefined && hash === undefined)) {
        invalidState();
      }
      return;
    case "confirmed":
      if (
        fromBlock === undefined ||
        nonce === undefined ||
        hash === undefined ||
        mismatch !== undefined ||
        error !== undefined
      ) {
        invalidState();
      }
      return;
    case "failed":
      if (
        fromBlock === undefined ||
        nonce === undefined ||
        hash === undefined ||
        mismatch !== undefined ||
        error !== "tx-reverted"
      ) {
        invalidState();
      }
      return;
    case "not-sent":
      if (fromBlock === undefined || nonce === undefined || mismatch !== undefined) {
        invalidState();
      }
      if (error !== undefined) {
        invalidState();
      }
  }
}

function apiRecord(record: ParsedRecord): void {
  const { fromBlock, nonce, hash, mismatch, error } = record;
  if (
    fromBlock !== undefined ||
    nonce !== undefined ||
    hash !== undefined ||
    mismatch !== undefined
  ) {
    invalidState();
  }
  switch (record.phase) {
    case "ready":
      if (error !== undefined && !API_READY_ERRORS.includes(error)) {
        invalidState();
      }
      return;
    case "sending":
    case "confirmed":
      if (error !== undefined) {
        invalidState();
      }
      return;
    case "unknown":
      if (error !== "unknown-outcome") {
        invalidState();
      }
      return;
    case "failed":
      if (error !== "api-rejected") {
        invalidState();
      }
      return;
    default:
      // submitted / not-sent have no meaning for an API write record.
      invalidState();
  }
}

/**
 * Txs shape: purposes in order (optional `approve`, then `main`); every record but the last is
 * `confirmed`; each record satisfies its phase table — the card flow's `main` record is an API
 * write, everything else is a chain tx.
 */
function checkTxsShape(state: Parsed): void {
  const { txs } = state;
  const cardMain = state.flow === "card";
  for (const [index, record] of txs.entries()) {
    if (index < txs.length - 1 && record.phase !== "confirmed") {
      invalidState();
    }
    if (cardMain && record.purpose === "main") {
      apiRecord(record);
    } else {
      chainRecord(record);
    }
  }
  if (txs.length === 2) {
    const [first, second] = txs;
    if (
      first === undefined ||
      second === undefined ||
      first.purpose !== "approve" ||
      second.purpose !== "main"
    ) {
      invalidState();
    }
  }
}

function lastOf(txs: ReadonlyArray<ParsedRecord>): ParsedRecord | undefined {
  return txs.at(-1);
}

function requireEmptyTxs(txs: ReadonlyArray<ParsedRecord>): void {
  if (txs.length > 0) {
    invalidState();
  }
}

// step "tx": a record is active — phases ready/sending/submitted/unknown (§10.1, D1).
function requireActiveLast(txs: ReadonlyArray<ParsedRecord>): void {
  const last = lastOf(txs);
  if (last === undefined || !ACTIVE_PHASES.has(last.phase)) {
    invalidState();
  }
}

function requireTerminalMain(
  txs: ReadonlyArray<ParsedRecord>,
  phase: "confirmed" | "failed" | "not-sent",
): void {
  const last = lastOf(txs);
  if (last === undefined || last.purpose !== "main" || last.phase !== phase) {
    invalidState();
  }
}

// failed / not-sent can end on an `approve` too — the approve is itself a sendable tx
// (exchange, top-up, onboarding, card set-cap).
function requireTerminalLast(txs: ReadonlyArray<ParsedRecord>, phase: "failed" | "not-sent"): void {
  const last = lastOf(txs);
  if (last === undefined || last.phase !== phase) {
    invalidState();
  }
}

function forbidApprove(txs: ReadonlyArray<ParsedRecord>): void {
  if (txs.some((record) => record.purpose === "approve")) {
    invalidState();
  }
}

// Builder validation of in-memory/persisted intent fields (I20): any builder
// refusal means the stored state is corrupt — always invalid-state, never the
// builder's own code.
function rebuild(build: () => unknown): void {
  try {
    build();
  } catch {
    invalidState();
  }
}

function normRecord(record: ParsedRecord): TxRecord {
  return {
    purpose: record.purpose,
    phase: record.phase,
    ...(record.fromBlock === undefined ? {} : { fromBlock: record.fromBlock }),
    ...(record.nonce === undefined ? {} : { nonce: record.nonce }),
    ...(record.hash === undefined ? {} : { hash: record.hash }),
    ...(record.mismatch === undefined ? {} : { mismatch: record.mismatch }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function normTxs(txs: ReadonlyArray<ParsedRecord>): ReadonlyArray<TxRecord> {
  return txs.map(normRecord);
}

function transferSemantics(state: ParsedTransfer): TransferState {
  const { to } = state;
  if ("address" in to) {
    if (isAddressEqual(to.address, state.owner)) {
      invalidState();
    }
    rebuild(() => transferCall({ currency: state.currency, to: to.address, amount: state.amount }));
  } else {
    rebuild(() =>
      transferToAccountCall({
        currency: state.currency,
        tokenId: to.tokenId,
        amount: state.amount,
      }),
    );
  }
  forbidApprove(state.txs);
  switch (state.step) {
    case "draft":
    case "ready":
      requireEmptyTxs(state.txs);
      break;
    case "tx":
      requireActiveLast(state.txs);
      break;
    case "confirmed":
      requireTerminalMain(state.txs, "confirmed");
      break;
    default:
      requireTerminalLast(state.txs, state.step);
  }
  return {
    flow: "transfer",
    version: 1,
    owner: state.owner,
    txs: normTxs(state.txs),
    step: state.step,
    currency: state.currency,
    amount: state.amount,
    to: state.to,
  };
}

function exchangeSemantics(state: ParsedExchange): ExchangeState {
  rebuild(() =>
    exchangeCall({ side: state.side, from: state.from, to: state.to, amount: state.amount }),
  );
  // An approve record implies the approve call: exact-in approves `amount`,
  // exact-out approves the quoted input exactly (re-approves down, I16).
  if (state.txs.some((record) => record.purpose === "approve")) {
    const { quote } = state;
    rebuild(() =>
      approveCall({
        asset: state.from,
        spender: "deposit",
        amount: state.side === "exact-in" ? state.amount : (quote?.input ?? 0n),
      }),
    );
  }
  if ((state.quote === undefined) !== (state.step === "draft")) {
    invalidState();
  }
  if ((state.actual === undefined) !== (state.step !== "confirmed")) {
    invalidState();
  }
  switch (state.step) {
    case "draft":
    case "quoted":
      requireEmptyTxs(state.txs);
      break;
    case "tx":
      requireActiveLast(state.txs);
      break;
    case "confirmed":
      requireTerminalMain(state.txs, "confirmed");
      break;
    default:
      requireTerminalLast(state.txs, state.step);
  }
  return {
    flow: "exchange",
    version: 1,
    owner: state.owner,
    txs: normTxs(state.txs),
    step: state.step,
    side: state.side,
    from: state.from,
    to: state.to,
    amount: state.amount,
    ...(state.quote === undefined ? {} : { quote: state.quote }),
    ...(state.actual === undefined ? {} : { actual: state.actual }),
  };
}

function payoutSemantics(state: ParsedPayout): PayoutState {
  rebuild(() => assertTokenId(state.tokenId));
  if ((state.purposeId === undefined) !== (state.ref === undefined)) {
    invalidState();
  }
  const { ref, purposeId } = state;
  if (ref === undefined || purposeId === undefined) {
    rebuild(() =>
      payoutCall({ currency: state.currency, amount: state.amount, contactId: state.contactId }),
    );
  } else {
    rebuild(() =>
      payoutRefCall({
        currency: state.currency,
        amount: state.amount,
        contactId: state.contactId,
        purposeId,
        ref,
        tokenId: state.tokenId,
      }),
    );
  }
  forbidApprove(state.txs);
  switch (state.step) {
    case "verified":
      requireEmptyTxs(state.txs);
      break;
    case "tx":
      requireActiveLast(state.txs);
      break;
    case "confirmed":
      requireTerminalMain(state.txs, "confirmed");
      break;
    default:
      requireTerminalLast(state.txs, state.step);
  }
  return {
    flow: "payout",
    version: 1,
    owner: state.owner,
    txs: normTxs(state.txs),
    step: state.step,
    tokenId: state.tokenId,
    currency: state.currency,
    amount: state.amount,
    contactId: state.contactId,
    ...(purposeId === undefined ? {} : { purposeId }),
    ...(ref === undefined ? {} : { ref }),
  };
}

function cardSemantics(state: ParsedCard): CardState {
  rebuild(() => assertTokenId(state.tokenId));
  const { operation, cap } = state;
  // `cap` is setup-only: the approve-to-cap that precedes `create` (§10.7).
  if (cap !== undefined) {
    if (operation.kind !== "create" || cap.amount < 1n) {
      invalidState();
    }
    rebuild(() => approveCall({ asset: cap.currency, spender: "card", amount: cap.amount }));
  }
  if (operation.kind === "set-cap") {
    rebuild(() =>
      approveCall({ asset: operation.currency, spender: "card", amount: operation.amount }),
    );
  }
  // An approve chain record exists only for a cap-implying operation.
  if (
    state.txs.some((record) => record.purpose === "approve") &&
    operation.kind !== "set-cap" &&
    !(operation.kind === "create" && cap !== undefined)
  ) {
    invalidState();
  }
  // A `set-cap` is the approve itself — it can never carry an API-write record.
  if (operation.kind === "set-cap" && state.txs.some((record) => record.purpose === "main")) {
    invalidState();
  }
  switch (state.step) {
    case "ready":
      requireEmptyTxs(state.txs);
      break;
    case "tx":
      requireActiveLast(state.txs);
      break;
    case "confirmed": {
      // `set-cap`: a confirmed approve, or no tx at all when the allowance already
      // matched (§10.7); every other op ends on the confirmed API write.
      const last = lastOf(state.txs);
      if (last === undefined) {
        if (operation.kind !== "set-cap") {
          invalidState();
        }
      } else {
        const expected = operation.kind === "set-cap" ? "approve" : "main";
        if (last.phase !== "confirmed" || last.purpose !== expected) {
          invalidState();
        }
      }
      break;
    }
    default:
      requireTerminalLast(state.txs, state.step);
  }
  return {
    flow: "card",
    version: 1,
    owner: state.owner,
    txs: normTxs(state.txs),
    step: state.step,
    tokenId: state.tokenId,
    operation: state.operation,
    ...(cap === undefined ? {} : { cap }),
  };
}

function onboardingSemantics(state: ParsedOnboarding): OnboardingState {
  const { quote, payment } = state;
  rebuild(() => mintAccountCall({ tokenId: state.tokenId }));
  if (payment === "eth" && quote !== undefined) {
    rebuild(() => mintAccountWithEthCall({ tokenId: state.tokenId, value: quote.input }));
  }
  if (state.txs.some((record) => record.purpose === "approve")) {
    if (payment !== "f24" || quote === undefined) {
      invalidState();
    } else {
      rebuild(() => approveCall({ asset: "F24", spender: "account", amount: quote.input }));
    }
  }
  if ((quote === undefined) !== (state.step === "check")) {
    invalidState();
  }
  if ((state.kyc === undefined) !== (state.step !== "kyc")) {
    invalidState();
  }
  switch (state.step) {
    case "check":
    case "ready":
      requireEmptyTxs(state.txs);
      break;
    case "tx":
      requireActiveLast(state.txs);
      break;
    case "failed":
    case "not-sent":
      requireTerminalLast(state.txs, state.step);
      break;
    default:
      // tourist / kyc / live / rejected all follow a confirmed mint.
      requireTerminalMain(state.txs, "confirmed");
  }
  return {
    flow: "onboarding",
    version: 1,
    owner: state.owner,
    txs: normTxs(state.txs),
    step: state.step,
    tokenId: state.tokenId,
    payment,
    ...(quote === undefined ? {} : { quote }),
    ...(state.kyc === undefined ? {} : { kyc: state.kyc }),
  };
}

function topupSemantics(state: ParsedTopUp): TopUpState {
  rebuild(() => topUpCall({ output: state.output, usdcAmount: state.usdcAmount }));
  if (state.txs.some((record) => record.purpose === "approve")) {
    rebuild(() => approveCall({ asset: "USDC", spender: "deposit", amount: state.usdcAmount }));
  }
  const quoteExpected = state.step !== "check" && state.step !== "unavailable";
  if ((state.quote === undefined) === quoteExpected) {
    invalidState();
  }
  if ((state.reason === undefined) !== (state.step !== "unavailable")) {
    invalidState();
  }
  if ((state.actual === undefined) !== (state.step !== "confirmed")) {
    invalidState();
  }
  switch (state.step) {
    case "check":
    case "quoted":
    case "unavailable":
      requireEmptyTxs(state.txs);
      break;
    case "tx":
      requireActiveLast(state.txs);
      break;
    case "confirmed":
      requireTerminalMain(state.txs, "confirmed");
      break;
    default:
      requireTerminalLast(state.txs, state.step);
  }
  return {
    flow: "top-up",
    version: 1,
    owner: state.owner,
    txs: normTxs(state.txs),
    step: state.step,
    output: state.output,
    usdcAmount: state.usdcAmount,
    ...(state.quote === undefined ? {} : { quote: state.quote }),
    ...(state.reason === undefined ? {} : { reason: state.reason }),
    ...(state.actual === undefined ? {} : { actual: state.actual }),
  };
}

function normalize(parsed: Parsed): FlowState {
  checkTxsShape(parsed);
  switch (parsed.flow) {
    case "transfer":
      return transferSemantics(parsed);
    case "exchange":
      return exchangeSemantics(parsed);
    case "payout":
      return payoutSemantics(parsed);
    case "card":
      return cardSemantics(parsed);
    case "onboarding":
      return onboardingSemantics(parsed);
    default:
      return topupSemantics(parsed);
  }
}

/**
 * Layer-internal: validates an in-memory or decoded state against the same schema as
 * {@link decodeFlowState} plus the semantic rules (builder rebuild, txs shape, step ↔ data). Any
 * failure ⇒ `invalid-state`; `flow` narrows to one flow's state. Returns a frozen normalized copy
 * (addresses checksummed).
 */
export function checkedState(state: unknown): FlowState;
export function checkedState(state: unknown, flow: "transfer"): TransferState;
export function checkedState(state: unknown, flow: "exchange"): ExchangeState;
export function checkedState(state: unknown, flow: "payout"): PayoutState;
export function checkedState(state: unknown, flow: "card"): CardState;
export function checkedState(state: unknown, flow: "onboarding"): OnboardingState;
export function checkedState(state: unknown, flow: "top-up"): TopUpState;
export function checkedState(state: unknown, flow?: string): FlowState {
  const parsed = z.safeParse(flowStateSchema, state);
  if (!parsed.success) {
    invalidState();
  }
  const { data } = parsed;
  if (data === undefined) {
    invalidState();
  }
  if (flow !== undefined && data.flow !== flow) {
    invalidState();
  }
  return freeze(normalize(data));
}

/**
 * §10.2: the canonical persisted encoding — `checkedState` first (refuses a PayoutDraft, unknown
 * keys, bad grammar), then JSON with bigint ⇒ canonical decimal string; `nonce` stays a JSON
 * number; key order follows the schema.
 */
export function encodeFlowState(state: FlowState): string {
  const checked = checkedState(state);
  return JSON.stringify(checked, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/** §10.2: any malformed input — size, JSON, schema or semantics — is `invalid-state` (I20). */
export function decodeFlowState(text: string): FlowState {
  if (typeof text !== "string" || text.length > MAX_STATE_LENGTH) {
    invalidState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    invalidState();
  }
  return checkedState(parsed);
}
