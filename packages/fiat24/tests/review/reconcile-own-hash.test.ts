/**
 * R-01 — transfer reconcile never consults the recorded hash's own receipt: a `submitted`/`unknown`
 * record carrying `hash` reconciles to `not-sent` when the tx under that hash no longer binds (a
 * 7702 batching wallet wrapped our call, so `to`/`input` differ) — although its success receipt
 * contains the very Transfer log the flow watches for. This test asserts the current defective
 * behaviour; it is expected to fail once the finding is fixed.
 */
import { getAddress } from "viem";
import type { Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceTransfer, decodeFlowState, encodeFlowState } from "../../src/flows/index.ts";
import type { TransferState } from "../../src/flows/index.ts";
import { checkedState } from "../../src/flows/state.ts";
import {
  AMOUNT,
  B,
  flowDeps,
  makeFlowStub,
  OWNER,
  RECIPIENT,
  receiptPayload,
  transferLog,
  txPayload,
  TXID_1,
} from "../flows/stub.ts";

const TOKEN = C.tokens.EUR24.proxy;
const OWNER_CS = getAddress(OWNER);
const RECIPIENT_CS = getAddress(RECIPIENT);
const NONCE = 5;

const BASE = {
  flow: "transfer",
  version: 1,
  owner: OWNER_CS,
  currency: "EUR24",
  amount: AMOUNT,
  to: { address: RECIPIENT_CS },
} as const;

const SUBMITTED: TransferState = {
  ...BASE,
  step: "tx",
  txs: [{ purpose: "main", phase: "submitted", fromBlock: B, nonce: NONCE, hash: TXID_1 }],
};

const UNKNOWN_HASHED: TransferState = {
  ...BASE,
  step: "tx",
  txs: [
    {
      purpose: "main",
      phase: "unknown",
      fromBlock: B,
      nonce: NONCE,
      hash: TXID_1,
      error: "unknown-outcome",
    },
  ],
};

// A 7702/smart-account batching wallet wrapped our call: same hash, from and nonce, but `to` is
// the owner's own account and the input is some execute-style payload, not our transfer bytes.
const WRAPPED_INPUT: Hex = "0xac9650d8";
const wrappedTx = txPayload({
  hash: TXID_1,
  from: OWNER,
  to: OWNER,
  input: WRAPPED_INPUT,
  value: 0n,
  nonce: NONCE,
  blockNumber: B + 1n,
});

/** The success receipt of TXID_1 at B+1 containing the real Transfer(OWNER→RECIPIENT, AMOUNT). */
const ownReceipt = receiptPayload({
  transactionHash: TXID_1,
  blockNumber: B + 1n,
  status: "success",
  logs: [
    transferLog({
      token: TOKEN,
      from: OWNER,
      to: RECIPIENT,
      amount: AMOUNT,
      blockNumber: B + 1n,
      transactionHash: TXID_1,
    }),
  ],
});

/** The ledger stub: nonce 5 consumed (latest 6), our Transfer log under TXID_1, non-binding tx. */
function ledgerStub() {
  return makeFlowStub({
    count: { latest: NONCE + 1 },
    logs: () => [
      transferLog({
        token: TOKEN,
        from: OWNER,
        to: RECIPIENT,
        amount: AMOUNT,
        blockNumber: B + 1n,
        transactionHash: TXID_1,
      }),
    ],
    transactions: { [TXID_1]: wrappedTx },
    receipts: { [TXID_1]: ownReceipt },
  });
}

describe("reconcile ignores the recorded hash's own receipt (R-01)", () => {
  test("(a) submitted + own-hash receipt proves the transfer ⇒ still not-sent", async () => {
    const first = makeFlowStub({
      receipts: { [TXID_1]: ownReceipt },
      transactions: { [TXID_1]: wrappedTx },
    });
    const { deps } = flowDeps(first.client);
    const unbound = await advanceTransfer(deps, SUBMITTED);
    expect(unbound.txs[0]?.phase).toBe("unknown");
    expect(unbound.txs[0]?.hash).toBe(TXID_1);
    expect(unbound.txs[0]?.error).toBe("unknown-outcome");

    const ledger = ledgerStub();
    const { deps: deps2 } = flowDeps(ledger.client);
    const next = await advanceTransfer(deps2, unbound);
    // The host is told it is safe to start again although the receipt of the very hash our
    // signer returned shows the transfer executed.
    expect(next.step).toBe("not-sent");
  });

  test("(b) unknown{hash} from the codec ⇒ not-sent", async () => {
    const revived = decodeFlowState(encodeFlowState(UNKNOWN_HASHED));
    expect(revived.flow).toBe("transfer");
    const state = checkedState(revived, "transfer");
    expect(state.txs[0]?.hash).toBe(TXID_1);

    const ledger = ledgerStub();
    const { deps } = flowDeps(ledger.client);
    const next = await advanceTransfer(deps, state);
    expect(next.step).toBe("not-sent");
  });
});
