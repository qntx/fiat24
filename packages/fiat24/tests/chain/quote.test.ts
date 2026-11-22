import { describe, expect, test } from "vite-plus/test";

import {
  getExchangeQuote,
  getTopUpQuote,
  quoteExchange,
  quoteTopUp,
} from "../../src/chain/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { expectError } from "../helpers.ts";
import { B, expectErrorAsync, makeStub, OWNER, wordWithAddress } from "./stub.ts";
import type { CallTable } from "./stub.ts";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

// SPEC §8.3 — the differential table verbatim (oracle: anvil eth_call at the pin).
const EXCHANGE_ROWS: ReadonlyArray<
  readonly ["exact-in" | "exact-out", bigint, bigint, bigint, bigint]
> = [
  ["exact-in", 1000n, 10968n, 9830n, 1077n],
  ["exact-in", 1n, 10968n, 9830n, 0n],
  ["exact-in", 12345n, 10968n, 9830n, 13308n],
  ["exact-in", 999n, 9213n, 9830n, 904n],
  ["exact-in", 5000n, 73233n, 9830n, 35993n],
  ["exact-in", 98692n, 1364n, 9830n, 13232n],
  ["exact-in", 7n, 1497n, 9830n, 0n],
  ["exact-out", 1000n, 9117n, 10172n, 926n],
  ["exact-out", 1n, 9117n, 10172n, 0n],
  ["exact-out", 12345n, 10852n, 10172n, 13626n],
  ["exact-out", 777n, 66770n, 10172n, 5277n],
  ["exact-out", 50000n, 1364n, 10172n, 6937n],
];

describe("quoteExchange (pure)", () => {
  test.each(EXCHANGE_ROWS)(
    "%s amount=%d rate=%d spread=%d ⇒ %d",
    (side, amount, rate, spread, expected) => {
      expect(
        quoteExchange({
          side,
          amount,
          rate,
          spread,
        }),
      ).toBe(expected);
    },
  );

  test("rejects a bad side, non-bigint and negative inputs", () => {
    expect.hasAssertions();
    expectError(
      () => quoteExchange({ side: "exact" as never, amount: 1n, rate: 1n, spread: 1n }),
      "invalid-argument",
    );
    expectError(
      () => quoteExchange({ side: "exact-in", amount: -1n, rate: 1n, spread: 1n }),
      "invalid-argument",
    );
    expectError(
      () =>
        quoteExchange({
          side: "exact-in",
          amount: 1 as unknown as bigint,
          rate: 1n,
          spread: 1n,
        }),
      "invalid-argument",
    );
  });
});

function exchangeCalls(rate: bigint, spread: bigint, marketClosed: boolean): CallTable {
  return new Map([
    [`${C.deposit.proxy.toLowerCase()}:getExchangeRate`, { answer: { result: rate } }],
    [`${C.deposit.proxy.toLowerCase()}:getSpread`, { answer: { result: spread } }],
    [`${C.deposit.proxy.toLowerCase()}:marketClosed`, { answer: { result: marketClosed } }],
  ]);
}

describe("getExchangeQuote", () => {
  test("exact-in reads (from,to) and reports input=amount, output=result", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: exchangeCalls(10968n, 9830n, false),
    });
    const quote = await getExchangeQuote(stub.client, {
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: 1000n,
      blockNumber: B,
    });
    expect(quote).toStrictEqual({
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      input: 1000n,
      output: 1077n,
      rate: 10968n,
      spread: 9830n,
      marketClosed: false,
      blockNumber: B,
    });
    const [rateCall, spreadCall] = stub.calls;
    expect(rateCall?.args).toStrictEqual([C.tokens.EUR24.proxy, C.tokens.USD24.proxy]);
    expect(spreadCall?.args).toStrictEqual([C.tokens.EUR24.proxy, C.tokens.USD24.proxy, false]);
  });

  test("exact-out reads the reverse pair with the reverse flag", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: exchangeCalls(9117n, 10172n, true),
    });
    const quote = await getExchangeQuote(stub.client, {
      side: "exact-out",
      from: "EUR24",
      to: "USD24",
      amount: 1000n,
      blockNumber: B,
    });
    expect(quote.input).toBe(926n);
    expect(quote.output).toBe(1000n);
    expect(quote.marketClosed).toBe(true);
    const [rateCall, spreadCall] = stub.calls;
    expect(rateCall?.args).toStrictEqual([C.tokens.USD24.proxy, C.tokens.EUR24.proxy]);
    expect(spreadCall?.args).toStrictEqual([C.tokens.USD24.proxy, C.tokens.EUR24.proxy, true]);
  });

  test("a zero result is below-minimum", async () => {
    expect.hasAssertions();
    const stub = makeStub({ blockNumber: B, calls: exchangeCalls(9830n, 9830n, false) });
    await expectErrorAsync(
      async () =>
        getExchangeQuote(stub.client, {
          side: "exact-in",
          from: "EUR24",
          to: "USD24",
          amount: 1n,
          blockNumber: B,
        }),
      "below-minimum",
    );
  });

  test("from === to and bad currencies reject before I/O", async () => {
    const stub = makeStub({ blockNumber: B, calls: exchangeCalls(1n, 1n, false) });
    await expectErrorAsync(
      async () =>
        getExchangeQuote(stub.client, {
          side: "exact-in",
          from: "EUR24",
          to: "EUR24",
          amount: 1n,
          blockNumber: B,
        }),
      "invalid-argument",
    );
    await expectErrorAsync(
      async () =>
        getExchangeQuote(stub.client, {
          side: "exact-in",
          from: "EUR24",
          to: "BTC" as never,
          amount: 1n,
          blockNumber: B,
        }),
      "unsupported-currency",
    );
    await expectErrorAsync(
      async () =>
        getExchangeQuote(stub.client, {
          side: "exact-in",
          from: "EUR24",
          to: "USD24",
          amount: 0n,
          blockNumber: B,
        }),
      "invalid-amount",
    );
    expect(stub.calls).toStrictEqual([]);
  });
});

describe("quoteTopUp (pure)", () => {
  // SPEC §8.3 top-up rows (fork differential): usdc 5000000 → USD24 495.
  test("the formula legs: fee skim → usdcRate → rate → spread", () => {
    // (5000000-50000)/10000 = 495 USD24; 495*10000/10000*10000/10000 = 495.
    expect(
      quoteTopUp({
        usdcAmount: 5_000_000n,
        fee: 50_000n,
        usdcRate: 10_000n,
        rate: 10_000n,
        spread: 10_000n,
      }),
    ).toBe(495n);
    // zero fee: o = (100000/10000)*10000/10000 = 10; (10*9000)/10000 = 9; 9*9000/10000 = 8.
    expect(
      quoteTopUp({
        usdcAmount: 100_000n,
        fee: 0n,
        usdcRate: 10_000n,
        rate: 9000n,
        spread: 9000n,
      }),
    ).toBe(8n);
  });

  test("rejects fee > usdcAmount and negative/bigint-less inputs", () => {
    expect.hasAssertions();
    expectError(
      () => quoteTopUp({ usdcAmount: 1n, fee: 2n, usdcRate: 1n, rate: 1n, spread: 1n }),
      "invalid-argument",
    );
    expectError(
      () => quoteTopUp({ usdcAmount: 1n, fee: -1n, usdcRate: 1n, rate: 1n, spread: 1n }),
      "invalid-argument",
    );
  });
});

/** Honest storage for topUpCall's assertDeployment path (deposit, account, output, USD24). */
function topUpStorage(output: "USD24" | "EUR24" | "CHF24" | "CNH24"): Map<string, `0x${string}`> {
  const table = new Map<string, `0x${string}`>();
  for (const pin of [C.deposit, C.account, C.tokens[output], C.tokens.USD24]) {
    table.set(`${pin.proxy.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(pin.implementation));
    table.set(`${pin.proxy.toLowerCase()}:${ADMIN_SLOT}`, wordWithAddress(pin.admin));
  }
  const priceList = C.priceList.proxy.toLowerCase().slice(2);
  table.set(`${C.account.proxy.toLowerCase()}:0x167`, `0x${"0".repeat(22)}01${priceList}`);
  const f24 = C.f24.address.toLowerCase().slice(2);
  table.set(`${C.account.proxy.toLowerCase()}:0x166`, `0x${"0".repeat(20)}${f24}0600`);
  return table;
}

function topUpStub(opts: {
  output: "USD24" | "EUR24" | "CHF24" | "CNH24";
  paused?: boolean;
  min?: bigint;
  max?: bigint;
  historic?: bigint;
  fee?: bigint;
  usdcRate?: bigint;
  rate?: bigint;
  spread?: bigint;
}) {
  const calls = new Map();
  const deposit = C.deposit.proxy.toLowerCase();
  calls.set(`${C.account.proxy.toLowerCase()}:F24SalesAddress`, {
    answer: { result: C.f24Sales.proxy },
  });
  calls.set(`${deposit}:usdc`, { answer: { result: C.usdc } });
  calls.set(`${C.proxyAdmin.address.toLowerCase()}:owner`, {
    answer: { result: C.proxyAdmin.owner },
  });
  calls.set(`${deposit}:paused`, { answer: { result: opts.paused ?? false } });
  calls.set(`${deposit}:minUsdcDepositAmount`, { answer: { result: opts.min ?? 1n } });
  calls.set(`${deposit}:maxUsdcDepositAmount`, { answer: { result: opts.max ?? 10n ** 12n } });
  calls.set(`${C.account.proxy.toLowerCase()}:historicOwnership`, {
    args: [OWNER],
    answer: { result: opts.historic ?? 350273n },
  });
  calls.set(`${deposit}:exchangeRates`, {
    args: [C.usdc, C.tokens.USD24.proxy],
    answer: { result: opts.usdcRate ?? 10_000n },
  });
  calls.set(`${deposit}:getExchangeRate`, {
    args: [C.tokens.USD24.proxy, C.tokens[opts.output].proxy],
    answer: { result: opts.rate ?? 10_000n },
  });
  calls.set(`${deposit}:getSpread`, {
    args: [C.tokens.USD24.proxy, C.tokens[opts.output].proxy, false],
    answer: { result: opts.spread ?? 10_000n },
  });
  calls.set(`${deposit}:getFee`, {
    answer: { result: opts.fee ?? 0n },
  });
  return makeStub({ blockNumber: B, calls, storage: topUpStorage(opts.output) });
}

describe("getTopUpQuote", () => {
  test("happy path: verifies the deposit path first, then one round at B", async () => {
    const stub = topUpStub({ output: "EUR24", fee: 50_000n });
    const quote = await getTopUpQuote(stub.client, {
      owner: OWNER,
      output: "EUR24",
      usdcAmount: 5_000_000n,
      blockNumber: B,
    });
    // (5000000-50000)/10000 = 495 USD24 → *10000/10000*10000/10000 = 495 EUR24.
    expect(quote).toStrictEqual({
      output: "EUR24",
      usdcAmount: 5_000_000n,
      fee: 50_000n,
      outputAmount: 495n,
      min: 1n,
      max: 10n ** 12n,
      paused: false,
      blockNumber: B,
    });
    // getFee comes after the bounds checks and carries (tokenId, usdcAmount).
    const getFeeCall = stub.calls.find((c) => c.functionName === "getFee");
    expect(getFeeCall?.args).toStrictEqual([350273n, 5_000_000n]);
  });

  test("checks run in order: no-account beats below-minimum beats above-maximum", async () => {
    expect.hasAssertions();
    const noAccount = topUpStub({ output: "EUR24", historic: 0n, min: 10n });
    await expectErrorAsync(
      async () =>
        getTopUpQuote(noAccount.client, {
          owner: OWNER,
          output: "EUR24",
          usdcAmount: 1n,
          blockNumber: B,
        }),
      "no-account",
    );
    const below = topUpStub({ output: "EUR24", min: 100n });
    await expectErrorAsync(
      async () =>
        getTopUpQuote(below.client, {
          owner: OWNER,
          output: "EUR24",
          usdcAmount: 50n,
          blockNumber: B,
        }),
      "below-minimum",
    );
    const above = topUpStub({ output: "EUR24", max: 100n });
    await expectErrorAsync(
      async () =>
        getTopUpQuote(above.client, {
          owner: OWNER,
          output: "EUR24",
          usdcAmount: 101n,
          blockNumber: B,
        }),
      "above-maximum",
    );
  });

  test("a fee above the deposit is an RPC lie (invalid-rpc-response)", async () => {
    expect.hasAssertions();
    const stub = topUpStub({ output: "EUR24", fee: 100n });
    await expectErrorAsync(
      async () =>
        getTopUpQuote(stub.client, {
          owner: OWNER,
          output: "EUR24",
          usdcAmount: 50n,
          blockNumber: B,
        }),
      "invalid-rpc-response",
    );
  });

  test("paused is returned, never thrown", async () => {
    const stub = topUpStub({ output: "EUR24", paused: true });
    const quote = await getTopUpQuote(stub.client, {
      owner: OWNER,
      output: "EUR24",
      usdcAmount: 5_000_000n,
      blockNumber: B,
    });
    expect(quote.paused).toBe(true);
  });

  test("a drifted deposit implementation throws contract-changed before the round", async () => {
    const storage = topUpStorage("EUR24");
    storage.set(
      `${C.deposit.proxy.toLowerCase()}:${IMPL_SLOT}`,
      wordWithAddress(C.tokens.USD24.proxy),
    );
    const drifted = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.account.proxy.toLowerCase()}:F24SalesAddress`,
          { answer: { result: C.f24Sales.proxy } },
        ],
        [`${C.deposit.proxy.toLowerCase()}:usdc`, { answer: { result: C.usdc } }],
        [`${C.proxyAdmin.address.toLowerCase()}:owner`, { answer: { result: C.proxyAdmin.owner } }],
      ]),
      storage,
    });
    await expectErrorAsync(
      async () =>
        getTopUpQuote(drifted.client, {
          owner: OWNER,
          output: "EUR24",
          usdcAmount: 5_000_000n,
          blockNumber: B,
        }),
      "contract-changed",
    );
    const names = drifted.calls.map((c) => c.functionName);
    expect(names).not.toContain("getFee");
  });
});

describe("quote argument validation", () => {
  test("from === to is invalid-argument", async () => {
    expect.hasAssertions();
    const stub = makeStub({ blockNumber: B });
    await expectErrorAsync(
      async () =>
        getExchangeQuote(stub.client, {
          side: "exact-in",
          from: "EUR24",
          to: "EUR24",
          amount: 1n,
          blockNumber: B,
        }),
      "invalid-argument",
    );
  });

  test("a non-address top-up owner is invalid-address", async () => {
    expect.hasAssertions();
    const stub = makeStub({ blockNumber: B });
    await expectErrorAsync(
      async () =>
        getTopUpQuote(stub.client, {
          owner: "0x1234",
          output: "EUR24",
          usdcAmount: 1n,
          blockNumber: B,
        }),
      "invalid-address",
    );
  });
});
