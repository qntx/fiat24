import * as fc from "fast-check";
import { getAddress } from "viem";
import type { Hash } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { decodeFlowState, encodeFlowState } from "../../src/flows/index.ts";
import type { FlowState, TransferState, TxRecord } from "../../src/flows/index.ts";
import { OWNER, RECIPIENT } from "../flows/stub.ts";
import { okOrCode } from "../helpers.ts";

const OWNER_CS = getAddress(OWNER);
const RECIPIENT_CS = getAddress(RECIPIENT);
const HASH: Hash = `0x${"ab".repeat(32)}`;
const INVALID_ONLY = new Set(["invalid-state"]);

const isState = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "flow" in value && Object.isFrozen(value);

/** Valid persisted encodings — the mutation property starts from these. */
const VALID_JSON: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  {
    flow: "transfer",
    version: 1,
    owner: OWNER_CS,
    txs: [],
    step: "draft",
    currency: "EUR24",
    amount: "100",
    to: { address: RECIPIENT_CS },
  },
  {
    flow: "transfer",
    version: 1,
    owner: OWNER_CS,
    txs: [{ purpose: "main", phase: "submitted", fromBlock: "10", nonce: 3, hash: HASH }],
    step: "tx",
    currency: "EUR24",
    amount: "100",
    to: { tokenId: "402001" },
  },
  {
    flow: "exchange",
    version: 1,
    owner: OWNER_CS,
    txs: [],
    step: "quoted",
    side: "exact-in",
    from: "EUR24",
    to: "USD24",
    amount: "100",
    quote: { input: "100", output: "105", rate: "2", spread: "1", blockNumber: "10" },
  },
  {
    flow: "exchange",
    version: 1,
    owner: OWNER_CS,
    txs: [
      {
        purpose: "approve",
        phase: "confirmed",
        fromBlock: "10",
        nonce: 3,
        hash: HASH,
        blockNumber: "11",
      },
      { purpose: "main", phase: "ready" },
    ],
    step: "tx",
    side: "exact-out",
    from: "EUR24",
    to: "USD24",
    amount: "105",
    quote: { input: "100", output: "105", rate: "2", spread: "1", blockNumber: "10" },
  },
  {
    flow: "payout",
    version: 1,
    owner: OWNER_CS,
    txs: [],
    step: "verified",
    tokenId: "350273",
    currency: "CHF24",
    amount: "100",
    contactId: "QRCH",
    purposeId: "42",
    ref: "350273-50fb0941-4f59-4a89-8735-dd78ba7d53a3",
  },
  {
    flow: "card",
    version: 1,
    owner: OWNER_CS,
    txs: [],
    step: "ready",
    tokenId: "350273",
    operation: { kind: "block", externalId: "card-1" },
  },
  {
    flow: "onboarding",
    version: 1,
    owner: OWNER_CS,
    txs: [],
    step: "check",
    tokenId: "350273",
    payment: "f24",
  },
  {
    flow: "onboarding",
    version: 1,
    owner: OWNER_CS,
    txs: [
      {
        purpose: "main",
        phase: "confirmed",
        fromBlock: "10",
        nonce: 3,
        hash: HASH,
        blockNumber: "11",
      },
    ],
    step: "kyc",
    tokenId: "350273",
    payment: "eth",
    quote: { input: "2000000000000000000", blockNumber: "10" },
    kyc: "manual-review",
  },
  {
    flow: "onboarding",
    version: 1,
    owner: OWNER_CS,
    txs: [
      {
        purpose: "main",
        phase: "confirmed",
        fromBlock: "10",
        nonce: 3,
        hash: HASH,
        blockNumber: "11",
      },
    ],
    step: "live",
    tokenId: "350273",
    payment: "f24",
    quote: { input: "50", blockNumber: "10" },
  },
  {
    flow: "top-up",
    version: 1,
    owner: OWNER_CS,
    txs: [],
    step: "unavailable",
    output: "EUR24",
    usdcAmount: "100",
    reason: "deposit-paused",
  },
  {
    flow: "top-up",
    version: 1,
    owner: OWNER_CS,
    txs: [],
    step: "quoted",
    output: "CHF24",
    usdcAmount: "100",
    quote: { input: "100", output: "99", blockNumber: "10" },
  },
];

const recordArb: fc.Arbitrary<TxRecord> = fc.constantFrom<TxRecord>(
  { purpose: "main", phase: "ready" },
  { purpose: "main", phase: "ready", error: "signer-rejected" },
  { purpose: "main", phase: "sending", fromBlock: 10n, nonce: 3 },
  { purpose: "main", phase: "submitted", fromBlock: 10n, nonce: 3, hash: HASH },
  {
    purpose: "main",
    phase: "unknown",
    fromBlock: 10n,
    nonce: 3,
    error: "unknown-outcome",
  },
  {
    purpose: "main",
    phase: "confirmed",
    fromBlock: 10n,
    nonce: 3,
    hash: HASH,
    blockNumber: 11n,
  },
  {
    purpose: "main",
    phase: "failed",
    fromBlock: 10n,
    nonce: 3,
    hash: HASH,
    blockNumber: 11n,
    error: "tx-reverted",
  },
  { purpose: "main", phase: "not-sent", fromBlock: 10n, nonce: 3 },
);

const stepForRecord = (record: TxRecord): TransferState["step"] =>
  record.phase === "confirmed"
    ? "confirmed"
    : record.phase === "failed"
      ? "failed"
      : record.phase === "not-sent"
        ? "not-sent"
        : "tx";

const transferArb: fc.Arbitrary<TransferState> = fc.oneof(
  fc.record({
    flow: fc.constant("transfer" as const),
    version: fc.constant(1 as const),
    owner: fc.constant(OWNER_CS),
    txs: fc.constant([] as const),
    step: fc.constantFrom("draft" as const, "ready" as const),
    currency: fc.constantFrom(
      "USD24" as const,
      "EUR24" as const,
      "CHF24" as const,
      "CNH24" as const,
    ),
    amount: fc.bigInt({ min: 1n, max: 10n ** 18n - 1n }),
    to: fc.oneof(
      fc.record({ address: fc.constant(RECIPIENT_CS) }),
      fc.record({ tokenId: fc.bigInt({ min: 1n, max: 9099n }) }),
    ),
  }),
  recordArb.map((record) => ({
    flow: "transfer" as const,
    version: 1 as const,
    owner: OWNER_CS,
    txs: [record],
    step: stepForRecord(record),
    currency: "EUR24" as const,
    amount: 100n,
    to: { tokenId: 402001n },
  })),
);

const stateArb: fc.Arbitrary<FlowState> = fc.oneof(
  transferArb,
  ...VALID_JSON.map((json) => fc.constant(decodeFlowState(JSON.stringify(json)))),
);

const topLevelKey = fc.constantFrom(
  "flow",
  "version",
  "owner",
  "txs",
  "step",
  "currency",
  "amount",
  "to",
  "tokenId",
  "quote",
  "operation",
  "reason",
  "ref",
  "purposeId",
);

type Mutation =
  | { readonly mode: "delete"; readonly key: string }
  | { readonly mode: "set"; readonly key: string; readonly value: unknown };

function applyMutation(
  base: Readonly<Record<string, unknown>>,
  mutation: Mutation,
  replacement: unknown,
): Record<string, unknown> {
  const mutated: Record<string, unknown> = { ...base };
  if (mutation.mode === "delete") {
    Reflect.deleteProperty(mutated, mutation.key);
  } else {
    mutated[mutation.key] = mutation.key in mutated ? mutation.value : replacement;
  }
  return mutated;
}

const mutationArb = fc.oneof(
  fc.record({ mode: fc.constant("delete" as const), key: topLevelKey }),
  fc.record({
    mode: fc.constant("set" as const),
    key: topLevelKey,
    value: fc.jsonValue(),
  }),
  fc.record({
    mode: fc.constant("set" as const),
    key: fc.string({ minLength: 1, maxLength: 10 }),
    value: fc.jsonValue(),
  }),
);

describe("flow state codec properties", () => {
  test("random strings decode to a state or invalid-state, never an untyped throw", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), (text) =>
          okOrCode(() => decodeFlowState(text), INVALID_ONLY, isState),
        ),
      ),
    ).not.toThrow();
  });

  test("random JSON decodes to a state or invalid-state", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.jsonValue(), (value) =>
          okOrCode(() => decodeFlowState(JSON.stringify(value)), INVALID_ONLY, isState),
        ),
      ),
    ).not.toThrow();
  });

  test("mutated valid encodings decode to a state or invalid-state", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.constantFrom(...VALID_JSON),
          mutationArb,
          fc.jsonValue(),
          (base, mutation, replacement) => {
            const mutated = applyMutation(base, mutation, replacement);
            return okOrCode(() => decodeFlowState(JSON.stringify(mutated)), INVALID_ONLY, isState);
          },
        ),
      ),
    ).not.toThrow();
  });

  test("round-trip: decode(encode(s)) deep-equals s for every generated valid state", () => {
    expect(() =>
      fc.assert(
        fc.property(stateArb, (state) => {
          const decoded = decodeFlowState(encodeFlowState(state));
          // Canonical form: encoding is idempotent under decode — both sides
          // serialize identically, i.e. decode(encode(s)) has the same fields.
          expect(encodeFlowState(decoded)).toBe(encodeFlowState(state));
          // And deep-equality field by field — both decoded copies are plain
          // objects (a fast-check record's null prototype would break strict
          // equality against the generated input).
          expect(decoded).toStrictEqual(decodeFlowState(encodeFlowState(state)));
        }),
      ),
    ).not.toThrow();
  });
});
