import * as fc from "fast-check";
import { createPublicClient, custom } from "viem";
import { arbitrum } from "viem/chains";
import { describe, expect, test } from "vite-plus/test";

import { approveCall } from "../../src/calls/approve.ts";
import {
  getAccount,
  getAllowance,
  getAllowances,
  getAvailability,
  getBalances,
  getExchangeQuote,
  getHistory,
  getMintQuote,
  getPayoutMinimum,
  getPayoutSettlement,
  getTopUpQuote,
  assertDeployment,
  checkTransfer,
  mintPriceWei,
  quoteExchange,
  quoteTopUp,
  simulateCall,
  verifyDeployment,
} from "../../src/chain/index.ts";
import { isFiat24Error } from "../../src/core/index.ts";
import { B, OWNER, RECIPIENT } from "../chain/stub.ts";
import { okOrCode } from "../helpers.ts";

type AnyClient = ReturnType<typeof createPublicClient>;

const ZERO_WORD = `0x${"0".repeat(64)}`;

/**
 * Hostile response shapes: valid-but-wrong hex, truncated/oversized words, non-hex text, wrong JSON
 * types, and well-shaped-but-junk log objects. The chain layer must absorb all of them into a value
 * or a Fiat24Error — never a leaked TypeError/viem error.
 */
const word = fc.constantFrom(
  ZERO_WORD,
  `0x${"f".repeat(64)}`,
  `0x${"ab".repeat(32)}`,
  `0x${"1".repeat(64)}`,
);
const badHex = fc.constantFrom(
  "0x",
  "0x0",
  "0x1",
  "0x12",
  "0xzz",
  "0x123",
  "0X12",
  `0x${"0".repeat(63)}`,
);
const shapedLog = fc.record({
  address: fc.constantFrom(OWNER, RECIPIENT),
  topics: fc.array(word, { minLength: 0, maxLength: 4 }),
  data: badHex,
  blockNumber: fc.oneof(badHex, fc.constant(null)),
  transactionHash: fc.oneof(word, fc.constant(null)),
  logIndex: fc.oneof(badHex, fc.constant(null)),
});
const hostile = fc.oneof(
  word,
  badHex,
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.oneof(word, badHex, shapedLog, fc.constant(null)), { maxLength: 4 }),
  fc.record({ number: badHex, timestamp: badHex }),
);

/** A transport answering every JSON-RPC method from a fixed round-robin answer list. */
function hostileClient(answers: ReadonlyArray<{ throw: boolean; value: unknown }>): AnyClient {
  let index = 0;
  const request = async (): Promise<unknown> => {
    const next = answers[index % answers.length];
    index += 1;
    if (next === undefined) {
      return Promise.reject(new Error("exhausted"));
    }
    // Hostile transports reject with arbitrary values, not just Errors.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the hostile shape is the test
    return next.throw ? Promise.reject(next.value) : Promise.resolve(next.value);
  };
  return createPublicClient({
    chain: arbitrum,
    transport: custom({ request }, { retryCount: 0 }),
  });
}

/** A transport answering well-formed zero values: every read succeeds with 0/false. */
function zeroClient(): AnyClient {
  const handleRequest = ({ method, params }: { method: string; params?: unknown }): unknown => {
    if (method === "eth_blockNumber") {
      return `0x${B.toString(16)}`;
    }
    if (method === "eth_getBlockByNumber") {
      const [number] = params as [string, unknown];
      return {
        number,
        timestamp: `0x${B.toString(16)}`,
        hash: ZERO_WORD,
        parentHash: ZERO_WORD,
        nonce: "0x0000000000000000",
        sha3Uncles: ZERO_WORD,
        logsBloom: `0x${"0".repeat(512)}`,
        transactionsRoot: ZERO_WORD,
        stateRoot: ZERO_WORD,
        receiptsRoot: ZERO_WORD,
        miner: `0x${"0".repeat(40)}`,
        difficulty: "0x0",
        totalDifficulty: "0x0",
        extraData: "0x",
        size: "0x0",
        gasLimit: "0x0",
        gasUsed: "0x0",
        baseFeePerGas: "0x0",
        transactions: [],
        uncles: [],
        mixHash: ZERO_WORD,
      };
    }
    if (method === "eth_getLogs") {
      return [];
    }
    return ZERO_WORD;
  };
  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => Promise.resolve(handleRequest({ method, params }));
  return createPublicClient({
    chain: arbitrum,
    transport: custom({ request }, { retryCount: 0 }),
  });
}

const ALL_CHAIN_CODES = new Set([
  "unsupported-chain",
  "invalid-argument",
  "invalid-address",
  "invalid-account-id",
  "invalid-amount",
  "internal-account",
  "unsupported-currency",
  "invalid-rpc-response",
  "rpc-error",
  "contract-revert",
  "contract-changed",
  "no-account",
  "not-live",
  "recipient-not-live",
  "stale-recipient",
  "insufficient-balance",
  "insufficient-allowance",
  "below-minimum",
  "above-maximum",
  "limit-exceeded",
  "transfer-not-allowed",
  "unavailable",
  "address-ineligible",
  "account-id-taken",
  "malformed-log",
  "quote-changed",
]);

const SETTLED = Symbol("settled");

/**
 * Settles `run`, asserting the outcome is a value or a {@link Fiat24Error} with a known code — any
 * other throwable is a defect.
 */
async function settle(run: () => Promise<unknown>): Promise<void> {
  const outcome: unknown = await run().then(
    () => SETTLED,
    (error: unknown) => error,
  );
  const ok = outcome === SETTLED || (isFiat24Error(outcome) && ALL_CHAIN_CODES.has(outcome.code));
  if (!ok) {
    throw outcome;
  }
  expect(ok).toBe(true);
}

/** `settle` annotated with the action name so a defect names its call. */
async function settleTagged(name: string, run: () => Promise<unknown>): Promise<void> {
  return settle(run).catch((error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    throw Object.assign(err, { message: `${name}: ${err.message}` });
  });
}

function nonNegativeBigint(v: unknown): boolean {
  return typeof v === "bigint" && v >= 0n;
}

const BUILT = approveCall({ asset: "EUR24", spender: "card", amount: 1n });

/** Every chain action, driven with valid args — the hostile surface is the RPC side. */
function actionCalls(client: AnyClient): ReadonlyArray<readonly [string, () => Promise<unknown>]> {
  return [
    ["getAccount(owner)", async () => getAccount(client, { owner: OWNER, blockNumber: B })],
    ["getAccount(tokenId)", async () => getAccount(client, { tokenId: 350273n, blockNumber: B })],
    ["getBalances", async () => getBalances(client, { owner: OWNER, blockNumber: B })],
    [
      "getAllowance",
      async () =>
        getAllowance(client, {
          owner: OWNER,
          asset: "EUR24",
          spender: "card",
          blockNumber: B,
        }),
    ],
    ["getAllowances", async () => getAllowances(client, { owner: OWNER, blockNumber: B })],
    ["getAvailability", async () => getAvailability(client, { blockNumber: B })],
    ["verifyDeployment", async () => verifyDeployment(client, { blockNumber: B })],
    [
      "assertDeployment",
      async () => assertDeployment(client, { contracts: ["card"], blockNumber: B }),
    ],
    [
      "getExchangeQuote",
      async () =>
        getExchangeQuote(client, {
          side: "exact-in",
          from: "EUR24",
          to: "USD24",
          amount: 100n,
          blockNumber: B,
        }),
    ],
    [
      "getTopUpQuote",
      async () =>
        getTopUpQuote(client, {
          owner: OWNER,
          output: "EUR24",
          usdcAmount: 5_000_000n,
          blockNumber: B,
        }),
    ],
    [
      "checkTransfer",
      async () =>
        checkTransfer(client, {
          from: OWNER,
          to: { address: RECIPIENT },
          currency: "EUR24",
          amount: 100n,
          blockNumber: B,
        }),
    ],
    [
      "getPayoutMinimum",
      async () => getPayoutMinimum(client, { currency: "EUR24", blockNumber: B }),
    ],
    [
      "getPayoutSettlement",
      async () =>
        getPayoutSettlement(client, {
          currency: "EUR24",
          tokenId: 350273n,
          contactId: "CH",
          txid: "trx-1",
          fromBlock: B - 50n,
          chunkSize: 100n,
          blockNumber: B,
        }),
    ],
    ["getMintQuote", async () => getMintQuote(client, { tokenId: 402001n, blockNumber: B })],
    [
      "getHistory",
      async () =>
        getHistory(client, {
          owner: OWNER,
          tokenId: 350273n,
          fromBlock: B - 200n,
          toBlock: B - 1n,
          chunkSize: 50n,
          blockNumber: B,
        }),
    ],
    [
      "simulateCall",
      async () => simulateCall(client, { call: BUILT, from: OWNER, blockNumber: B }),
    ],
  ];
}

const answers = fc.array(fc.record({ throw: fc.boolean(), value: hostile }), {
  minLength: 20,
  maxLength: 60,
});

describe("chain actions under hostile RPC", () => {
  test("random answers and throws: every action returns or throws a Fiat24Error", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(answers, async (script) => {
          const client = hostileClient(script);
          await Promise.all(actionCalls(client).map(async ([, run]) => settle(run)));
        }),
        { numRuns: 30 },
      ),
    ).resolves.toBeUndefined();
  });

  test("zero answers everywhere: every action returns or throws a Fiat24Error", async () => {
    const client = zeroClient();
    const jobs = actionCalls(client).map(async ([name, run]) => settleTagged(name, run));
    await expect(Promise.all(jobs)).resolves.toHaveLength(jobs.length);
  });

  test("a fresh blockNumber under hostile answers still settles", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(answers, async (script) => {
          const client = hostileClient(script);
          await settle(async () => getBalances(client, { owner: OWNER }));
        }),
        { numRuns: 20 },
      ),
    ).resolves.toBeUndefined();
  });
});

const PURE_CODES = new Set(["invalid-argument", "invalid-amount", "below-minimum"]);

describe("pure quote functions under hostile args", () => {
  test("quoteExchange: bigint or Fiat24Error, never another throw", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constantFrom("exact-in", "exact-out"),
            fc.string(),
            fc.constant(null),
            fc.integer(),
          ),
          fc.oneof(fc.bigInt(), fc.anything()),
          fc.oneof(fc.bigInt(), fc.anything()),
          fc.oneof(fc.bigInt(), fc.anything()),
          (side, amount, rate, spread) =>
            okOrCode(
              () =>
                quoteExchange({
                  side: side as "exact-in",
                  amount: amount as bigint,
                  rate: rate as bigint,
                  spread: spread as bigint,
                }),
              PURE_CODES,
              nonNegativeBigint,
            ),
        ),
      ),
    ).not.toThrow();
  });

  test("quoteTopUp: bigint or Fiat24Error, never another throw", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.oneof(fc.bigInt(), fc.anything()),
          fc.oneof(fc.bigInt(), fc.anything()),
          fc.oneof(fc.bigInt(), fc.anything()),
          fc.oneof(fc.bigInt(), fc.anything()),
          fc.oneof(fc.bigInt(), fc.anything()),
          (usdcAmount, fee, usdcRate, rate, spread) =>
            okOrCode(
              () =>
                quoteTopUp({
                  usdcAmount: usdcAmount as bigint,
                  fee: fee as bigint,
                  usdcRate: usdcRate as bigint,
                  rate: rate as bigint,
                  spread: spread as bigint,
                }),
              PURE_CODES,
              nonNegativeBigint,
            ),
        ),
      ),
    ).not.toThrow();
  });

  test("mintPriceWei: bigint or invalid-argument, never another throw", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.oneof(fc.bigInt(), fc.anything()),
          fc.oneof(fc.bigInt(), fc.anything()),
          (price, quote) =>
            okOrCode(
              () =>
                mintPriceWei({
                  priceF24: price as bigint,
                  quotePerEther: quote as bigint,
                }),
              PURE_CODES,
              nonNegativeBigint,
            ),
        ),
      ),
    ).not.toThrow();
  });

  test("argument-field hostility on getHistory stays typed", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(
          fc.oneof(fc.bigInt(), fc.anything()),
          fc.oneof(fc.bigInt(), fc.anything()),
          fc.oneof(fc.bigInt(), fc.anything()),
          fc.oneof(fc.bigInt(), fc.anything()),
          async (tokenId, fromBlock, toBlock, chunkSize) => {
            const client = zeroClient();
            await settle(async () =>
              getHistory(client, {
                owner: OWNER,
                tokenId: tokenId as bigint,
                fromBlock: fromBlock as bigint,
                toBlock: toBlock as bigint,
                chunkSize: chunkSize as bigint,
                blockNumber: B,
              }),
            );
          },
        ),
        { numRuns: 30 },
      ),
    ).resolves.toBeUndefined();
  });

  test("checkTransfer absorbs any `to` shape into a value or Fiat24Error", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(fc.anything(), async (to) => {
          const client = zeroClient();
          await settle(async () =>
            checkTransfer(client, {
              from: OWNER,
              to: to as { address: `0x${string}` },
              currency: "EUR24",
              amount: 1n,
              blockNumber: B,
            }),
          );
        }),
        { numRuns: 40 },
      ),
    ).resolves.toBeUndefined();
  });

  test("simulateCall absorbs any `call` shape into a value or Fiat24Error", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(fc.anything(), async (built) => {
          const client = zeroClient();
          await settle(async () =>
            simulateCall(client, {
              call: built as typeof BUILT,
              from: OWNER,
              blockNumber: B,
            }),
          );
        }),
        { numRuns: 40 },
      ),
    ).resolves.toBeUndefined();
  });

  test("quoteExchange never returns a negative or NaN-ish result", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.constantFrom("exact-in", "exact-out"),
          fc.bigInt({ min: 0n, max: 10n ** 30n }),
          fc.bigInt({ min: 0n, max: 10n ** 10n }),
          fc.bigInt({ min: 0n, max: 10n ** 10n }),
          (side, amount, rate, spread) => {
            const out = quoteExchange({ side, amount, rate, spread });
            return out >= 0n;
          },
        ),
      ),
    ).not.toThrow();
  });
});
