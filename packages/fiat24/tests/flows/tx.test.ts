import { erc20Abi } from "viem";
import type { Hash } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import { transferCall } from "../../src/calls/transfer.ts";
import { topic0Of } from "../../src/chain/context.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceTx } from "../../src/flows/tx.ts";
import type { TxEvidence } from "../../src/flows/tx.ts";
import type { TransferState, TxRecord } from "../../src/flows/types.ts";
import { expectErrorAsync } from "../chain/stub.ts";
import type { CallEntry } from "../chain/stub.ts";
import {
  addressTopic,
  AMOUNT,
  B,
  flowDeps,
  honestStorage,
  logPayload,
  makeFlowStub,
  OWNER,
  receiptPayload,
  RECIPIENT,
  txPayload,
  TXID_1,
  TXID_2,
  word,
} from "./stub.ts";

const TOKEN = C.tokens.EUR24.proxy;
const CALL = transferCall({ currency: "EUR24", to: RECIPIENT, amount: AMOUNT });
const TXID_3: Hash = `0x${"33".repeat(32)}`;

function commitTx(record: TxRecord): TransferState {
  return {
    flow: "transfer",
    version: 1,
    owner: OWNER,
    step: "tx",
    currency: "EUR24",
    amount: AMOUNT,
    to: { address: RECIPIENT },
    txs: [record],
  };
}

function base(record: TxRecord | undefined, extra: Partial<TxArgs> = {}) {
  return {
    record,
    purpose: "main" as const,
    call: CALL,
    owner: OWNER,
    deployment: C,
    evidence: TOKEN_EVIDENCE,
    commit: commitTx,
    ...extra,
  };
}

type TxArgs = {
  readonly evidence: TxEvidence;
};

const TRANSFER_TOPIC = topic0Of(tokenAbi, "Transfer");
const APPROVAL_TOPIC = topic0Of(erc20Abi, "Approval");

const TOKEN_EVIDENCE: TxEvidence = {
  filters: [{ address: TOKEN, topics: [TRANSFER_TOPIC, addressTopic(OWNER)] }],
};
const ERC20_EVIDENCE: TxEvidence = {
  filters: [{ address: C.usdc, topics: [APPROVAL_TOPIC] }],
  erc20: true,
};

const UNSAFE_COUNT = "0x20000000000001";
const NESTED_NOT_FOUND = new Error("wrapper", {
  cause: { name: "Mid", cause: { name: "TransactionReceiptNotFoundError" } },
});

const nodeDown = (): never => {
  throw Object.assign(new Error("node down"), { code: -32000 });
};
const throwIt = (error: unknown) => (): never => {
  throw error;
};

/** Dispatch table for `onRequest`: unknown methods fall through to the stub. */
const onMethod =
  (table: Readonly<Record<string, (params: unknown) => unknown>>) =>
  (method: string, params: unknown) =>
    table[method]?.(params);

/** Replies only for non-"pending" block tags (the reconcile ledger read). */
const atLatestTag = (reply: () => unknown) => (params: unknown) =>
  (params as [unknown, string])[1] === "pending" ? undefined : reply();

/** `sending` at nonce 1 — the reconcile input for every ledger-driven test. */
const SENDING: TxRecord = { purpose: "main", phase: "sending", fromBlock: B, nonce: 1 };

const SUBMITTED: TxRecord = {
  purpose: "main",
  phase: "submitted",
  fromBlock: B,
  nonce: 1,
  hash: TXID_1,
};

function bindingTx(hash: Hash, nonce = 1): Record<string, unknown> {
  return txPayload({
    hash,
    from: OWNER,
    to: CALL.to,
    input: CALL.data,
    value: CALL.value,
    nonce,
  });
}

function erc20Log(args: {
  readonly eventName: "Approval" | "Transfer";
  readonly transactionHash: unknown;
}): Record<string, unknown> {
  const topic0 = topic0Of(erc20Abi, args.eventName);
  return logPayload({
    address: C.usdc,
    topics: [topic0, addressTopic(OWNER), addressTopic(RECIPIENT)],
    data: word(AMOUNT),
    blockNumber: B,
    transactionHash: args.transactionHash as Hash,
  });
}

describe("advanceTx", () => {
  test("a submitted record missing required fields ⇒ invalid-state", async () => {
    const stub = makeFlowStub({});
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () =>
        advanceTx(deps, base({ purpose: "main", phase: "submitted", nonce: 1, hash: TXID_1 })),
      "invalid-state",
    );
    expect(error.code).toBe("invalid-state");
  });

  test("terminal records are rejected before any I/O", async () => {
    const stub = makeFlowStub({});
    const { deps } = flowDeps(stub.client);
    const terminals: TxRecord[] = [
      { purpose: "main", phase: "confirmed", fromBlock: B, nonce: 1, hash: TXID_1, blockNumber: B },
      {
        purpose: "main",
        phase: "failed",
        fromBlock: B,
        nonce: 1,
        hash: TXID_1,
        blockNumber: B,
        error: "tx-reverted",
      },
      { purpose: "main", phase: "not-sent", fromBlock: B, nonce: 1 },
    ];
    const codes = await Promise.all(
      terminals.map(async (record) => {
        const error = await expectErrorAsync(
          async () => advanceTx(deps, base(record)),
          "invalid-state",
        );
        return error.code;
      }),
    );
    expect(codes).toStrictEqual(["invalid-state", "invalid-state", "invalid-state"]);
    expect(stub.calls).toHaveLength(0);
  });

  test("receipt lookup failure maps through the rpc table", async () => {
    const stub = makeFlowStub({
      onRequest: onMethod({ eth_getTransactionReceipt: nodeDown }),
    });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceTx(deps, base(SUBMITTED)), "rpc-error");
    expect(error.code).toBe("rpc-error");
  });

  test("receipt missing + tx vanished + ledger at nonce ⇒ stays submitted", async () => {
    const stub = makeFlowStub({
      count: { latest: 1 },
      onRequest: onMethod({ eth_getTransactionReceipt: throwIt(NESTED_NOT_FOUND) }),
    });
    const { deps, persisted } = flowDeps(stub.client);
    const outcome = await advanceTx(deps, base(SUBMITTED));
    expect(outcome.record.phase).toBe("submitted");
    expect(outcome.record.hash).toBe(TXID_1);
    expect(persisted).toHaveLength(1);
  });

  test("pending transaction that binds keeps the submitted record", async () => {
    const stub = makeFlowStub({
      transactions: {
        [TXID_1.toLowerCase()]: { ...bindingTx(TXID_1), blockNumber: null, blockHash: null },
      },
    });
    const { deps } = flowDeps(stub.client);
    const outcome = await advanceTx(deps, base(SUBMITTED));
    expect(outcome.record).toStrictEqual(SUBMITTED);
  });

  test("receipt + non-binding transaction ⇒ unknown", async () => {
    const stub = makeFlowStub({
      receipts: {
        [TXID_1.toLowerCase()]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B,
          status: "success",
        }),
      },
      transactions: { [TXID_1.toLowerCase()]: bindingTx(TXID_1, 2) },
    });
    const { deps } = flowDeps(stub.client);
    const outcome = await advanceTx(deps, base(SUBMITTED));
    expect(outcome.record.phase).toBe("unknown");
    expect(outcome.record.error).toBe("unknown-outcome");
  });

  test("receipt found but transaction lookup fails ⇒ rpc-error", async () => {
    const stub = makeFlowStub({
      receipts: {
        [TXID_1.toLowerCase()]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B,
          status: "success",
        }),
      },
      onRequest: onMethod({ eth_getTransactionByHash: nodeDown }),
    });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceTx(deps, base(SUBMITTED)), "rpc-error");
    expect(error.code).toBe("rpc-error");
  });

  test("pending transaction lookup failure maps through the rpc table", async () => {
    const stub = makeFlowStub({ onRequest: onMethod({ eth_getTransactionByHash: nodeDown }) });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceTx(deps, base(SUBMITTED)), "rpc-error");
    expect(error.code).toBe("rpc-error");
  });

  test("reconcile record missing nonce ⇒ invalid-state", async () => {
    const stub = makeFlowStub({});
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () =>
        advanceTx(
          deps,
          base({ purpose: "main", phase: "unknown", fromBlock: B, error: "unknown-outcome" }),
        ),
      "invalid-state",
    );
    expect(error.code).toBe("invalid-state");
  });

  test("pending nonce lookup failure and unsafe counts map to rpc-error", async () => {
    const calls = new Map<string, CallEntry[]>([
      [
        `${TOKEN.toLowerCase()}:transfer`,
        [{ args: [RECIPIENT, AMOUNT], answer: { result: true } }],
      ],
    ]);
    const unsafe = makeFlowStub({
      storage: honestStorage(),
      calls,
      onRequest: onMethod({ eth_getTransactionCount: () => UNSAFE_COUNT }),
    });
    const { deps: deps1 } = flowDeps(unsafe.client);
    const unsafeErr = await expectErrorAsync(
      async () => advanceTx(deps1, base(undefined)),
      "rpc-error",
    );
    expect(unsafeErr.code).toBe("rpc-error");

    const down = makeFlowStub({
      storage: honestStorage(),
      calls,
      onRequest: onMethod({ eth_getTransactionCount: nodeDown }),
    });
    const { deps: deps2 } = flowDeps(down.client);
    const downErr = await expectErrorAsync(
      async () => advanceTx(deps2, base(undefined)),
      "rpc-error",
    );
    expect(downErr.code).toBe("rpc-error");
  });

  test("latest nonce lookup failure and unsafe counts map to rpc-error", async () => {
    const unsafe = makeFlowStub({
      onRequest: onMethod({ eth_getTransactionCount: atLatestTag(() => UNSAFE_COUNT) }),
    });
    const { deps: deps1 } = flowDeps(unsafe.client);
    const unsafeErr = await expectErrorAsync(
      async () => advanceTx(deps1, base(SENDING)),
      "rpc-error",
    );
    expect(unsafeErr.code).toBe("rpc-error");

    const down = makeFlowStub({
      onRequest: onMethod({ eth_getTransactionCount: atLatestTag(nodeDown) }),
    });
    const { deps: deps2 } = flowDeps(down.client);
    const downErr = await expectErrorAsync(
      async () => advanceTx(deps2, base(SENDING)),
      "rpc-error",
    );
    expect(downErr.code).toBe("rpc-error");
  });

  test("sending with ledger at the nonce ⇒ unknown-outcome", async () => {
    const stub = makeFlowStub({ count: { latest: 1 } });
    const { deps } = flowDeps(stub.client);
    const outcome = await advanceTx(deps, base(SENDING));
    expect(outcome.record.phase).toBe("unknown");
    expect(outcome.record.error).toBe("unknown-outcome");
  });

  test("ledger past the nonce, no binding evidence ⇒ not-sent", async () => {
    const stub = makeFlowStub({
      count: { latest: 3 },
      logs: () => [
        // Undecodable for the fiat24 table ⇒ skipped; leaves no candidates.
        logPayload({
          address: TOKEN,
          topics: [`0x${"ee".repeat(32)}`],
          data: "0x",
          blockNumber: B,
          transactionHash: TXID_1,
        }),
      ],
    });
    const { deps } = flowDeps(stub.client);
    const outcome = await advanceTx(deps, base(SENDING, { evidence: TOKEN_EVIDENCE }));
    expect(outcome.record.phase).toBe("not-sent");
  });

  test("duplicate transactionHash candidates are inspected once", async () => {
    const stub = makeFlowStub({
      count: { latest: 3 },
      logs: () => [transferEntry(TXID_2), transferEntry(TXID_2)],
      transactions: { [TXID_2.toLowerCase()]: bindingTx(TXID_2) },
    });
    const { deps } = flowDeps(stub.client);
    const outcome = await advanceTx(deps, base(SENDING));
    expect(outcome.record.phase).toBe("submitted");
    expect(outcome.record.hash).toBe(TXID_2);
    const lookups = stub.requests.filter((r) => r.method === "eth_getTransactionByHash");
    expect(lookups).toHaveLength(1);
  });

  test("log fields never filter a candidate — the tx binding decides", async () => {
    // A same-owner Transfer log with a different amount/recipient is still a
    // candidate: the five-field binding on the transaction is what decides.
    const stub = makeFlowStub({
      count: { latest: 3 },
      logs: () => [transferEntry(TXID_2, AMOUNT)],
      transactions: { [TXID_2.toLowerCase()]: bindingTx(TXID_2) },
    });
    const { deps } = flowDeps(stub.client);
    const outcome = await advanceTx(deps, base(SENDING));
    expect(outcome.record.phase).toBe("submitted");
    expect(outcome.record.hash).toBe(TXID_2);
  });

  test("first candidate does not bind; the second one does", async () => {
    const stub = makeFlowStub({
      count: { latest: 3 },
      logs: () => [transferEntry(TXID_1), transferEntry(TXID_2)],
      transactions: {
        // Contract-creation tx: `to: null` never binds.
        [TXID_1.toLowerCase()]: { ...bindingTx(TXID_1), to: null },
        [TXID_2.toLowerCase()]: bindingTx(TXID_2),
      },
    });
    const { deps } = flowDeps(stub.client);
    const outcome = await advanceTx(deps, base(SENDING, { evidence: TOKEN_EVIDENCE }));
    expect(outcome.record.phase).toBe("submitted");
    expect(outcome.record.hash).toBe(TXID_2);
  });

  test("erc20 Approval evidence decodes and binds a replacement", async () => {
    const stub = makeFlowStub({
      count: { latest: 3 },
      logs: () => [
        // A pending log's null transactionHash is skipped before binding.
        erc20Log({ eventName: "Approval", transactionHash: null }),
        erc20Log({ eventName: "Approval", transactionHash: TXID_3 }),
      ],
      transactions: { [TXID_3.toLowerCase()]: bindingTx(TXID_3) },
    });
    const { deps } = flowDeps(stub.client);
    const outcome = await advanceTx(deps, base(SENDING, { evidence: ERC20_EVIDENCE }));
    expect(outcome.record.phase).toBe("submitted");
    expect(outcome.record.hash).toBe(TXID_3);
  });

  test("erc20 evidence with malformed logs ⇒ malformed-log", async () => {
    const cases: ReadonlyArray<Record<string, unknown>> = [
      logPayload({
        address: C.usdc,
        topics: [],
        data: "0x",
        blockNumber: B,
        transactionHash: TXID_1,
      }),
      logPayload({
        address: C.usdc,
        topics: [`0x${"ee".repeat(32)}`],
        data: "0x",
        blockNumber: B,
        transactionHash: TXID_1,
      }),
      erc20Log({ eventName: "Transfer", transactionHash: TXID_1 }),
    ];
    const codes = await Promise.all(
      cases.map(async (log) => {
        const stub = makeFlowStub({ count: { latest: 3 }, logs: () => [log] });
        const { deps } = flowDeps(stub.client);
        const error = await expectErrorAsync(
          async () => advanceTx(deps, base(SENDING, { evidence: ERC20_EVIDENCE })),
          "malformed-log",
        );
        return error.code;
      }),
    );
    expect(codes).toStrictEqual(["malformed-log", "malformed-log", "malformed-log"]);
  });
});

/** A Transfer(owner → RECIPIENT, amount) log on the token proxy. */
function transferEntry(transactionHash: Hash, amount = AMOUNT + 1n): Record<string, unknown> {
  return logPayload({
    address: TOKEN,
    topics: [TRANSFER_TOPIC, addressTopic(OWNER), addressTopic(RECIPIENT)],
    data: word(amount),
    blockNumber: B,
    transactionHash,
  });
}
