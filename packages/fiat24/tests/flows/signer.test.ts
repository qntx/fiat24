import { encodeFunctionData, getAddress } from "viem";
import type { Address, Hash } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import { Fiat24Error } from "../../src/core/errors.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceTransfer, startTransfer } from "../../src/flows/index.ts";
import type { TransferState } from "../../src/flows/index.ts";
import { expectErrorAsync } from "../chain/stub.ts";
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
} from "./stub.ts";

const TOKEN = C.tokens.EUR24.proxy;

/** The calldata the flow rebuilds — identical to transferCall's output. */
function transferData(to: Address, amount: bigint) {
  return encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [to, amount] });
}

const DRAFT: TransferState = {
  flow: "transfer",
  version: 1,
  owner: getAddress(OWNER),
  txs: [],
  step: "draft",
  currency: "EUR24",
  amount: AMOUNT,
  to: { address: getAddress(RECIPIENT) },
};

describe("signer", () => {
  test("client without wallet actions suffices", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: transferCallTable({ rounds: 2 }),
      storage: honestStorage(),
      count: { pending: 5, latest: 5 },
      receipts: {
        [TXID_1]: receiptPayload({
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
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: TOKEN,
          input: transferData(RECIPIENT, AMOUNT),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const draft = startTransfer({
      owner: OWNER,
      currency: "EUR24",
      amount: AMOUNT,
      to: { address: RECIPIENT },
    });
    const ready = await advanceTransfer(deps, draft);
    expect(ready.step).toBe("ready");
    const submitted = await advanceTransfer(deps, ready);
    expect(submitted.step).toBe("tx");
    const confirmed = await advanceTransfer(deps, submitted);
    expect(confirmed.step).toBe("confirmed");
    expect(confirmed.txs[0]?.phase).toBe("confirmed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.nonce).toBe(5);
    expect(requests[0]?.chainId).toBe(42161);
    expect(requests[0]?.from).toBe(getAddress(OWNER));
    expect(requests[0]?.to).toBe(TOKEN);
    expect(requests[0]?.data).toBe(transferData(RECIPIENT, AMOUNT));
    expect(requests[0]?.value).toBe(0n);
    expect(requests[0]?.intent).toStrictEqual({
      kind: "transfer",
      currency: "EUR24",
      amount: AMOUNT,
      to: { address: getAddress(RECIPIENT) },
    });
  });

  test("every signer request carries chainId 42161", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: transferCallTable({}),
      storage: honestStorage(),
      count: { pending: 0 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const ready: TransferState = { ...DRAFT, step: "ready" };
    await advanceTransfer(deps, ready);
    expect(requests).toHaveLength(1);
    for (const request of requests) {
      expect(request.chainId).toBe(42161);
    }
  });

  test("signer address mismatch ⇒ invalid-argument", async () => {
    const { signer } = makeSigner(RECIPIENT);
    const stub = makeFlowStub({});
    const { deps } = flowDeps(stub.client, { signer });
    const error = await expectErrorAsync(
      async () => advanceTransfer(deps, DRAFT),
      "invalid-argument",
    );
    expect(error).toBeInstanceOf(Fiat24Error);
    expect(stub.requests).toHaveLength(0);
  });

  test("nonce passed to the signer", async () => {
    const hash: Hash = `0x${"cd".repeat(32)}`;
    const { signer, requests } = makeSigner(OWNER, async () => Promise.resolve(hash));
    const stub = makeFlowStub({
      calls: transferCallTable({}),
      storage: honestStorage(),
      count: { pending: 41 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const ready: TransferState = { ...DRAFT, step: "ready" };
    const next = await advanceTransfer(deps, ready);
    expect(requests[0]?.nonce).toBe(41);
    expect(next.txs[0]?.nonce).toBe(41);
    expect(next.txs[0]?.hash).toBe(hash);
  });
});
