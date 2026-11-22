import { getAddress } from "viem";
import type { Hash } from "viem";
import { describe, expect, test } from "vite-plus/test";

import type { Fiat24Error } from "../../src/core/errors.ts";
import { advanceTransfer, decodeFlowState, encodeFlowState } from "../../src/flows/index.ts";
import type { FlowState, TransferState } from "../../src/flows/index.ts";
import { throwsCode } from "../helpers.ts";
import { AMOUNT, flowDeps, makeFlowStub, OWNER, RECIPIENT, SENDER_ID } from "./stub.ts";

const OWNER_CS = getAddress(OWNER);
const RECIPIENT_CS = getAddress(RECIPIENT);
const HASH: Hash = `0x${"ab".repeat(32)}`;
const VALID_REF = "350273-50fb0941-4f59-4a89-8735-dd78ba7d53a3";

/** The canonical transfer draft in persisted (JSON) form — addresses checksummed. */
const DRAFT_JSON = {
  flow: "transfer",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "draft",
  currency: "EUR24",
  amount: "100",
  to: { address: RECIPIENT_CS },
};

const SUBMITTED_JSON = {
  ...DRAFT_JSON,
  step: "tx",
  txs: [{ purpose: "main", phase: "submitted", fromBlock: "526365924", nonce: 5, hash: HASH }],
};

const INVALID_STATE = "invalid-state";

describe("flow state codec", () => {
  test("round-trip: a valid state decodes to a deep-equal normalized value", () => {
    const state: TransferState = {
      flow: "transfer",
      version: 1,
      owner: OWNER_CS,
      txs: [],
      step: "draft",
      currency: "EUR24",
      amount: AMOUNT,
      to: { address: RECIPIENT_CS },
    };
    expect(decodeFlowState(encodeFlowState(state))).toStrictEqual(state);
  });

  test("round-trip: a submitted record survives encode/decode", () => {
    const decoded = decodeFlowState(JSON.stringify(SUBMITTED_JSON));
    expect(decoded.step).toBe("tx");
    expect(encodeFlowState(decoded)).toBe(JSON.stringify(SUBMITTED_JSON));
  });

  test("decode accepts a lowercase address and returns it checksummed", () => {
    const decoded = decodeFlowState(
      JSON.stringify({ ...DRAFT_JSON, owner: OWNER, to: { address: RECIPIENT } }),
    );
    expect(decoded.owner).toBe(OWNER_CS);
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  test("tampered state", () => {
    const cases: ReadonlyArray<unknown> = [
      // amount edited to zero — the rebuilt builder refuses.
      { ...DRAFT_JSON, amount: "0" },
      // bigint with a leading zero — not the canonical decimal.
      { ...DRAFT_JSON, amount: "0102" },
      // bigint as a JSON number — only canonical strings / real bigints decode.
      { ...DRAFT_JSON, amount: 100 },
      // recipient tokenId 9102 — an internal desk the builder refuses.
      { ...DRAFT_JSON, to: { tokenId: "9102" } },
      // recipient resolves to the owner.
      { ...DRAFT_JSON, to: { address: OWNER } },
      // extra key the grammar does not know.
      { ...DRAFT_JSON, memo: "hi" },
      // wrong version.
      { ...DRAFT_JSON, version: 2 },
      // submitted without its hash — the phase table requires it.
      {
        ...DRAFT_JSON,
        step: "tx",
        txs: [{ purpose: "main", phase: "submitted", fromBlock: "1", nonce: 5 }],
      },
      // confirmed without blockNumber.
      {
        ...DRAFT_JSON,
        step: "confirmed",
        txs: [
          {
            purpose: "main",
            phase: "confirmed",
            fromBlock: "1",
            nonce: 5,
            hash: HASH,
          },
        ],
      },
      // step "tx" with no active record.
      { ...DRAFT_JSON, step: "tx" },
      // step "confirmed" with no confirmed record.
      { ...DRAFT_JSON, step: "confirmed" },
      // step "draft" carrying a tx record.
      {
        ...DRAFT_JSON,
        txs: [{ purpose: "main", phase: "submitted", fromBlock: "1", nonce: 5, hash: HASH }],
      },
      // a ready record may not carry chain fields.
      {
        ...DRAFT_JSON,
        step: "tx",
        txs: [{ purpose: "main", phase: "ready", hash: HASH }],
      },
      // unsafe nonce — JSON integer beyond 2^53.
      {
        ...DRAFT_JSON,
        step: "tx",
        txs: [
          {
            purpose: "main",
            phase: "submitted",
            fromBlock: "1",
            nonce: Number.MAX_SAFE_INTEGER + 2,
            hash: HASH,
          },
        ],
      },
      // negative nonce.
      {
        ...DRAFT_JSON,
        step: "tx",
        txs: [{ purpose: "main", phase: "submitted", fromBlock: "1", nonce: -1, hash: HASH }],
      },
      // fractional nonce.
      {
        ...DRAFT_JSON,
        step: "tx",
        txs: [{ purpose: "main", phase: "submitted", fromBlock: "1", nonce: 1.5, hash: HASH }],
      },
      // three records — the two-record bound.
      {
        ...DRAFT_JSON,
        step: "tx",
        txs: [
          {
            purpose: "approve",
            phase: "confirmed",
            fromBlock: "1",
            nonce: 4,
            hash: HASH,
            blockNumber: "2",
          },
          {
            purpose: "main",
            phase: "confirmed",
            fromBlock: "1",
            nonce: 5,
            hash: HASH,
            blockNumber: "2",
          },
          { purpose: "main", phase: "ready" },
        ],
      },
      // second record may not be an approve.
      {
        ...DRAFT_JSON,
        step: "tx",
        txs: [
          {
            purpose: "main",
            phase: "confirmed",
            fromBlock: "1",
            nonce: 4,
            hash: HASH,
            blockNumber: "2",
          },
          { purpose: "approve", phase: "ready" },
        ],
      },
      // a non-last record that is not confirmed.
      {
        ...DRAFT_JSON,
        step: "tx",
        txs: [
          { purpose: "approve", phase: "submitted", fromBlock: "1", nonce: 4, hash: HASH },
          { purpose: "main", phase: "ready" },
        ],
      },
      // transfers never approve.
      {
        ...DRAFT_JSON,
        step: "tx",
        txs: [{ purpose: "approve", phase: "ready" }],
      },
      // payout ref without the payer's tokenId prefix — rebuild refuses.
      {
        flow: "payout",
        version: 1,
        owner: OWNER_CS,
        txs: [],
        step: "verified",
        tokenId: "350273",
        currency: "EUR24",
        amount: "100",
        contactId: "QRCH",
        purposeId: "42",
        ref: "50fb0941-4f59-4a89-8735-dd78ba7d53a3",
      },
      // payout purposeId without its ref.
      {
        flow: "payout",
        version: 1,
        owner: OWNER_CS,
        txs: [],
        step: "verified",
        tokenId: "350273",
        currency: "EUR24",
        amount: "100",
        contactId: "QRCH",
        purposeId: "42",
      },
      // a card cap carried by a non-setup operation.
      {
        flow: "card",
        version: 1,
        owner: OWNER_CS,
        txs: [],
        step: "ready",
        tokenId: "350273",
        operation: { kind: "block", externalId: "card-1" },
        cap: { currency: "EUR24", amount: "10" },
      },
      // top-up reason on a non-unavailable step.
      {
        flow: "top-up",
        version: 1,
        owner: OWNER_CS,
        txs: [],
        step: "check",
        output: "EUR24",
        usdcAmount: "100",
        reason: "token-paused",
      },
      // kyc state on a non-kyc step.
      {
        flow: "onboarding",
        version: 1,
        owner: OWNER_CS,
        txs: [],
        step: "check",
        tokenId: "350273",
        payment: "f24",
        kyc: "processing",
      },
      // exchange actual on a non-confirmed step.
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
        quote: { input: "100", output: "105", rate: "2", spread: "1", blockNumber: "1" },
        actual: { input: "100", output: "105" },
      },
      // garbage input.
      "not json at all {{{",
      42,
      null,
      { version: 1 },
    ];
    const texts = [
      ...cases.map((tampered) => JSON.stringify(tampered)),
      "not json at all {{{",
      "{unterminated",
      '"a bare string"',
    ];
    const results = texts.map((text) =>
      throwsCode(() => decodeFlowState(text), new Set([INVALID_STATE])),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  test("tampered in-memory state ⇒ invalid-state before any I/O", async () => {
    const stub = makeFlowStub({});
    const { deps } = flowDeps(stub.client);
    const tampered = {
      flow: "transfer",
      version: 1,
      owner: OWNER_CS,
      txs: [],
      step: "draft",
      currency: "EUR24",
      amount: 0n,
      to: { address: RECIPIENT_CS },
    } as unknown as TransferState;
    let error: unknown;
    try {
      await advanceTransfer(deps, tampered);
    } catch (error_) {
      error = error_;
    }
    expect((error as Fiat24Error).code).toBe(INVALID_STATE);
    expect(stub.requests).toHaveLength(0);
  });

  test("encodeFlowState refuses a PII-bearing PayoutDraft", () => {
    const draft = {
      flow: "payout",
      step: "draft",
      owner: OWNER_CS,
      tokenId: SENDER_ID,
      currency: "EUR24",
      amount: AMOUNT,
      target: { kind: "bank", request: { iban: "CH9300000000000000000" } },
    } as unknown as FlowState;
    expect(throwsCode(() => encodeFlowState(draft), new Set([INVALID_STATE]))).toBe(true);
  });

  test("encode persists bigints as canonical decimals and nonce as a number", () => {
    const text = encodeFlowState(decodeFlowState(JSON.stringify(SUBMITTED_JSON)));
    const parsed = JSON.parse(text) as {
      amount: unknown;
      txs: Array<{ nonce: unknown; fromBlock: unknown }>;
    };
    expect(parsed.amount).toBe("100");
    expect(parsed.txs[0]?.nonce).toBe(5);
    expect(parsed.txs[0]?.fromBlock).toBe("526365924");
  });

  test("every flow's state grammar round-trips", () => {
    const states: unknown[] = [
      DRAFT_JSON,
      SUBMITTED_JSON,
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
        quote: { input: "100", output: "105", rate: "2", spread: "1", blockNumber: "526365924" },
      },
      {
        flow: "payout",
        version: 1,
        owner: OWNER_CS,
        txs: [],
        step: "verified",
        tokenId: "350273",
        currency: "EUR24",
        amount: "100",
        contactId: "QRCH",
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
        contactId: "AB-12",
        purposeId: "42",
        ref: VALID_REF,
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
        flow: "card",
        version: 1,
        owner: OWNER_CS,
        txs: [],
        step: "ready",
        tokenId: "350273",
        operation: { kind: "create" },
        cap: { currency: "EUR24", amount: "1000" },
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
        flow: "top-up",
        version: 1,
        owner: OWNER_CS,
        txs: [],
        step: "unavailable",
        output: "EUR24",
        usdcAmount: "100",
        reason: "deposit-paused",
      },
    ];
    for (const state of states) {
      const text = JSON.stringify(state);
      const decoded = decodeFlowState(text);
      expect(encodeFlowState(decoded)).toBe(text);
    }
  });
});

describe("per-flow semantics", () => {
  const HASH2: Hash = `0x${"cd".repeat(32)}`;
  const FB = "526365924";
  const BN2 = "526365925";

  function confirmed(purpose: "approve" | "main", nonce = 1, hash: Hash = HASH) {
    return { purpose, phase: "confirmed", fromBlock: FB, nonce, hash, blockNumber: BN2 };
  }
  function submitted(purpose: "approve" | "main", nonce = 2, hash: Hash = HASH2) {
    return { purpose, phase: "submitted", fromBlock: FB, nonce, hash };
  }
  const FAILED_MAIN = {
    purpose: "main",
    phase: "failed",
    fromBlock: FB,
    nonce: 2,
    hash: HASH2,
    blockNumber: BN2,
    error: "tx-reverted",
  };
  const QUOTE = { input: "100", output: "105", rate: "2", spread: "1", blockNumber: FB };
  const ACTUAL = { input: "100", output: "105" };
  const MINT_QUOTE = { input: "50", blockNumber: FB };
  const TOPUP_QUOTE = { input: "100", output: "99", blockNumber: FB };

  const VALID: unknown[] = [
    // exchange: draft; tx with approve+main (exact-in and exact-out); confirmed; failed; not-sent.
    {
      flow: "exchange",
      version: 1,
      owner: OWNER_CS,
      txs: [],
      step: "draft",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: "100",
    },
    {
      flow: "exchange",
      version: 1,
      owner: OWNER_CS,
      step: "tx",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: "100",
      quote: QUOTE,
      txs: [confirmed("approve"), submitted("main")],
    },
    {
      flow: "exchange",
      version: 1,
      owner: OWNER_CS,
      step: "tx",
      side: "exact-out",
      from: "EUR24",
      to: "USD24",
      amount: "105",
      quote: QUOTE,
      txs: [confirmed("approve"), { purpose: "main", phase: "ready" }],
    },
    {
      flow: "exchange",
      version: 1,
      owner: OWNER_CS,
      step: "confirmed",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: "100",
      quote: QUOTE,
      actual: ACTUAL,
      txs: [confirmed("main", 2, HASH2)],
    },
    {
      flow: "exchange",
      version: 1,
      owner: OWNER_CS,
      step: "failed",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: "100",
      quote: QUOTE,
      txs: [FAILED_MAIN],
    },
    {
      flow: "exchange",
      version: 1,
      owner: OWNER_CS,
      step: "not-sent",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: "100",
      quote: QUOTE,
      txs: [{ purpose: "main", phase: "not-sent", fromBlock: FB, nonce: 2, hash: HASH2 }],
    },
    // payout: sending main; confirmed with txid and a confirmed main.
    {
      flow: "payout",
      version: 1,
      owner: OWNER_CS,
      step: "tx",
      tokenId: "350273",
      currency: "EUR24",
      amount: "100",
      contactId: "QRCH",
      txs: [{ purpose: "main", phase: "sending", fromBlock: FB, nonce: 3 }],
    },
    {
      flow: "payout",
      version: 1,
      owner: OWNER_CS,
      step: "confirmed",
      tokenId: "350273",
      currency: "CHF24",
      amount: "100",
      contactId: "AB-12",
      purposeId: "42",
      ref: VALID_REF,
      txid: "tx-123",
      txs: [confirmed("main", 2, HASH2)],
    },
    {
      flow: "payout",
      version: 1,
      owner: OWNER_CS,
      step: "not-sent",
      tokenId: "350273",
      currency: "EUR24",
      amount: "100",
      contactId: "QRCH",
      txs: [{ purpose: "main", phase: "not-sent", fromBlock: FB, nonce: 3 }],
    },
    // card: API records across phases; set-cap confirmed with empty txs.
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "tx",
      tokenId: "350273",
      operation: { kind: "set-cap", currency: "EUR24", amount: "50" },
      txs: [submitted("approve")],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "tx",
      tokenId: "350273",
      operation: { kind: "block", externalId: "c1" },
      txs: [{ purpose: "main", phase: "ready", error: "unauthorized" }],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "tx",
      tokenId: "350273",
      operation: { kind: "block", externalId: "c1" },
      txs: [{ purpose: "main", phase: "unknown", error: "unknown-outcome" }],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "confirmed",
      tokenId: "350273",
      operation: { kind: "set-cap", currency: "USD24", amount: "50" },
      txs: [],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "confirmed",
      tokenId: "350273",
      operation: { kind: "block", externalId: "c1" },
      txs: [{ purpose: "main", phase: "confirmed" }],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "confirmed",
      tokenId: "350273",
      operation: { kind: "create" },
      cap: { currency: "EUR24", amount: "1000" },
      txs: [confirmed("approve"), { purpose: "main", phase: "confirmed" }],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "failed",
      tokenId: "350273",
      operation: { kind: "block", externalId: "c1" },
      txs: [{ purpose: "main", phase: "failed", error: "api-rejected" }],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "ready",
      tokenId: "350273",
      operation: { kind: "unblock", externalId: "c1" },
      txs: [],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "ready",
      tokenId: "350273",
      operation: { kind: "set-currency", externalId: "c1", currency: "USD" },
      txs: [],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "ready",
      tokenId: "350273",
      operation: { kind: "device-token", externalId: "c1", cardTokenId: "77", status: "activate" },
      txs: [],
    },
    // onboarding: eth ready; f24 tx with approve; every post-mint step.
    {
      flow: "onboarding",
      version: 1,
      owner: OWNER_CS,
      step: "ready",
      tokenId: "350273",
      payment: "eth",
      quote: MINT_QUOTE,
      txs: [],
    },
    {
      flow: "onboarding",
      version: 1,
      owner: OWNER_CS,
      step: "tx",
      tokenId: "350273",
      payment: "f24",
      quote: MINT_QUOTE,
      txs: [confirmed("approve"), submitted("main")],
    },
    {
      flow: "onboarding",
      version: 1,
      owner: OWNER_CS,
      step: "tourist",
      tokenId: "350273",
      payment: "f24",
      quote: MINT_QUOTE,
      txs: [confirmed("main", 2, HASH2)],
    },
    {
      flow: "onboarding",
      version: 1,
      owner: OWNER_CS,
      step: "kyc",
      tokenId: "350273",
      payment: "f24",
      quote: MINT_QUOTE,
      kyc: "processing",
      txs: [confirmed("main", 2, HASH2)],
    },
    {
      flow: "onboarding",
      version: 1,
      owner: OWNER_CS,
      step: "live",
      tokenId: "350273",
      payment: "eth",
      quote: MINT_QUOTE,
      txs: [confirmed("main", 2, HASH2)],
    },
    {
      flow: "onboarding",
      version: 1,
      owner: OWNER_CS,
      step: "rejected",
      tokenId: "350273",
      payment: "eth",
      quote: MINT_QUOTE,
      txs: [confirmed("main", 2, HASH2)],
    },
    {
      flow: "onboarding",
      version: 1,
      owner: OWNER_CS,
      step: "failed",
      tokenId: "350273",
      payment: "eth",
      quote: MINT_QUOTE,
      txs: [FAILED_MAIN],
    },
    {
      flow: "onboarding",
      version: 1,
      owner: OWNER_CS,
      step: "not-sent",
      tokenId: "350273",
      payment: "f24",
      quote: MINT_QUOTE,
      txs: [{ purpose: "main", phase: "not-sent", fromBlock: FB, nonce: 2 }],
    },
    // approve records can themselves fail or be not-sent.
    {
      flow: "exchange",
      version: 1,
      owner: OWNER_CS,
      step: "failed",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: "100",
      quote: QUOTE,
      txs: [
        {
          purpose: "approve",
          phase: "failed",
          fromBlock: FB,
          nonce: 1,
          hash: HASH,
          blockNumber: BN2,
          error: "tx-reverted",
        },
      ],
    },
    {
      flow: "exchange",
      version: 1,
      owner: OWNER_CS,
      step: "not-sent",
      side: "exact-out",
      from: "EUR24",
      to: "USD24",
      amount: "105",
      quote: QUOTE,
      txs: [{ purpose: "approve", phase: "not-sent", fromBlock: FB, nonce: 1 }],
    },
    {
      flow: "top-up",
      version: 1,
      owner: OWNER_CS,
      step: "not-sent",
      output: "EUR24",
      usdcAmount: "100",
      quote: TOPUP_QUOTE,
      txs: [{ purpose: "approve", phase: "not-sent", fromBlock: FB, nonce: 1 }],
    },
    {
      flow: "onboarding",
      version: 1,
      owner: OWNER_CS,
      step: "failed",
      tokenId: "350273",
      payment: "f24",
      quote: MINT_QUOTE,
      txs: [
        {
          purpose: "approve",
          phase: "failed",
          fromBlock: FB,
          nonce: 1,
          hash: HASH,
          blockNumber: BN2,
          error: "tx-reverted",
        },
      ],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "confirmed",
      tokenId: "350273",
      operation: { kind: "set-cap", currency: "EUR24", amount: "50" },
      txs: [confirmed("approve")],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "failed",
      tokenId: "350273",
      operation: { kind: "set-cap", currency: "EUR24", amount: "50" },
      txs: [
        {
          purpose: "approve",
          phase: "failed",
          fromBlock: FB,
          nonce: 1,
          hash: HASH,
          blockNumber: BN2,
          error: "tx-reverted",
        },
      ],
    },
    {
      flow: "card",
      version: 1,
      owner: OWNER_CS,
      step: "not-sent",
      tokenId: "350273",
      operation: { kind: "set-cap", currency: "EUR24", amount: "50" },
      txs: [{ purpose: "approve", phase: "not-sent", fromBlock: FB, nonce: 1 }],
    },
    // top-up: check; quoted; tx with approve; confirmed with actual; failed.
    {
      flow: "top-up",
      version: 1,
      owner: OWNER_CS,
      step: "check",
      output: "EUR24",
      usdcAmount: "100",
      txs: [],
    },
    {
      flow: "top-up",
      version: 1,
      owner: OWNER_CS,
      step: "quoted",
      output: "EUR24",
      usdcAmount: "100",
      quote: TOPUP_QUOTE,
      txs: [],
    },
    {
      flow: "top-up",
      version: 1,
      owner: OWNER_CS,
      step: "tx",
      output: "EUR24",
      usdcAmount: "100",
      quote: TOPUP_QUOTE,
      txs: [confirmed("approve"), submitted("main")],
    },
    {
      flow: "top-up",
      version: 1,
      owner: OWNER_CS,
      step: "confirmed",
      output: "EUR24",
      usdcAmount: "100",
      quote: TOPUP_QUOTE,
      actual: { input: "100", output: "99" },
      txs: [confirmed("main", 2, HASH2)],
    },
    {
      flow: "top-up",
      version: 1,
      owner: OWNER_CS,
      step: "failed",
      output: "EUR24",
      usdcAmount: "100",
      quote: TOPUP_QUOTE,
      txs: [FAILED_MAIN],
    },
  ];

  test("every persisted shape across the six flows decodes", () => {
    for (const state of VALID) {
      const text = JSON.stringify(state);
      const canonical = encodeFlowState(decodeFlowState(text));
      expect(encodeFlowState(decodeFlowState(canonical))).toBe(canonical);
    }
  });

  const BASE = { version: 1, owner: OWNER_CS };

  function transferTx(txs: unknown[]): unknown {
    return {
      ...BASE,
      flow: "transfer",
      step: "tx",
      currency: "EUR24",
      amount: "100",
      to: { address: RECIPIENT_CS },
      txs,
    };
  }
  function cardTx(operation: unknown, txs: unknown[]): unknown {
    return { ...BASE, flow: "card", step: "tx", tokenId: "350273", operation, txs };
  }

  const INVALID: unknown[] = [
    // chain-record phase table.
    transferTx([{ purpose: "main", phase: "ready", fromBlock: FB, nonce: 1 }]),
    transferTx([{ purpose: "main", phase: "ready", error: "tx-reverted" }]),
    transferTx([{ purpose: "main", phase: "sending", fromBlock: FB }]),
    transferTx([{ purpose: "main", phase: "sending", fromBlock: FB, nonce: 1, hash: HASH }]),
    transferTx([
      { purpose: "main", phase: "sending", fromBlock: FB, nonce: 1, error: "rpc-error" },
    ]),
    transferTx([{ ...submitted("main"), error: "rpc-error" }]),
    transferTx([
      { purpose: "main", phase: "unknown", fromBlock: FB, nonce: 1, error: "tx-reverted" },
    ]),
    transferTx([{ purpose: "main", phase: "unknown", fromBlock: FB, nonce: 1 }]),
    transferTx([{ ...confirmed("main"), error: "rpc-error" }]),
    transferTx([
      { purpose: "main", phase: "failed", fromBlock: FB, nonce: 1, hash: HASH, blockNumber: BN2 },
    ]),
    transferTx([
      {
        purpose: "main",
        phase: "failed",
        fromBlock: FB,
        nonce: 1,
        hash: HASH,
        blockNumber: BN2,
        error: "unknown-outcome",
      },
    ]),
    transferTx([
      { purpose: "main", phase: "not-sent", fromBlock: FB, nonce: 1, error: "signer-rejected" },
    ]),
    transferTx([{ purpose: "main", phase: "not-sent", fromBlock: FB }]),
    // txs shape: >2 records, wrong order, non-confirmed middle record.
    transferTx([confirmed("approve"), submitted("main"), confirmed("main", 3, HASH)]),
    transferTx([confirmed("main"), submitted("approve")]),
    transferTx([submitted("approve"), { purpose: "main", phase: "ready" }]),
    // API records: chain fields, meaningless phases, bad errors.
    cardTx({ kind: "block", externalId: "c1" }, [{ purpose: "main", phase: "sending", nonce: 1 }]),
    cardTx({ kind: "block", externalId: "c1" }, [{ purpose: "main", phase: "submitted" }]),
    cardTx({ kind: "block", externalId: "c1" }, [{ purpose: "main", phase: "not-sent" }]),
    cardTx({ kind: "block", externalId: "c1" }, [
      { purpose: "main", phase: "ready", error: "rpc-error" },
    ]),
    cardTx({ kind: "block", externalId: "c1" }, [
      { purpose: "main", phase: "sending", error: "rate-limited" },
    ]),
    cardTx({ kind: "block", externalId: "c1" }, [
      { purpose: "main", phase: "confirmed", error: "http-error" },
    ]),
    cardTx({ kind: "block", externalId: "c1" }, [{ purpose: "main", phase: "unknown" }]),
    cardTx({ kind: "block", externalId: "c1" }, [
      { purpose: "main", phase: "failed", error: "tx-reverted" },
    ]),
    // exchange: quote/actual pairing and the exact-out approve without a quote.
    {
      ...BASE,
      flow: "exchange",
      step: "quoted",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: "100",
      txs: [],
    },
    {
      ...BASE,
      flow: "exchange",
      step: "draft",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: "100",
      quote: QUOTE,
      txs: [],
    },
    {
      ...BASE,
      flow: "exchange",
      step: "confirmed",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: "100",
      quote: QUOTE,
      txs: [confirmed("main")],
    },
    {
      ...BASE,
      flow: "exchange",
      step: "quoted",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: "100",
      quote: QUOTE,
      actual: ACTUAL,
      txs: [],
    },
    {
      ...BASE,
      flow: "exchange",
      step: "draft",
      side: "exact-out",
      from: "EUR24",
      to: "USD24",
      amount: "105",
      txs: [submitted("approve")],
    },
    // payout: purposeId/ref pairing, bad ref, approve forbidden, txid pairing.
    {
      ...BASE,
      flow: "payout",
      step: "verified",
      tokenId: "350273",
      currency: "EUR24",
      amount: "100",
      contactId: "QRCH",
      ref: VALID_REF,
      txs: [],
    },
    {
      ...BASE,
      flow: "payout",
      step: "verified",
      tokenId: "350273",
      currency: "EUR24",
      amount: "100",
      contactId: "QRCH",
      purposeId: "42",
      txs: [],
    },
    {
      ...BASE,
      flow: "payout",
      step: "verified",
      tokenId: "350273",
      currency: "EUR24",
      amount: "100",
      contactId: "QRCH",
      purposeId: "42",
      ref: "999-50fb0941-4f59-4a89-8735-dd78ba7d53a3",
      txs: [],
    },
    {
      ...BASE,
      flow: "payout",
      step: "tx",
      tokenId: "350273",
      currency: "EUR24",
      amount: "100",
      contactId: "QRCH",
      txs: [submitted("approve")],
    },
    {
      ...BASE,
      flow: "payout",
      step: "confirmed",
      tokenId: "350273",
      currency: "EUR24",
      amount: "100",
      contactId: "QRCH",
      txs: [confirmed("main")],
    },
    {
      ...BASE,
      flow: "payout",
      step: "verified",
      tokenId: "350273",
      currency: "EUR24",
      amount: "100",
      contactId: "QRCH",
      txid: "tx-1",
      txs: [],
    },
    // card: cap rules, approve-purpose rules, confirmed-empty rule.
    {
      ...BASE,
      flow: "card",
      step: "ready",
      tokenId: "350273",
      operation: { kind: "block", externalId: "c1" },
      cap: { currency: "EUR24", amount: "100" },
      txs: [],
    },
    {
      ...BASE,
      flow: "card",
      step: "ready",
      tokenId: "350273",
      operation: { kind: "create" },
      cap: { currency: "EUR24", amount: "0" },
      txs: [],
    },
    cardTx({ kind: "block", externalId: "c1" }, [submitted("approve")]),
    {
      ...BASE,
      flow: "card",
      step: "confirmed",
      tokenId: "350273",
      operation: { kind: "block", externalId: "c1" },
      txs: [],
    },
    {
      ...BASE,
      flow: "card",
      step: "confirmed",
      tokenId: "350273",
      operation: { kind: "set-cap", currency: "EUR24", amount: "50" },
      txs: [{ purpose: "main", phase: "failed", error: "api-rejected" }],
    },
    // onboarding: quote/kyc pairing, approve requires f24 + quote, terminal needs confirmed.
    {
      ...BASE,
      flow: "onboarding",
      step: "check",
      tokenId: "350273",
      payment: "f24",
      quote: MINT_QUOTE,
      txs: [],
    },
    { ...BASE, flow: "onboarding", step: "ready", tokenId: "350273", payment: "eth", txs: [] },
    {
      ...BASE,
      flow: "onboarding",
      step: "tx",
      tokenId: "350273",
      payment: "eth",
      quote: MINT_QUOTE,
      txs: [submitted("approve")],
    },
    {
      ...BASE,
      flow: "onboarding",
      step: "tx",
      tokenId: "350273",
      payment: "f24",
      txs: [submitted("approve")],
    },
    {
      ...BASE,
      flow: "onboarding",
      step: "kyc",
      tokenId: "350273",
      payment: "f24",
      quote: MINT_QUOTE,
      txs: [confirmed("main")],
    },
    {
      ...BASE,
      flow: "onboarding",
      step: "live",
      tokenId: "350273",
      payment: "eth",
      quote: MINT_QUOTE,
      kyc: "completed",
      txs: [confirmed("main")],
    },
    {
      ...BASE,
      flow: "onboarding",
      step: "tourist",
      tokenId: "350273",
      payment: "f24",
      quote: MINT_QUOTE,
      txs: [],
    },
    {
      ...BASE,
      flow: "onboarding",
      step: "tourist",
      tokenId: "350273",
      payment: "f24",
      quote: MINT_QUOTE,
      txs: [submitted("main")],
    },
    // top-up: quote/reason/actual pairing.
    {
      ...BASE,
      flow: "top-up",
      step: "check",
      output: "EUR24",
      usdcAmount: "100",
      quote: TOPUP_QUOTE,
      txs: [],
    },
    { ...BASE, flow: "top-up", step: "quoted", output: "EUR24", usdcAmount: "100", txs: [] },
    {
      ...BASE,
      flow: "top-up",
      step: "quoted",
      output: "EUR24",
      usdcAmount: "100",
      quote: TOPUP_QUOTE,
      reason: "deposit-paused",
      txs: [],
    },
    { ...BASE, flow: "top-up", step: "unavailable", output: "EUR24", usdcAmount: "100", txs: [] },
    {
      ...BASE,
      flow: "top-up",
      step: "check",
      output: "EUR24",
      usdcAmount: "100",
      reason: "deposit-paused",
      txs: [],
    },
    {
      ...BASE,
      flow: "top-up",
      step: "quoted",
      output: "EUR24",
      usdcAmount: "100",
      quote: TOPUP_QUOTE,
      actual: { input: "100", output: "99" },
      txs: [],
    },
    {
      ...BASE,
      flow: "top-up",
      step: "confirmed",
      output: "EUR24",
      usdcAmount: "100",
      quote: TOPUP_QUOTE,
      txs: [confirmed("main")],
    },
  ];

  test("every semantic inconsistency is invalid-state", () => {
    for (const state of INVALID) {
      expect(() => decodeFlowState(JSON.stringify(state))).toThrow(
        expect.objectContaining({ code: INVALID_STATE }),
      );
    }
  });
});
