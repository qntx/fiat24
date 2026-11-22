import { encodeFunctionData, getAddress, zeroAddress, encodeErrorResult } from "viem";
import type { Address, Hash, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import { Fiat24Error } from "../../src/core/errors.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceTransfer, startTransfer } from "../../src/flows/index.ts";
import type { TransferState } from "../../src/flows/index.ts";
import type { CallEntry } from "../chain/stub.ts";
import { expectErrorAsync } from "../chain/stub.ts";
import { throwsCode } from "../helpers.ts";
import type { PartyOpts } from "./stub.ts";
import {
  accountEntries,
  AMOUNT,
  availabilityEntries,
  B,
  balanceEntries,
  flowDeps,
  guardCalls,
  honestStorage,
  interleaveCalls,
  makeFlowStub,
  makeSigner,
  mergeCalls,
  OWNER,
  proxyAdminEntry,
  RECIPIENT,
  receiptPayload,
  SENDER_ID,
  RECEIVER_ID,
  transferCallTable,
  transferLog,
  txPayload,
  TXID_1,
  wordWithAddress,
} from "./stub.ts";

const TOKEN = C.tokens.EUR24.proxy;
const ACCOUNT = C.account.proxy;
const OWNER_CS = getAddress(OWNER);
const RECIPIENT_CS = getAddress(RECIPIENT);

function errorString(text: string): Hex {
  return encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }] as const,
    errorName: "Error",
    args: [text],
  });
}

const DRAFT: TransferState = {
  flow: "transfer",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "draft",
  currency: "EUR24",
  amount: AMOUNT,
  to: { address: RECIPIENT_CS },
};

const READY: TransferState = { ...DRAFT, step: "ready" };

const SUBMITTED: TransferState = {
  ...DRAFT,
  step: "tx",
  txs: [{ purpose: "main", phase: "submitted", fromBlock: B, nonce: 5, hash: TXID_1 }],
};

function transferData(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [to, amount] });
}

describe("startTransfer", () => {
  test("validates inputs and returns a draft with no transactions", () => {
    const draft = startTransfer({
      owner: OWNER,
      currency: "EUR24",
      amount: AMOUNT,
      to: { address: RECIPIENT },
    });
    expect(draft).toStrictEqual(DRAFT);
    expect(Object.isFrozen(draft)).toBe(true);
  });

  test("refuses a recipient equal to the owner and a bad recipient shape", () => {
    const attempts: ReadonlyArray<readonly [() => unknown, ReadonlySet<string>]> = [
      [
        () =>
          startTransfer({
            owner: OWNER,
            currency: "EUR24",
            amount: AMOUNT,
            to: { address: OWNER },
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () =>
          startTransfer({
            owner: OWNER,
            currency: "EUR24",
            amount: AMOUNT,
            to: { address: RECIPIENT, tokenId: 402001n },
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () =>
          startTransfer({
            owner: OWNER,
            currency: "EUR24",
            amount: AMOUNT,
            to: {} as never,
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () =>
          startTransfer({
            owner: "0x1234",
            currency: "EUR24",
            amount: AMOUNT,
            to: { address: RECIPIENT },
          }),
        new Set(["invalid-address"]),
      ],
      // Internal desks are refused by the tokenId builder (I12).
      [
        () =>
          startTransfer({
            owner: OWNER,
            currency: "EUR24",
            amount: AMOUNT,
            to: { tokenId: 9102n },
          }),
        new Set(["internal-account"]),
      ],
    ];
    const results = attempts.map(([attempt, codes]) => throwsCode(attempt, codes));
    expect(results.every(Boolean)).toBe(true);
  });
});

/** The call table a refusal case needs — built here so test bodies stay branch-free. */
function refusalTable(opts: {
  readonly sender?: PartyOpts;
  readonly receiver?: PartyOpts;
  readonly allowed?: boolean;
  readonly balance?: bigint;
}): Map<string, CallEntry[]> {
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({}),
    interleaveCalls(
      accountEntries(OWNER, { historic: SENDER_ID, ...opts.sender }),
      accountEntries(RECIPIENT, { historic: RECEIVER_ID, ...opts.receiver }),
    ),
    balanceEntries(OWNER),
    new Map([
      [
        `${TOKEN.toLowerCase()}:tokenTransferAllowed`,
        [{ args: [OWNER, RECIPIENT, AMOUNT], answer: { result: opts.allowed ?? true } }],
      ],
      [`${TOKEN.toLowerCase()}:convertToChf`, [{ args: [AMOUNT], answer: { result: AMOUNT } }]],
      [
        `${ACCOUNT.toLowerCase()}:checkLimit`,
        [{ args: [SENDER_ID, AMOUNT], answer: { result: true } }],
      ],
    ]),
  );
  if (opts.balance !== undefined) {
    table.set(`${TOKEN.toLowerCase()}:balanceOf`, [
      { args: [OWNER], answer: { result: opts.balance } },
    ]);
  }
  return table;
}

describe("advanceTransfer guards", () => {
  const guardStub = (opts: NonNullable<Parameters<typeof transferCallTable>[0]>) =>
    makeFlowStub({ calls: transferCallTable(opts), storage: honestStorage() });

  test("checkTransfer refusals surface unchanged", async () => {
    const cases: ReadonlyArray<{
      readonly code: string;
      readonly table: Map<string, CallEntry[]>;
    }> = [
      // sender resolves to nothing (no historic, no balance).
      { code: "no-account", table: refusalTable({ sender: { historic: 0n, balance: 0n } }) },
      // recipient resolves to an internal desk's token.
      { code: "internal-account", table: refusalTable({ receiver: { historic: 9102n } }) },
      // recipient resolved via historicOwnership but the NFT moved.
      { code: "stale-recipient", table: refusalTable({ receiver: { owner: zeroAddress } }) },
      // recipient exists but is blocked.
      { code: "recipient-not-live", table: refusalTable({ receiver: { statusIndex: 3 } }) },
      // balance below the amount.
      { code: "insufficient-balance", table: refusalTable({ balance: AMOUNT - 1n }) },
      // contract verdict false, within limit ⇒ plain not-allowed.
      { code: "transfer-not-allowed", table: refusalTable({ allowed: false }) },
    ];
    await Promise.all(
      cases.map(async ({ code, table }) => {
        const stub = makeFlowStub({ calls: table, storage: honestStorage() });
        const { deps, persisted } = flowDeps(stub.client);
        const error = await expectErrorAsync(async () => advanceTransfer(deps, DRAFT), code);
        expect(error).toBeInstanceOf(Fiat24Error);
        expect(persisted).toHaveLength(0);
      }),
    );
  });

  test("tokenTransferAllowed=false + checkLimit false ⇒ limit-exceeded", async () => {
    const table = mergeCalls(
      proxyAdminEntry(),
      availabilityEntries({}),
      interleaveCalls(
        accountEntries(OWNER, { historic: SENDER_ID }),
        accountEntries(RECIPIENT, { historic: RECEIVER_ID }),
      ),
      balanceEntries(OWNER),
      new Map([
        [
          `${TOKEN.toLowerCase()}:tokenTransferAllowed`,
          [{ args: [OWNER, RECIPIENT, AMOUNT], answer: { result: false } }],
        ],
        [`${TOKEN.toLowerCase()}:convertToChf`, [{ args: [AMOUNT], answer: { result: AMOUNT } }]],
        [
          `${ACCOUNT.toLowerCase()}:checkLimit`,
          [{ args: [SENDER_ID, AMOUNT], answer: { result: false } }],
        ],
      ]),
    );
    const stub = makeFlowStub({ calls: table, storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceTransfer(deps, DRAFT),
      "limit-exceeded",
    );
    expect(error).toBeInstanceOf(Fiat24Error);
  });

  test("paused token ⇒ unavailable with token-paused", async () => {
    const stub = guardStub({ paused: { [TOKEN.toLowerCase()]: true } });
    const { deps, persisted } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceTransfer(deps, DRAFT), "unavailable");
    expect(error.detail.reason).toBe("token-paused");
    expect(error.detail.contract).toBe("EUR24");
    expect(persisted).toHaveLength(0);
  });

  test("paused account ⇒ unavailable with account-paused", async () => {
    const stub = guardStub({ paused: { [ACCOUNT.toLowerCase()]: true } });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceTransfer(deps, DRAFT), "unavailable");
    expect(error.detail.reason).toBe("account-paused");
    expect(error.detail.contract).toBe("account");
  });

  test("recipient resolving to the owner ⇒ invalid-argument", async () => {
    // to:{tokenId} whose ownerOf resolves back to the sender's address.
    const tokenIdRecipient: TransferState = {
      ...DRAFT,
      to: { tokenId: RECEIVER_ID },
    };
    // exists/ownerOf(RECEIVER_ID) run first (checkTransfer step 1); both
    // parties then resolve as OWNER, so every account round key is read twice.
    const table = mergeCalls(
      proxyAdminEntry(),
      availabilityEntries({}),
      balanceEntries(OWNER),
      new Map<string, Array<{ args?: ReadonlyArray<unknown>; answer: { result: unknown } }>>([
        [
          `${ACCOUNT.toLowerCase()}:exists`,
          [
            { args: [RECEIVER_ID], answer: { result: true } },
            { args: [SENDER_ID], answer: { result: true } },
            { args: [SENDER_ID], answer: { result: true } },
          ],
        ],
        [
          `${ACCOUNT.toLowerCase()}:ownerOf`,
          [
            { args: [RECEIVER_ID], answer: { result: OWNER } },
            { args: [SENDER_ID], answer: { result: OWNER } },
            { args: [SENDER_ID], answer: { result: OWNER } },
          ],
        ],
        [
          `${ACCOUNT.toLowerCase()}:historicOwnership`,
          [
            { args: [OWNER], answer: { result: SENDER_ID } },
            { args: [OWNER], answer: { result: SENDER_ID } },
          ],
        ],
        [
          `${ACCOUNT.toLowerCase()}:balanceOf`,
          [
            { args: [OWNER], answer: { result: 1n } },
            { args: [OWNER], answer: { result: 1n } },
          ],
        ],
        [
          `${ACCOUNT.toLowerCase()}:status`,
          [
            { args: [SENDER_ID], answer: { result: 5 } },
            { args: [SENDER_ID], answer: { result: 5 } },
          ],
        ],
        [
          `${ACCOUNT.toLowerCase()}:limit`,
          [
            { args: [SENDER_ID], answer: { result: [0n, 10_000n, 0n] } },
            { args: [SENDER_ID], answer: { result: [0n, 10_000n, 0n] } },
          ],
        ],
        [
          `${ACCOUNT.toLowerCase()}:limitTourist`,
          [{ answer: { result: 400n } }, { answer: { result: 400n } }],
        ],
        [
          `${ACCOUNT.toLowerCase()}:walletProvider`,
          [
            { args: [SENDER_ID], answer: { result: 0n } },
            { args: [SENDER_ID], answer: { result: 0n } },
          ],
        ],
        [
          `${ACCOUNT.toLowerCase()}:getApproved`,
          [
            { args: [SENDER_ID], answer: { result: zeroAddress } },
            { args: [SENDER_ID], answer: { result: zeroAddress } },
          ],
        ],
        [
          `${TOKEN.toLowerCase()}:tokenTransferAllowed`,
          [{ args: [OWNER, OWNER, AMOUNT], answer: { result: true } }],
        ],
      ]),
    );
    const stub = makeFlowStub({ calls: table, storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceTransfer(deps, tokenIdRecipient),
      "invalid-argument",
    );
    expect(error).toBeInstanceOf(Fiat24Error);
  });
});

describe("advanceTransfer send path", () => {
  test("deployment drift ⇒ contract-changed and signer is not called", async () => {
    const storage = honestStorage();
    const impl = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
    storage.set(`${TOKEN.toLowerCase()}:${impl}`, wordWithAddress(RECIPIENT));
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: transferCallTable({}),
      storage,
      count: { pending: 5 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceTransfer(deps, READY), "contract-changed");
    expect(requests).toHaveLength(0);
  });

  test("simulation revert maps through §6.3", async () => {
    const stub = makeFlowStub({
      calls: transferCallTable({
        transferAnswer: {
          revert: errorString("Fiat24Token: all account transfers are paused"),
        },
      }),
      storage: honestStorage(),
      count: { pending: 5 },
    });
    const { signer } = makeSigner(OWNER);
    const { deps, persisted } = flowDeps(stub.client, { signer });
    const error = await expectErrorAsync(async () => advanceTransfer(deps, READY), "unavailable");
    expect(error.detail.reason).toBe("account-paused");
    // The sending record is persisted only after the simulation passes.
    expect(persisted).toHaveLength(0);
  });

  test("confirmed path: submitted receipt + bound tx + transfer log ⇒ confirmed", async () => {
    const stub = makeFlowStub({
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
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceTransfer(deps, SUBMITTED);
    expect(next.step).toBe("confirmed");
    expect(next.txs[0]).toStrictEqual({
      purpose: "main",
      phase: "confirmed",
      fromBlock: B,
      nonce: 5,
      hash: TXID_1,
      blockNumber: B + 1n,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toStrictEqual(next);
  });

  test("reverted receipt ⇒ failed{tx-reverted}", async () => {
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "reverted",
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
    const { deps } = flowDeps(stub.client);
    const next = await advanceTransfer(deps, SUBMITTED);
    expect(next.step).toBe("failed");
    expect(next.txs[0]?.phase).toBe("failed");
    expect(next.txs[0]?.error).toBe("tx-reverted");
  });

  test("terminal advance ⇒ invalid-state with no I/O", async () => {
    const hash: Hash = `0x${"ef".repeat(32)}`;
    const terminals: ReadonlyArray<TransferState> = [
      {
        ...DRAFT,
        step: "confirmed",
        txs: [
          {
            purpose: "main",
            phase: "confirmed",
            fromBlock: B,
            nonce: 5,
            hash,
            blockNumber: B + 1n,
          },
        ],
      },
      {
        ...DRAFT,
        step: "failed",
        txs: [
          {
            purpose: "main",
            phase: "failed",
            fromBlock: B,
            nonce: 5,
            hash,
            blockNumber: B + 1n,
            error: "tx-reverted",
          },
        ],
      },
      {
        ...DRAFT,
        step: "not-sent",
        txs: [{ purpose: "main", phase: "not-sent", fromBlock: B, nonce: 5 }],
      },
    ];
    await Promise.all(
      terminals.map(async (terminal) => {
        const stub = makeFlowStub({});
        const { deps, persisted } = flowDeps(stub.client);
        const error = await expectErrorAsync(
          async () => advanceTransfer(deps, terminal),
          "invalid-state",
        );
        expect(error).toBeInstanceOf(Fiat24Error);
        expect(stub.requests).toHaveLength(0);
        expect(persisted).toHaveLength(0);
      }),
    );
  });
});

describe("advanceTransfer drift at the draft step", () => {
  test("impl drift ⇒ contract-changed before any guard read", async () => {
    const storage = honestStorage();
    const impl = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
    storage.set(`${TOKEN.toLowerCase()}:${impl}`, wordWithAddress(RECIPIENT));
    const stub = makeFlowStub({ calls: proxyAdminEntry(), storage });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceTransfer(deps, DRAFT),
      "contract-changed",
    );
    expect(error.detail).toMatchObject({ contract: "EUR24", field: "implementation" });
    expect(guardCalls(stub)).toStrictEqual([]);
  });
});
