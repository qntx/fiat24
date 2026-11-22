import { encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { depositAbi } from "../../src/abi/index.ts";
import { topic0Of } from "../../src/chain/context.ts";
import { Fiat24Error } from "../../src/core/errors.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceTopUp, startTopUp } from "../../src/flows/index.ts";
import type { TopUpState } from "../../src/flows/index.ts";
import type { CallEntry } from "../chain/stub.ts";
import { expectErrorAsync, THIRD } from "../chain/stub.ts";
import { throwsCode } from "../helpers.ts";
import {
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
const USDC = C.usdc;
const OWNER_CS = getAddress(OWNER);
const CRYPTO = "0x0000000000000000000000000000000000009105" as Address;

// Fixture quote: usdc 100000, fee 1000, usdcRate 10000 → o=9; rate 10968,
// spread 9950 → outputAmount = floor(9*10968/1e4*9950/1e4) = 8.
const USDC_AMOUNT = 100_000n;
const FEE = 1000n;
const MIN = 1000n;
const MAX = 1_000_000n;
const OUTPUT_AMOUNT = 8n;

const CHECK: TopUpState = {
  flow: "top-up",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "check",
  output: "EUR24",
  usdcAmount: USDC_AMOUNT,
};

const QUOTED: TopUpState = {
  ...CHECK,
  step: "quoted",
  quote: { input: USDC_AMOUNT, output: OUTPUT_AMOUNT, blockNumber: B },
};

const APPROVE_SUBMITTED: TopUpState = {
  ...QUOTED,
  step: "tx",
  txs: [{ purpose: "approve", phase: "submitted", fromBlock: B, nonce: 5, hash: TXID_1 }],
};

const MAIN_READY: TopUpState = {
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

function approveData(amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DEPOSIT, amount] });
}

function topUpData(): Hex {
  return encodeFunctionData({
    abi: depositAbi,
    functionName: "depositTokenViaUsdc",
    args: [USDC, EUR24, USDC_AMOUNT],
  });
}

function topUpLog(input: bigint, output: bigint, sender: Address = OWNER): Record<string, unknown> {
  return logPayload({
    address: DEPOSIT,
    topics: [topic0Of(depositAbi, "DepositedTokenViaUsd"), addressTopic(sender)],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [USDC, EUR24, input, output],
    ),
    blockNumber: B + 1n,
    transactionHash: TXID_1,
  });
}

type TableOpts = {
  readonly rounds?: number;
  readonly quotePaused?: boolean;
  readonly paused?: Readonly<Record<string, boolean>>;
  readonly usdcBalance?: bigint;
  readonly usdcAllowance?: bigint;
  readonly totalSupply?: bigint;
  readonly outputAllowed?: boolean;
  readonly rate?: bigint;
  readonly spread?: bigint;
  readonly usdcRate?: bigint;
  readonly fee?: bigint;
  readonly min?: bigint;
  readonly max?: bigint;
  readonly historic?: bigint;
};

/** Every read check/quoted-guards/approve-plan/send consumes, per round. */
function topUpTable(opts: TableOpts = {}): Map<string, CallEntry[]> {
  const rounds = opts.rounds ?? 1;
  const rate = opts.rate ?? 10_968n;
  const spread = opts.spread ?? 9950n;
  const usdcRate = opts.usdcRate ?? 10_000n;
  const fee = opts.fee ?? FEE;
  // quoteTopUp fixture math — the output leg is priced by the FRESH quote.
  const o = (((USDC_AMOUNT - fee) / 10_000n) * usdcRate) / 10_000n;
  const legOutput = (((o * rate) / 10_000n) * spread) / 10_000n;
  const ownerOf: CallEntry[] = [];
  const depositPausedQueue: CallEntry[] = [];
  const depositAvailPaused = opts.paused?.[DEPOSIT.toLowerCase()] ?? false;
  for (let i = 0; i < rounds; i += 1) {
    ownerOf.push({ args: [9105n], answer: { result: CRYPTO } });
    // `paused()` is read once by getTopUpQuote and again inside
    // getAvailability — same key, served in that order each round.
    depositPausedQueue.push({ answer: { result: opts.quotePaused ?? false } });
    depositPausedQueue.push({ answer: { result: depositAvailPaused } });
  }
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false }),
    new Map<string, CallEntry[]>([
      [
        `${DEPOSIT.toLowerCase()}:minUsdcDepositAmount`,
        [
          {
            answer: { result: opts.min ?? MIN },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:maxUsdcDepositAmount`,
        [
          {
            answer: { result: opts.max ?? MAX },
          },
        ],
      ],
      [
        `${ACCOUNT.toLowerCase()}:historicOwnership`,
        [
          {
            args: [OWNER],
            answer: { result: opts.historic ?? SENDER_ID },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:exchangeRates`,
        [
          {
            args: [USDC, USD24],
            answer: { result: usdcRate },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:getExchangeRate`,
        [
          {
            args: [USD24, EUR24],
            answer: { result: rate },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:getSpread`,
        [
          {
            args: [USD24, EUR24, false],
            answer: { result: spread },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:getFee`,
        [
          {
            args: [SENDER_ID, USDC_AMOUNT],
            answer: { result: fee },
          },
        ],
      ],
      [
        `${USDC.toLowerCase()}:balanceOf`,
        [
          {
            args: [OWNER],
            answer: { result: opts.usdcBalance ?? USDC_AMOUNT },
          },
        ],
      ],
      [
        `${USDC.toLowerCase()}:allowance`,
        [
          {
            args: [OWNER, DEPOSIT],
            answer: { result: opts.usdcAllowance ?? 0n },
          },
        ],
      ],
      [
        `${USDC.toLowerCase()}:totalSupply`,
        [
          {
            answer: { result: opts.totalSupply ?? 100_000_000n },
          },
        ],
      ],
      [
        `${EUR24.toLowerCase()}:tokenTransferAllowed`,
        [
          {
            args: [CRYPTO, OWNER, legOutput],
            answer: { result: opts.outputAllowed ?? true },
          },
        ],
      ],
      [
        `${USDC.toLowerCase()}:approve`,
        [
          {
            args: [DEPOSIT, USDC_AMOUNT],
            answer: { result: true },
          },
        ],
      ],
      [
        `${DEPOSIT.toLowerCase()}:depositTokenViaUsdc`,
        [
          {
            args: [USDC, EUR24, USDC_AMOUNT],
            answer: { raw: "0x" },
          },
        ],
      ],
      [`${ACCOUNT.toLowerCase()}:ownerOf`, ownerOf],
    ]),
  );
  table.set(`${DEPOSIT.toLowerCase()}:paused`, depositPausedQueue);
  return table;
}

describe("startTopUp", () => {
  test("validates via topUpCall and returns a check state", () => {
    const state = startTopUp({ owner: OWNER, output: "EUR24", usdcAmount: USDC_AMOUNT });
    expect(state).toStrictEqual(CHECK);
    expect(Object.isFrozen(state)).toBe(true);
  });

  test("refuses bad owner/currency/amount", () => {
    const attempts: ReadonlyArray<readonly [() => unknown, ReadonlySet<string>]> = [
      [
        () => startTopUp({ owner: "0x1234", output: "EUR24", usdcAmount: USDC_AMOUNT }),
        new Set(["invalid-address"]),
      ],
      [
        () => startTopUp({ owner: OWNER, output: "EUR24", usdcAmount: 0n }),
        new Set(["invalid-amount"]),
      ],
    ];
    const results = attempts.map(([attempt, codes]) => throwsCode(attempt, codes));
    expect(results.every(Boolean)).toBe(true);
  });
});

describe("advanceTopUp check", () => {
  test("happy path stores the quote and becomes quoted", async () => {
    const stub = makeFlowStub({ calls: topUpTable(), storage: honestStorage() });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceTopUp(deps, CHECK);
    expect(next.step).toBe("quoted");
    expect(next.quote).toStrictEqual({
      input: USDC_AMOUNT,
      output: OUTPUT_AMOUNT,
      blockNumber: B,
    });
    expect(persisted).toHaveLength(1);
  });

  test("each pause condition becomes a persisted terminal unavailable", async () => {
    const cases: ReadonlyArray<{
      readonly reason: string;
      readonly table: Map<string, CallEntry[]>;
    }> = [
      { reason: "deposit-paused", table: topUpTable({ quotePaused: true }) },
      {
        reason: "account-paused",
        table: topUpTable({ paused: { [ACCOUNT.toLowerCase()]: true } }),
      },
      {
        reason: "token-paused",
        table: topUpTable({ paused: { [USD24.toLowerCase()]: true } }),
      },
      {
        reason: "token-paused",
        table: topUpTable({ paused: { [EUR24.toLowerCase()]: true } }),
      },
    ];
    await Promise.all(
      cases.map(async ({ reason, table }) => {
        const stub = makeFlowStub({ calls: table, storage: honestStorage() });
        const { deps, persisted } = flowDeps(stub.client);
        const next = await advanceTopUp(deps, CHECK);
        expect(next.step).toBe("unavailable");
        expect(next.reason).toBe(reason);
        expect(next.txs).toHaveLength(0);
        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toStrictEqual(next);
        // Terminal: a second advance refuses with no I/O.
        const stub2 = makeFlowStub({});
        const { deps: deps2, persisted: persisted2 } = flowDeps(stub2.client);
        await expectErrorAsync(async () => advanceTopUp(deps2, next), "invalid-state");
        expect(stub2.requests).toHaveLength(0);
        expect(persisted2).toHaveLength(0);
      }),
    );
  });

  test("getTopUpQuote errors propagate", async () => {
    const cases: ReadonlyArray<{
      readonly code: string;
      readonly table: Map<string, CallEntry[]>;
    }> = [
      { code: "below-minimum", table: topUpTable({ min: USDC_AMOUNT + 1n }) },
      { code: "above-maximum", table: topUpTable({ max: USDC_AMOUNT - 1n }) },
      { code: "no-account", table: topUpTable({ historic: 0n }) },
    ];
    await Promise.all(
      cases.map(async ({ code, table }) => {
        const stub = makeFlowStub({ calls: table, storage: honestStorage() });
        const { deps, persisted } = flowDeps(stub.client);
        const error = await expectErrorAsync(async () => advanceTopUp(deps, CHECK), code);
        expect(error).toBeInstanceOf(Fiat24Error);
        expect(persisted).toHaveLength(0);
      }),
    );
  });

  test("insufficient USDC balance and output-leg refusal", async () => {
    const cases: ReadonlyArray<{
      readonly code: string;
      readonly table: Map<string, CallEntry[]>;
    }> = [
      { code: "insufficient-balance", table: topUpTable({ usdcBalance: USDC_AMOUNT - 1n }) },
      { code: "transfer-not-allowed", table: topUpTable({ outputAllowed: false }) },
    ];
    await Promise.all(
      cases.map(async ({ code, table }) => {
        const stub = makeFlowStub({ calls: table, storage: honestStorage() });
        const { deps } = flowDeps(stub.client);
        const error = await expectErrorAsync(async () => advanceTopUp(deps, CHECK), code);
        expect(error).toBeInstanceOf(Fiat24Error);
      }),
    );
  });
});

describe("advanceTopUp quoted → tx planning", () => {
  test("approve iff allowance < usdcAmount, amount exactly usdcAmount", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: topUpTable({ usdcAllowance: 0n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceTopUp(deps, QUOTED);
    expect(next.txs[0]?.purpose).toBe("approve");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.to).toBe(USDC);
    expect(requests[0]?.data).toBe(approveData(USDC_AMOUNT));
  });

  test("no approve when allowance covers the amount", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: topUpTable({ usdcAllowance: USDC_AMOUNT }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceTopUp(deps, QUOTED);
    expect(next.txs[0]?.purpose).toBe("main");
    expect(requests[0]?.to).toBe(DEPOSIT);
    expect(requests[0]?.data).toBe(topUpData());
  });

  test("supply bound on the approve ⇒ unlimited-approval", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: topUpTable({ usdcAllowance: 0n, totalSupply: USDC_AMOUNT - 1n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceTopUp(deps, QUOTED), "unlimited-approval");
    expect(requests).toHaveLength(0);
  });

  test("a pause inside the tx guard throws unavailable (no persisted state)", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: topUpTable({ usdcAllowance: 0n, quotePaused: true }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps, persisted } = flowDeps(stub.client, { signer });
    const error = await expectErrorAsync(async () => advanceTopUp(deps, QUOTED), "unavailable");
    expect(error.detail.reason).toBe("deposit-paused");
    expect(error.detail.contract).toBe("deposit");
    expect(requests).toHaveLength(0);
    // Thrown, not persisted — the persisted terminal comes only from `check`.
    expect(persisted.every((s) => s.step !== "unavailable")).toBe(true);
  });
});

describe("advanceTopUp tx records", () => {
  test("approve confirmed ⇒ main{ready} appended, not sent", async () => {
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
          to: USDC,
          input: approveData(USDC_AMOUNT),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceTopUp(deps, APPROVE_SUBMITTED);
    expect(next.step).toBe("tx");
    expect(next.txs[1]).toStrictEqual({ purpose: "main", phase: "ready" });
    expect(requests).toHaveLength(0);
  });

  test("insufficient-allowance at the main guard", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: topUpTable({ usdcAllowance: USDC_AMOUNT - 1n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceTopUp(deps, MAIN_READY), "insufficient-allowance");
    expect(requests).toHaveLength(0);
  });

  test("quote-changed: fresh output below the stored quote", async () => {
    const { signer, requests } = makeSigner(OWNER);
    // rate 5000 → fresh output 3 < stored 8.
    const stub = makeFlowStub({
      calls: topUpTable({ usdcAllowance: USDC_AMOUNT, rate: 5000n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceTopUp(deps, MAIN_READY), "quote-changed");
    expect(requests).toHaveLength(0);
  });

  test("actual extracted from the matching top-up event", async () => {
    const mainSubmitted: TopUpState = {
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
        { purpose: "main", phase: "submitted", fromBlock: B, nonce: 6, hash: TXID_1 },
      ],
    };
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [topUpLog(USDC_AMOUNT, 9n)],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: DEPOSIT,
          input: topUpData(),
          value: 0n,
          nonce: 6,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceTopUp(deps, mainSubmitted);
    expect(next.step).toBe("confirmed");
    expect(next.actual).toStrictEqual({ input: USDC_AMOUNT, output: 9n });
    expect(persisted).toHaveLength(1);
  });

  test("missing top-up event ⇒ invalid-rpc-response, no transition", async () => {
    const mainSubmitted: TopUpState = {
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
        { purpose: "main", phase: "submitted", fromBlock: B, nonce: 6, hash: TXID_1 },
      ],
    };
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [topUpLog(USDC_AMOUNT, 9n, THIRD)],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: DEPOSIT,
          input: topUpData(),
          value: 0n,
          nonce: 6,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    await expectErrorAsync(async () => advanceTopUp(deps, mainSubmitted), "invalid-rpc-response");
    expect(persisted).toHaveLength(0);
  });

  test("confirmed re-checks the receipt — actual re-derived equal ⇒ the same state", async () => {
    const confirmed: TopUpState = {
      ...QUOTED,
      step: "confirmed",
      actual: { input: USDC_AMOUNT, output: OUTPUT_AMOUNT },
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
          logs: [topUpLog(USDC_AMOUNT, OUTPUT_AMOUNT)],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: DEPOSIT,
          input: topUpData(),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceTopUp(deps, confirmed);
    expect(next).toStrictEqual(confirmed);
    expect(persisted).toStrictEqual([next]);
  });

  test("confirmed re-check: a different receipt actual ⇒ invalid-state", async () => {
    const confirmed: TopUpState = {
      ...QUOTED,
      step: "confirmed",
      actual: { input: USDC_AMOUNT, output: OUTPUT_AMOUNT },
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
          logs: [topUpLog(USDC_AMOUNT, 9n)],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: DEPOSIT,
          input: topUpData(),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    await expectErrorAsync(async () => advanceTopUp(deps, confirmed), "invalid-state");
    expect(persisted).toHaveLength(0);
  });

  test("confirmed re-check: receipt and tx gone, nonce consumed ⇒ back to tx{unknown}", async () => {
    const confirmed: TopUpState = {
      ...QUOTED,
      step: "confirmed",
      actual: { input: USDC_AMOUNT, output: OUTPUT_AMOUNT },
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
    const next = await advanceTopUp(deps, confirmed);
    expect(next.step).toBe("tx");
    expect(next.actual).toBeUndefined();
    expect(next.txs.at(-1)?.phase).toBe("unknown");
  });
});

describe("advanceTopUp drift before guard reads", () => {
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
  const USDC_SLOT = "0xd0" as Hex;

  test("check ⇒ contract-changed before any guard read", async () => {
    const storage = honestStorage();
    storage.set(`${USD24.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(THIRD));
    const stub = makeFlowStub({ calls: proxyAdminEntry(), storage });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceTopUp(deps, CHECK), "contract-changed");
    expect(error.detail).toMatchObject({ contract: "USD24", field: "implementation" });
    expect(guardCalls(stub)).toStrictEqual([]);
  });

  test("quoted planning ⇒ contract-changed before any guard read", async () => {
    const storage = honestStorage();
    storage.set(`${DEPOSIT.toLowerCase()}:${USDC_SLOT}`, wordWithAddress(THIRD));
    const stub = makeFlowStub({ calls: proxyAdminEntry(), storage });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceTopUp(deps, QUOTED),
      "contract-changed",
    );
    expect(error.detail).toMatchObject({ contract: "deposit", field: "usdc" });
    expect(guardCalls(stub)).toStrictEqual([]);
  });
});
