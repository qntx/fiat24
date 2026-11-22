import { encodeAbiParameters, encodeFunctionData, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { depositAbi, tokenAbi } from "../../src/abi/index.ts";
import { topic0Of } from "../../src/chain/context.ts";
import { Fiat24Error } from "../../src/core/errors.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceExchange, startExchange } from "../../src/flows/index.ts";
import type { ExchangeState } from "../../src/flows/index.ts";
import type { CallEntry } from "../chain/stub.ts";
import { expectErrorAsync, THIRD } from "../chain/stub.ts";
import { throwsCode } from "../helpers.ts";
import {
  accountEntries,
  addressTopic,
  availabilityEntries,
  B,
  flowDeps,
  guardCalls,
  honestStorage,
  logPayload,
  makeFlowStub,
  makeSigner,
  mergeCalls,
  OWNER,
  proxyAdminEntry,
  receiptPayload,
  SENDER_ID,
  txPayload,
  TXID_1,
  wordWithAddress,
} from "./stub.ts";

const EUR24 = C.tokens.EUR24.proxy;
const USD24 = C.tokens.USD24.proxy;
const DEPOSIT = C.deposit.proxy;
const ACCOUNT = C.account.proxy;
const OWNER_CS = getAddress(OWNER);
// The internal desks resolved through ownerOf: 9100 = treasury, 9105 = crypto.
const TREASURY = "0x0000000000000000000000000000000000009100" as Address;
const CRYPTO = "0x0000000000000000000000000000000000009105" as Address;

const RATE = 10968n;
const SPREAD = 9950n;
// exact-in EUR24→USD24 amount=100: input=100, output=floor(100*10968/1e4*9950/1e4)=108.
const INPUT = 100n;
const OUTPUT = 108n;
// exact-out amount=105 with rate 9117: input=floor(105*9117/1e4*9950/1e4)=94.
const XO_AMOUNT = 105n;
const XO_INPUT = 94n;

const DRAFT: ExchangeState = {
  flow: "exchange",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "draft",
  side: "exact-in",
  from: "EUR24",
  to: "USD24",
  amount: INPUT,
};

const QUOTED: ExchangeState = {
  ...DRAFT,
  step: "quoted",
  quote: { input: INPUT, output: OUTPUT, rate: RATE, spread: SPREAD, blockNumber: B },
};

const XO_DRAFT: ExchangeState = {
  ...DRAFT,
  side: "exact-out",
  amount: XO_AMOUNT,
};

const XO_QUOTED: ExchangeState = {
  ...XO_DRAFT,
  step: "quoted",
  quote: {
    input: XO_INPUT,
    output: XO_AMOUNT,
    rate: 9117n,
    spread: SPREAD,
    blockNumber: B,
  },
};

const APPROVE_SUBMITTED: ExchangeState = {
  ...QUOTED,
  step: "tx",
  txs: [{ purpose: "approve", phase: "submitted", fromBlock: B, nonce: 5, hash: TXID_1 }],
};

const MAIN_READY: ExchangeState = {
  ...QUOTED,
  step: "tx",
  txs: [
    {
      purpose: "approve",
      phase: "confirmed",
      fromBlock: B,
      nonce: 5,
      hash: TXID_1,
    },
    { purpose: "main", phase: "ready" },
  ],
};

function approveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, amount] });
}

function exchangeData(): Hex {
  return encodeFunctionData({
    abi: depositAbi,
    functionName: "moneyExchangeExactIn",
    args: [EUR24, USD24, INPUT],
  });
}

function exchangeLog(
  input: bigint,
  output: bigint,
  sender: Address = OWNER,
): Record<string, unknown> {
  return logPayload({
    address: DEPOSIT,
    topics: [topic0Of(depositAbi, "MoneyExchangedExactIn"), addressTopic(sender)],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [EUR24, USD24, input, output],
    ),
    blockNumber: B + 1n,
    transactionHash: TXID_1,
  });
}

/**
 * Per-round `ownerOf` queue: senderLive resolves the owner first, then the guard reads
 * deskOwner(9100) and deskOwner(9105) in that order.
 */
function ownerOfQueue(rounds: number): CallEntry[] {
  const queue: CallEntry[] = [];
  for (let i = 0; i < rounds; i += 1) {
    queue.push({ args: [SENDER_ID], answer: { result: OWNER } });
    queue.push({ args: [9100n], answer: { result: TREASURY } });
    queue.push({ args: [9105n], answer: { result: CRYPTO } });
  }
  return queue;
}

type TableOpts = {
  readonly side?: "exact-in" | "exact-out";
  readonly rounds?: number;
  readonly balance?: bigint;
  readonly allowance?: bigint;
  readonly totalSupply?: bigint;
  readonly rate?: bigint;
  readonly inputAllowed?: boolean;
  readonly withinLimit?: boolean;
  readonly outputAllowed?: boolean;
  readonly statusIndex?: number;
  readonly historic?: bigint;
  readonly accountBalance?: bigint;
  readonly paused?: Readonly<Record<string, boolean>>;
};

/** Every read a quoted guard + approve plan + send consumes, per round. */
function exchangeTable(opts: TableOpts = {}): Map<string, CallEntry[]> {
  const side = opts.side ?? "exact-in";
  const rounds = opts.rounds ?? 1;
  const amount = side === "exact-in" ? INPUT : XO_AMOUNT;
  const input = side === "exact-in" ? amount : XO_INPUT;
  const rateToken = side === "exact-in" ? EUR24 : USD24;
  const spreadToken = side === "exact-in" ? USD24 : EUR24;
  const exactOut = side === "exact-out";
  // The tx guards re-quote at B — the leg amounts come from the FRESH quote,
  // not the stored one (quoteExchange math mirrored for the fixture).
  const freshRate = opts.rate ?? (exactOut ? 9117n : RATE);
  const freshResult = (((amount * freshRate) / 10_000n) * SPREAD) / 10_000n;
  const legInput = exactOut ? freshResult : amount;
  const legOutput = exactOut ? amount : freshResult;
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false }),
    accountEntries(OWNER, {
      historic: opts.historic ?? SENDER_ID,
      balance: opts.accountBalance ?? 1n,
      statusIndex: opts.statusIndex ?? 5,
      rounds,
    }),
    new Map<string, CallEntry[]>([
      [
        `${DEPOSIT.toLowerCase()}:getExchangeRate`,
        [
          {
            args: [rateToken, spreadToken],
            answer: { result: freshRate },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:getSpread`,
        [
          {
            args: [rateToken, spreadToken, exactOut],
            answer: { result: SPREAD },
          },
        ],
      ],
      [`${DEPOSIT.toLowerCase()}:marketClosed`, [{ answer: { result: false } }]],
      [
        `${EUR24.toLowerCase()}:balanceOf`,
        [
          {
            args: [OWNER],
            answer: { result: opts.balance ?? 1000n },
          },
        ],
      ],
      [
        `${EUR24.toLowerCase()}:allowance`,
        [
          {
            args: [OWNER, DEPOSIT],
            answer: { result: opts.allowance ?? 0n },
          },
        ],
      ],
      [
        `${EUR24.toLowerCase()}:tokenTransferAllowed`,
        [
          {
            args: [OWNER, TREASURY, legInput],
            answer: { result: opts.inputAllowed ?? true },
          },
        ],
      ],
      [
        `${EUR24.toLowerCase()}:convertToChf`,
        [
          {
            args: [legInput],
            answer: { result: legInput },
          },
        ],
      ],
      [
        `${ACCOUNT.toLowerCase()}:checkLimit`,
        [
          {
            args: [SENDER_ID, legInput],
            answer: { result: opts.withinLimit ?? true },
          },
        ],
      ],
      [
        `${USD24.toLowerCase()}:tokenTransferAllowed`,
        [
          {
            args: [CRYPTO, OWNER, legOutput],
            answer: { result: opts.outputAllowed ?? true },
          },
        ],
      ],
      [
        `${EUR24.toLowerCase()}:approve`,
        [
          {
            args: [DEPOSIT, input],
            answer: { result: true },
          },
        ],
      ],
      [
        `${EUR24.toLowerCase()}:totalSupply`,
        [
          {
            answer: { result: opts.totalSupply ?? 100_000n },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:moneyExchangeExactIn`,
        [
          {
            args: [EUR24, USD24, INPUT],
            answer: { raw: "0x" },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:moneyExchangeExactOut`,
        [
          {
            args: [EUR24, USD24, XO_AMOUNT],
            answer: { raw: "0x" },
          },
        ],
      ],
    ]),
  );
  // accountEntries contributes its own ownerOf entries; the desk reads must
  // interleave exactly (owner first, then 9100, then 9105, per guard round).
  table.set(`${ACCOUNT.toLowerCase()}:ownerOf`, ownerOfQueue(rounds));
  return table;
}

describe("startExchange", () => {
  test("validates via exchangeCall and returns a draft", () => {
    const draft = startExchange({
      owner: OWNER,
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: INPUT,
    });
    expect(draft).toStrictEqual(DRAFT);
    expect(Object.isFrozen(draft)).toBe(true);
  });

  test("refuses bad side, equal currencies and bad amounts", () => {
    const attempts: ReadonlyArray<readonly [() => unknown, ReadonlySet<string>]> = [
      [
        () =>
          startExchange({
            owner: OWNER,
            side: "exact-in",
            from: "EUR24",
            to: "EUR24",
            amount: INPUT,
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () =>
          startExchange({
            owner: OWNER,
            side: "exact-in",
            from: "EUR24",
            to: "USD24",
            amount: 0n,
          }),
        new Set(["invalid-amount"]),
      ],
      [
        () =>
          startExchange({
            owner: "0x1234",
            side: "exact-in",
            from: "EUR24",
            to: "USD24",
            amount: INPUT,
          }),
        new Set(["invalid-address"]),
      ],
    ];
    const results = attempts.map(([attempt, codes]) => throwsCode(attempt, codes));
    expect(results.every(Boolean)).toBe(true);
  });
});

describe("advanceExchange draft → quoted", () => {
  test("happy path stores the quote at the snapshot block", async () => {
    const stub = makeFlowStub({ calls: exchangeTable(), storage: honestStorage() });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceExchange(deps, DRAFT);
    expect(next.step).toBe("quoted");
    expect(next.quote).toStrictEqual({
      input: INPUT,
      output: OUTPUT,
      rate: RATE,
      spread: SPREAD,
      blockNumber: B,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toStrictEqual(next);
  });

  test("guard failures surface typed errors with no persist", async () => {
    const cases: ReadonlyArray<{
      readonly code: string;
      readonly table: Map<string, CallEntry[]>;
      readonly reason?: string;
    }> = [
      { code: "insufficient-balance", table: exchangeTable({ balance: INPUT - 1n }) },
      { code: "not-live", table: exchangeTable({ statusIndex: 3 }) },
      { code: "no-account", table: exchangeTable({ historic: 0n, accountBalance: 0n }) },
      { code: "limit-exceeded", table: exchangeTable({ inputAllowed: false, withinLimit: false }) },
      { code: "transfer-not-allowed", table: exchangeTable({ inputAllowed: false }) },
      { code: "transfer-not-allowed", table: exchangeTable({ outputAllowed: false }) },
      { code: "below-minimum", table: exchangeTable({ rate: 0n }) },
    ];
    await Promise.all(
      cases.map(async ({ code, table }) => {
        const stub = makeFlowStub({ calls: table, storage: honestStorage() });
        const { deps, persisted } = flowDeps(stub.client);
        const error = await expectErrorAsync(async () => advanceExchange(deps, DRAFT), code);
        expect(error).toBeInstanceOf(Fiat24Error);
        expect(persisted).toHaveLength(0);
      }),
    );
  });

  test("paused token ⇒ unavailable with token-paused", async () => {
    const table = exchangeTable({ paused: { [EUR24.toLowerCase()]: true } });
    const stub = makeFlowStub({ calls: table, storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceExchange(deps, DRAFT), "unavailable");
    expect(error.detail.reason).toBe("token-paused");
    expect(error.detail.contract).toBe("EUR24");
  });
});

describe("advanceExchange quoted → tx planning", () => {
  test("exact-in approve iff allowance < amount, amount exactly amount", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: exchangeTable({ allowance: 0n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps, persisted } = flowDeps(stub.client, { signer });
    const next = await advanceExchange(deps, QUOTED);
    expect(next.step).toBe("tx");
    expect(next.txs[0]).toStrictEqual({
      purpose: "approve",
      phase: "submitted",
      fromBlock: B,
      nonce: 7,
      hash: TXID_1,
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.to).toBe(EUR24);
    expect(request?.data).toBe(approveData(DEPOSIT, INPUT));
    expect(request?.nonce).toBe(7);
    expect(persisted.length).toBeGreaterThanOrEqual(2);
  });

  test("exact-in no approve when allowance >= amount", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: exchangeTable({ allowance: 500n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceExchange(deps, QUOTED);
    expect(next.txs[0]?.purpose).toBe("main");
    expect(requests[0]?.to).toBe(DEPOSIT);
    expect(requests[0]?.data).toBe(exchangeData());
  });

  test("exact-in allowance exactly amount sends the main, not a redundant approve", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: exchangeTable({ allowance: INPUT }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceExchange(deps, QUOTED);
    expect(next.txs[0]?.purpose).toBe("main");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.data).toBe(exchangeData());
  });

  test("exact-out re-approves down", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: exchangeTable({ side: "exact-out", allowance: 2n ** 256n - 1n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceExchange(deps, XO_QUOTED);
    expect(next.txs[0]?.purpose).toBe("approve");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.data).toBe(approveData(DEPOSIT, XO_INPUT));
  });

  test("supply bound on the approve ⇒ unlimited-approval, signer never called", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: exchangeTable({ allowance: 0n, totalSupply: INPUT - 1n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceExchange(deps, QUOTED), "unlimited-approval");
    expect(requests).toHaveLength(0);
  });
});

describe("advanceExchange tx records", () => {
  test("approve confirmed ⇒ main{ready} appended, main not sent", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: EUR24,
          input: approveData(DEPOSIT, INPUT),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceExchange(deps, APPROVE_SUBMITTED);
    expect(next.step).toBe("tx");
    expect(next.txs).toStrictEqual([
      {
        purpose: "approve",
        phase: "confirmed",
        fromBlock: B,
        nonce: 5,
        hash: TXID_1,
      },
      { purpose: "main", phase: "ready" },
    ]);
    expect(requests).toHaveLength(0);
  });

  test("main sends on the next advance after approve confirmed", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: exchangeTable({ allowance: 500n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceExchange(deps, MAIN_READY);
    expect(next.txs[1]?.phase).toBe("submitted");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.to).toBe(DEPOSIT);
    expect(requests[0]?.data).toBe(exchangeData());
  });

  test("approve failed ⇒ step failed", async () => {
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
          to: EUR24,
          input: approveData(DEPOSIT, INPUT),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps } = flowDeps(stub.client);
    const next = await advanceExchange(deps, APPROVE_SUBMITTED);
    expect(next.step).toBe("failed");
    expect(next.txs[0]?.error).toBe("tx-reverted");
  });

  test("quote-changed (exact-in): fresh output below the stored quote", async () => {
    const { signer, requests } = makeSigner(OWNER);
    // rate 9117 → fresh output floor(100*9117/1e4*9950/1e4)=90 < 108.
    const stub = makeFlowStub({
      calls: exchangeTable({ allowance: 500n, rate: 9117n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceExchange(deps, MAIN_READY), "quote-changed");
    expect(requests).toHaveLength(0);
  });

  test("quote-changed (exact-in): fresh output one below the stored quote (M48)", async () => {
    const { signer, requests } = makeSigner(OWNER);
    // rate 10850 → fresh output floor(floor(100*10850/1e4)*9950/1e4) = 107 = 108 − 1:
    // any drop, even a single unit, is a changed quote.
    const stub = makeFlowStub({
      calls: exchangeTable({ allowance: 500n, rate: 10850n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceExchange(deps, MAIN_READY), "quote-changed");
    expect(requests).toHaveLength(0);
  });

  test("quote-changed (exact-out): fresh input above the stored quote", async () => {
    const xoMainReady: ExchangeState = {
      ...XO_QUOTED,
      step: "tx",
      txs: [
        {
          purpose: "approve",
          phase: "confirmed",
          fromBlock: B,
          nonce: 5,
          hash: TXID_1,
        },
        { purpose: "main", phase: "ready" },
      ],
    };
    const { signer, requests } = makeSigner(OWNER);
    // rate 10968 → fresh input floor(105*10968/1e4*9950/1e4)=114 > 94.
    const stub = makeFlowStub({
      calls: exchangeTable({ side: "exact-out", allowance: XO_INPUT, rate: 10968n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceExchange(deps, xoMainReady), "quote-changed");
    expect(requests).toHaveLength(0);
  });

  test("quote-changed (exact-out): allowance above the quoted input", async () => {
    const xoMainReady: ExchangeState = {
      ...XO_QUOTED,
      step: "tx",
      txs: [
        {
          purpose: "approve",
          phase: "confirmed",
          fromBlock: B,
          nonce: 5,
          hash: TXID_1,
        },
        { purpose: "main", phase: "ready" },
      ],
    };
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: exchangeTable({ side: "exact-out", allowance: XO_INPUT + 1n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceExchange(deps, xoMainReady), "quote-changed");
    expect(requests).toHaveLength(0);
  });

  test("insufficient-allowance at the main guard", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: exchangeTable({ allowance: INPUT - 1n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceExchange(deps, MAIN_READY), "insufficient-allowance");
    expect(requests).toHaveLength(0);
  });

  test("actual extracted from the matching exchange event", async () => {
    const mainSubmitted: ExchangeState = {
      ...QUOTED,
      step: "tx",
      txs: [
        {
          purpose: "approve",
          phase: "confirmed",
          fromBlock: B,
          nonce: 5,
          hash: TXID_1,
        },
        {
          purpose: "main",
          phase: "submitted",
          fromBlock: B,
          nonce: 6,
          hash: TXID_1,
        },
      ],
    };
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [exchangeLog(INPUT, 110n)],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: DEPOSIT,
          input: exchangeData(),
          value: 0n,
          nonce: 6,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceExchange(deps, mainSubmitted);
    expect(next.step).toBe("confirmed");
    expect(next.actual).toStrictEqual({ input: INPUT, output: 110n });
    expect(next.txs[1]?.phase).toBe("confirmed");
    expect(persisted).toHaveLength(1);
  });

  test("missing exchange event ⇒ invalid-rpc-response, no transition", async () => {
    const mainSubmitted: ExchangeState = {
      ...QUOTED,
      step: "tx",
      txs: [
        {
          purpose: "approve",
          phase: "confirmed",
          fromBlock: B,
          nonce: 5,
          hash: TXID_1,
        },
        {
          purpose: "main",
          phase: "submitted",
          fromBlock: B,
          nonce: 6,
          hash: TXID_1,
        },
      ],
    };
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [exchangeLog(INPUT, 110n, THIRD)],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: DEPOSIT,
          input: exchangeData(),
          value: 0n,
          nonce: 6,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    await expectErrorAsync(
      async () => advanceExchange(deps, mainSubmitted),
      "invalid-rpc-response",
    );
    expect(persisted).toHaveLength(0);
  });

  test("confirmed re-checks the receipt — actual re-derived equal ⇒ the same state", async () => {
    const confirmed: ExchangeState = {
      ...QUOTED,
      step: "confirmed",
      actual: { input: INPUT, output: OUTPUT },
      txs: [
        {
          purpose: "main",
          phase: "confirmed",
          fromBlock: B,
          nonce: 5,
          hash: TXID_1,
        },
      ],
    };
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [exchangeLog(INPUT, OUTPUT)],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: DEPOSIT,
          input: exchangeData(),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceExchange(deps, confirmed);
    expect(next).toStrictEqual(confirmed);
    expect(persisted).toStrictEqual([next]);
  });

  test("confirmed re-check: a different receipt actual ⇒ invalid-state", async () => {
    const confirmed: ExchangeState = {
      ...QUOTED,
      step: "confirmed",
      actual: { input: INPUT, output: OUTPUT },
      txs: [
        {
          purpose: "main",
          phase: "confirmed",
          fromBlock: B,
          nonce: 5,
          hash: TXID_1,
        },
      ],
    };
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [exchangeLog(INPUT, 110n)],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: DEPOSIT,
          input: exchangeData(),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    await expectErrorAsync(async () => advanceExchange(deps, confirmed), "invalid-state");
    expect(persisted).toHaveLength(0);
  });

  test("confirmed re-check: receipt and tx gone, nonce consumed ⇒ back to tx{unknown}", async () => {
    const confirmed: ExchangeState = {
      ...QUOTED,
      step: "confirmed",
      actual: { input: INPUT, output: OUTPUT },
      txs: [
        {
          purpose: "main",
          phase: "confirmed",
          fromBlock: B,
          nonce: 5,
          hash: TXID_1,
        },
      ],
    };
    const stub = makeFlowStub({ count: { latest: 6 }, logs: () => [] });
    const { deps } = flowDeps(stub.client);
    const next = await advanceExchange(deps, confirmed);
    expect(next.step).toBe("tx");
    expect(next.actual).toBeUndefined();
    expect(next.txs.at(-1)).toStrictEqual({
      purpose: "main",
      phase: "unknown",
      fromBlock: B,
      nonce: 5,
      hash: TXID_1,
      error: "unknown-outcome",
    });
  });
});

describe("advanceExchange drift before guard reads", () => {
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
  const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;

  test("draft ⇒ contract-changed before any guard read", async () => {
    const storage = honestStorage();
    storage.set(`${DEPOSIT.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(THIRD));
    const stub = makeFlowStub({ calls: proxyAdminEntry(), storage });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceExchange(deps, DRAFT),
      "contract-changed",
    );
    expect(error.detail).toMatchObject({ contract: "deposit", field: "implementation" });
    expect(guardCalls(stub)).toStrictEqual([]);
  });

  test("quoted planning ⇒ contract-changed before any guard read", async () => {
    const storage = honestStorage();
    storage.set(`${USD24.toLowerCase()}:${ADMIN_SLOT}`, wordWithAddress(THIRD));
    const stub = makeFlowStub({ calls: proxyAdminEntry(), storage });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceExchange(deps, QUOTED),
      "contract-changed",
    );
    expect(error.detail).toMatchObject({ contract: "USD24", field: "admin" });
    expect(guardCalls(stub)).toStrictEqual([]);
  });
});
