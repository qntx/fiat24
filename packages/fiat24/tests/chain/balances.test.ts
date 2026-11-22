import { describe, expect, test } from "vite-plus/test";

import { getAllowance, getAllowances, getBalances } from "../../src/chain/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { B, expectErrorAsync, makeStub, OWNER } from "./stub.ts";
import type { CallTable } from "./stub.ts";

const TOKENS = ["USD24", "EUR24", "CHF24", "CNH24"] as const;

function balanceCalls(values: readonly [bigint, bigint, bigint, bigint]): CallTable {
  const entries = new Map();
  for (const [i, currency] of TOKENS.entries()) {
    entries.set(`${C.tokens[currency].proxy.toLowerCase()}:balanceOf`, {
      args: [OWNER],
      answer: { result: values[i] },
    });
  }
  return entries;
}

describe("getBalances", () => {
  test("reads balanceOf(O) on the four cash tokens in one round", async () => {
    const stub = makeStub({ blockNumber: B, calls: balanceCalls([11n, 22n, 33n, 44n]) });
    const { balances, blockNumber } = await getBalances(stub.client, {
      owner: OWNER,
      blockNumber: B,
    });
    expect(balances).toStrictEqual({ USD24: 11n, EUR24: 22n, CHF24: 33n, CNH24: 44n });
    expect(blockNumber).toBe(B);
    expect(stub.calls.map((c) => [c.to, c.functionName])).toStrictEqual(
      TOKENS.map((c) => [C.tokens[c].proxy, "balanceOf"]),
    );
  });

  test("an invalid owner address rejects before I/O", async () => {
    const stub = makeStub({ blockNumber: B, calls: balanceCalls([0n, 0n, 0n, 0n]) });
    await expectErrorAsync(
      async () =>
        getBalances(stub.client, {
          owner: "not-an-address" as never,
          blockNumber: B,
        }),
      "invalid-address",
    );
    expect(stub.requests).toStrictEqual([]);
  });

  test("an invalid owner also rejects before eth_blockNumber (§8.1 input before I/O)", async () => {
    const stub = makeStub({ blockNumber: B, calls: balanceCalls([0n, 0n, 0n, 0n]) });
    await expectErrorAsync(
      async () => getBalances(stub.client, { owner: "not-an-address" as never }),
      "invalid-address",
    );
    expect(stub.requests).toStrictEqual([]);
  });

  test("each action fetches a fresh B — two actions issue two eth_blockNumber", async () => {
    // Without cacheTime: 0 viem would serve the second read from its
    // client.cacheTime window (min(pollingInterval, blockTime/2)).
    const stub = makeStub({ blockNumber: B, calls: balanceCalls([0n, 0n, 0n, 0n]) });
    await getBalances(stub.client, { owner: OWNER });
    await getBalances(stub.client, { owner: OWNER });
    expect(stub.requests.filter((r) => r.method === "eth_blockNumber")).toHaveLength(2);
  });
});

describe("getAllowance", () => {
  test("cash asset → card spender reads the token proxy", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.EUR24.proxy.toLowerCase()}:allowance`,
          { args: [OWNER, C.card.proxy], answer: { result: 77n } },
        ],
      ]),
    });
    await expect(
      getAllowance(stub.client, {
        owner: OWNER,
        asset: "EUR24",
        spender: "card",
        blockNumber: B,
      }),
    ).resolves.toBe(77n);
    expect(stub.calls[0]?.to).toBe(C.tokens.EUR24.proxy);
  });

  test("cash asset → deposit spender", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.CHF24.proxy.toLowerCase()}:allowance`,
          { args: [OWNER, C.deposit.proxy], answer: { result: 88n } },
        ],
      ]),
    });
    await expect(
      getAllowance(stub.client, {
        owner: OWNER,
        asset: "CHF24",
        spender: "deposit",
        blockNumber: B,
      }),
    ).resolves.toBe(88n);
  });

  test("USDC → deposit reads the pinned usdc address (erc20Abi)", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.usdc.toLowerCase()}:allowance`,
          { args: [OWNER, C.deposit.proxy], answer: { result: 99n } },
        ],
      ]),
    });
    await expect(
      getAllowance(stub.client, {
        owner: OWNER,
        asset: "USDC",
        spender: "deposit",
        blockNumber: B,
      }),
    ).resolves.toBe(99n);
    expect(stub.calls[0]?.to).toBe(C.usdc);
  });

  test("F24 → account reads the non-proxy f24 address", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.f24.address.toLowerCase()}:allowance`,
          { args: [OWNER, C.account.proxy], answer: { result: 5n } },
        ],
      ]),
    });
    await expect(
      getAllowance(stub.client, {
        owner: OWNER,
        asset: "F24",
        spender: "account",
        blockNumber: B,
      }),
    ).resolves.toBe(5n);
  });

  test("non-§6.1 pairs are invalid-argument", async () => {
    const stub = makeStub({ blockNumber: B });
    const pairs = [
      ["USD24", "account"],
      ["EUR24", "account"],
      ["USDC", "card"],
      ["F24", "card"],
      ["F24", "deposit"],
    ] as const;
    await Promise.all(
      pairs.map(async ([asset, spender]) =>
        expectErrorAsync(
          async () =>
            getAllowance(stub.client, {
              owner: OWNER,
              asset,
              spender,
              blockNumber: B,
            }),
          "invalid-argument",
        ),
      ),
    );
    expect(stub.requests).toStrictEqual([]);
  });

  test("unknown asset is unsupported-currency; unknown spender is invalid-argument", async () => {
    expect.hasAssertions();
    const stub = makeStub({ blockNumber: B });
    await expectErrorAsync(
      async () =>
        getAllowance(stub.client, {
          owner: OWNER,
          asset: "GBP24" as never,
          spender: "card",
          blockNumber: B,
        }),
      "unsupported-currency",
    );
    await expectErrorAsync(
      async () =>
        getAllowance(stub.client, {
          owner: OWNER,
          asset: "EUR24",
          spender: "treasury" as never,
          blockNumber: B,
        }),
      "invalid-argument",
    );
    expect(stub.requests).toStrictEqual([]);
  });
});

describe("getAllowances", () => {
  test("reads all ten §6.1 pairs in one round", async () => {
    const calls = new Map();
    for (const c of TOKENS) {
      calls.set(`${C.tokens[c].proxy.toLowerCase()}:allowance`, [
        { args: [OWNER, C.card.proxy], answer: { result: 10n } },
        { args: [OWNER, C.deposit.proxy], answer: { result: 20n } },
      ]);
    }
    calls.set(`${C.usdc.toLowerCase()}:allowance`, {
      args: [OWNER, C.deposit.proxy],
      answer: { result: 30n },
    });
    calls.set(`${C.f24.address.toLowerCase()}:allowance`, {
      args: [OWNER, C.account.proxy],
      answer: { result: 40n },
    });
    const stub = makeStub({ blockNumber: B, calls });
    const result = await getAllowances(stub.client, { owner: OWNER, blockNumber: B });
    expect(result.card).toStrictEqual({ USD24: 10n, EUR24: 10n, CHF24: 10n, CNH24: 10n });
    expect(result.deposit).toStrictEqual({
      USD24: 20n,
      EUR24: 20n,
      CHF24: 20n,
      CNH24: 20n,
      USDC: 30n,
    });
    expect(result.account).toStrictEqual({ F24: 40n });
    expect(result.blockNumber).toBe(B);
    expect(stub.calls).toHaveLength(10);
  });
});
