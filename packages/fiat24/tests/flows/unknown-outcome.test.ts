import { encodeFunctionData, getAddress } from "viem";
import type { Address, Hash, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import { Fiat24Error } from "../../src/core/errors.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceTransfer } from "../../src/flows/index.ts";
import type { TransferState, TxRecord } from "../../src/flows/index.ts";
import {
  AMOUNT,
  B,
  flowDeps,
  honestStorage,
  makeFlowStub,
  makeSigner,
  OWNER,
  RECIPIENT,
  receiptPayload,
  transferCallTable,
  transferLog,
  txPayload,
  TXID_1,
  TXID_2,
} from "./stub.ts";

const TOKEN = C.tokens.EUR24.proxy;
const OWNER_CS = getAddress(OWNER);
const RECIPIENT_CS = getAddress(RECIPIENT);
const NONCE = 5;

function transferData(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [to, amount] });
}

const BASE = {
  flow: "transfer",
  version: 1,
  owner: OWNER_CS,
  currency: "EUR24",
  amount: AMOUNT,
  to: { address: RECIPIENT_CS },
} as const;

const READY: TransferState = { ...BASE, step: "ready", txs: [] };

const state = (record: TxRecord): TransferState => ({ ...BASE, step: "tx", txs: [record] });

const SENDING: TransferState = state({
  purpose: "main",
  phase: "sending",
  fromBlock: B,
  nonce: NONCE,
});
const UNKNOWN: TransferState = state({
  purpose: "main",
  phase: "unknown",
  fromBlock: B,
  nonce: NONCE,
  error: "unknown-outcome",
});
const SUBMITTED: TransferState = state({
  purpose: "main",
  phase: "submitted",
  fromBlock: B,
  nonce: NONCE,
  hash: TXID_1,
});

/** The ready-phase stub: honest deployment, live parties, the simulate call, pending nonce. */
function readyStub(opts: {
  readonly nonce?: number;
  readonly signer: ReturnType<typeof makeSigner>["signer"];
  readonly persist?: (state: TransferState extends never ? never : unknown) => Promise<void> | void;
}) {
  const stub = makeFlowStub({
    calls: transferCallTable({}),
    storage: honestStorage(),
    count: { pending: opts.nonce ?? NONCE },
  });
  const { deps, persisted } = flowDeps(stub.client, {
    signer: opts.signer,
    ...(opts.persist === undefined ? {} : { persist: opts.persist }),
  });
  return { stub, deps, persisted };
}

/** A persist hook that throws `error` on call `failAt`; keeps test bodies branch-free. */
function failingPersist(failAt: number, error: Error) {
  let calls = 0;
  return {
    calls: () => calls,
    persist: async () => {
      calls += 1;
      return calls === failAt ? Promise.reject(error) : Promise.resolve();
    },
  };
}

/** A candidate tx whose fields match the rebuilt call (nonce N, mined at B+1). */
function honestTx(hash: Hash, nonce = NONCE, blockNumber = B + 1n) {
  return txPayload({
    hash,
    from: OWNER,
    to: TOKEN,
    input: transferData(RECIPIENT, AMOUNT),
    value: 0n,
    nonce,
    blockNumber,
  });
}

describe("unknown outcome", () => {
  test("crash between persist and send", async () => {
    // A `sending` record means the signer was never reached; the nonce is still
    // unused at latest (L <= N) so the outcome is unknowable — never not-sent.
    const stub = makeFlowStub({ count: { latest: NONCE } });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceTransfer(deps, SENDING);
    expect(next.step).toBe("tx");
    expect(next.txs[0]).toStrictEqual({
      purpose: "main",
      phase: "unknown",
      fromBlock: B,
      nonce: NONCE,
      error: "unknown-outcome",
    });
    expect(persisted).toHaveLength(1);
    expect(stub.requests.some((r) => r.method === "eth_getLogs")).toBe(false);
  });

  test("signer throws non-rejection", async () => {
    const { signer, requests } = makeSigner(OWNER, async () =>
      Promise.reject(new Error("wallet blew up")),
    );
    const { deps, persisted } = readyStub({ signer });
    const next = await advanceTransfer(deps, READY);
    expect(next.step).toBe("tx");
    expect(next.txs[0]?.phase).toBe("unknown");
    expect(next.txs[0]?.error).toBe("unknown-outcome");
    expect(requests).toHaveLength(1);
    expect(persisted).toHaveLength(2);
  });

  test("replaced nonce ⇒ not-sent", async () => {
    // L > N (the nonce was consumed) but the evidence range holds nothing of ours.
    const stub = makeFlowStub({
      count: { latest: NONCE + 3 },
      logs: () => [],
    });
    const { deps } = flowDeps(stub.client);
    const next = await advanceTransfer(deps, SENDING);
    expect(next.step).toBe("not-sent");
    expect(next.txs[0]?.phase).toBe("not-sent");
    const logCalls = stub.requests.filter((r) => r.method === "eth_getLogs");
    expect(logCalls.length).toBeGreaterThan(0);
  });

  test("same transfer from another device is not evidence", async () => {
    // Identical Transfer event, identical call bytes — but nonce 9, not our 5.
    const stub = makeFlowStub({
      count: { latest: NONCE + 3 },
      logs: () => [
        transferLog({
          token: TOKEN,
          from: OWNER,
          to: RECIPIENT,
          amount: AMOUNT,
          blockNumber: B + 1n,
          transactionHash: TXID_2,
        }),
      ],
      transactions: { [TXID_2]: honestTx(TXID_2, NONCE + 4) },
    });
    const { deps } = flowDeps(stub.client);
    const next = await advanceTransfer(deps, UNKNOWN);
    expect(next.step).toBe("not-sent");
  });

  test("speed-up with identical bytes ⇒ submitted{other hash} ⇒ confirmed", async () => {
    const mined = honestTx(TXID_2);
    const stub = makeFlowStub({
      count: { latest: NONCE + 3 },
      logs: () => [
        transferLog({
          token: TOKEN,
          from: OWNER,
          to: RECIPIENT,
          amount: AMOUNT,
          blockNumber: B + 1n,
          transactionHash: TXID_2,
        }),
      ],
      transactions: { [TXID_2]: mined },
      receipts: {
        [TXID_2]: receiptPayload({
          transactionHash: TXID_2,
          blockNumber: B + 1n,
          status: "success",
          logs: [
            transferLog({
              token: TOKEN,
              from: OWNER,
              to: RECIPIENT,
              amount: AMOUNT,
              blockNumber: B + 1n,
              transactionHash: TXID_2,
            }),
          ],
        }),
      },
    });
    const { deps } = flowDeps(stub.client);
    const found = await advanceTransfer(deps, UNKNOWN);
    expect(found.step).toBe("tx");
    expect(found.txs[0]?.phase).toBe("submitted");
    expect(found.txs[0]?.hash).toBe(TXID_2);
    const confirmed = await advanceTransfer(deps, found);
    expect(confirmed.step).toBe("confirmed");
    expect(confirmed.txs[0]?.hash).toBe(TXID_2);
  });

  test("L <= N ⇒ never not-sent", async () => {
    // An unrelated transfer at a different nonce must not even be consulted:
    // with L <= N the nonce is provably unused, so the record stays unknown.
    const stub = makeFlowStub({
      count: { latest: NONCE },
      logs: () => {
        throw new Error("must not be called");
      },
      transactions: { [TXID_2]: honestTx(TXID_2, NONCE + 9) },
    });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceTransfer(deps, UNKNOWN);
    expect(next.txs[0]?.phase).toBe("unknown");
    expect(next.txs[0]?.error).toBe("unknown-outcome");
    expect(persisted).toHaveLength(1);
    expect(stub.requests.some((r) => r.method === "eth_getLogs")).toBe(false);
  });

  test("each of the five binding fields mismatching ⇒ not evidence", async () => {
    const mutations: Array<Record<string, unknown>> = [
      { from: RECIPIENT }, // from
      { to: RECIPIENT }, // to (not the call's contract)
      { input: transferData(RECIPIENT, AMOUNT + 1n) }, // input
      { value: 1n }, // value
      { nonce: NONCE + 1 }, // nonce
    ];
    await Promise.all(
      mutations.map(async (patch) => {
        const stub = makeFlowStub({
          count: { latest: NONCE + 3 },
          logs: () => [
            transferLog({
              token: TOKEN,
              from: OWNER,
              to: RECIPIENT,
              amount: AMOUNT,
              blockNumber: B + 1n,
              transactionHash: TXID_2,
            }),
          ],
          transactions: { [TXID_2]: { ...honestTx(TXID_2), ...patch } },
        });
        const { deps } = flowDeps(stub.client);
        const next = await advanceTransfer(deps, UNKNOWN);
        expect(next.step).toBe("not-sent");
      }),
    );
  });

  test("submitted receipt binding mismatch ⇒ unknown", async () => {
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
        }),
      },
      transactions: {
        [TXID_1]: { ...honestTx(TXID_1), input: transferData(RECIPIENT, AMOUNT + 1n) },
      },
    });
    const { deps } = flowDeps(stub.client);
    const next = await advanceTransfer(deps, SUBMITTED);
    expect(next.step).toBe("tx");
    expect(next.txs[0]?.phase).toBe("unknown");
    expect(next.txs[0]?.error).toBe("unknown-outcome");
    expect(next.txs[0]?.hash).toBe(TXID_1);
  });

  test("pending nonce mismatch ⇒ unknown", async () => {
    // No receipt yet, and the pending tx under our hash carries a different
    // nonce — the signer did not send what was asked.
    const stub = makeFlowStub({
      transactions: { [TXID_1]: { ...honestTx(TXID_1), nonce: NONCE + 1, blockNumber: null } },
    });
    const { deps } = flowDeps(stub.client);
    const next = await advanceTransfer(deps, SUBMITTED);
    expect(next.txs[0]?.phase).toBe("unknown");
    expect(next.txs[0]?.hash).toBe(TXID_1);
  });

  test("signer rejection variants return ready with signer-rejected", async () => {
    const rejections: ReadonlyArray<Error> = [
      new Fiat24Error("signer-rejected", "rejected"),
      Object.assign(new Error("denied"), { name: "UserRejectedRequestError" }),
      Object.assign(new Error("wrapped"), { cause: { code: 4001 } }),
    ];
    await Promise.all(
      rejections.map(async (thrown) => {
        const { signer } = makeSigner(OWNER, async () => Promise.reject(thrown));
        const { deps } = readyStub({ signer });
        const next = await advanceTransfer(deps, READY);
        expect(next.txs[0]).toStrictEqual({
          purpose: "main",
          phase: "ready",
          error: "signer-rejected",
        });
        expect(next.step).toBe("tx");
      }),
    );
  });

  test("signer resolving a non-hash ⇒ unknown", async () => {
    const { signer } = makeSigner(OWNER, async () => Promise.resolve<Hash>("0x1234"));
    const { deps } = readyStub({ signer });
    const next = await advanceTransfer(deps, READY);
    expect(next.txs[0]?.phase).toBe("unknown");
    expect(next.txs[0]?.error).toBe("unknown-outcome");
  });

  test("persist rejecting before send ⇒ signer never called", async () => {
    const sentinel = new Error("storage full");
    const { signer, requests } = makeSigner(OWNER);
    const { deps } = readyStub({
      signer,
      persist: async () => Promise.reject(sentinel),
    });
    let caught: unknown;
    try {
      await advanceTransfer(deps, READY);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(requests).toHaveLength(0);
  });

  test("persist rejecting after send ⇒ state still returned", async () => {
    const { signer } = makeSigner(OWNER);
    const storage = failingPersist(2, new Error("storage full"));
    const { deps, persisted } = readyStub({ signer, persist: storage.persist });
    const next = await advanceTransfer(deps, READY);
    expect(next.step).toBe("tx");
    expect(next.txs[0]?.phase).toBe("submitted");
    expect(storage.calls()).toBe(2);
    expect(persisted).toHaveLength(2);
  });
});
