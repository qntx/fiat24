import type { Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { fiat24PublicActions } from "../../src/actions.ts";
import type { Fiat24PublicActionSet } from "../../src/actions.ts";
import { approveCall } from "../../src/calls/approve.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import type { Deployment } from "../../src/deployments/index.ts";
import {
  B,
  B_HEX,
  expectErrorAsync,
  makeStub,
  OWNER,
  RECIPIENT,
  TOKEN_ID,
  wordWithAddress,
} from "./stub.ts";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const NAMES = [
  "fiat24GetAccount",
  "fiat24GetBalances",
  "fiat24GetAllowance",
  "fiat24GetAllowances",
  "fiat24GetAvailability",
  "fiat24VerifyDeployment",
  "fiat24AssertDeployment",
  "fiat24GetExchangeQuote",
  "fiat24GetTopUpQuote",
  "fiat24CheckTransfer",
  "fiat24GetPayoutMinimum",
  "fiat24GetPayoutSettlement",
  "fiat24GetMintQuote",
  "fiat24GetHistory",
  "fiat24SimulateCall",
] as const;

// A deployment object on the wrong chain — resolveDeployment refuses it (I21), which is
// exactly what makes deployment injection observable in tests.
const WRONG_CHAIN = { ...C, chainId: 1 } as unknown as Deployment;

type Invoke = (set: Fiat24PublicActionSet, deployment?: Deployment) => Promise<unknown>;

/** One invocation per deployment-bearing method, parameterized over the deployment arg. */
const METHOD_CALLS: ReadonlyArray<readonly [string, Invoke]> = [
  ["fiat24GetAccount", async (set, d) => set.fiat24GetAccount({ owner: OWNER, deployment: d })],
  ["fiat24GetBalances", async (set, d) => set.fiat24GetBalances({ owner: OWNER, deployment: d })],
  [
    "fiat24GetAllowance",
    async (set, d) =>
      set.fiat24GetAllowance({ owner: OWNER, asset: "EUR24", spender: "card", deployment: d }),
  ],
  [
    "fiat24GetAllowances",
    async (set, d) => set.fiat24GetAllowances({ owner: OWNER, deployment: d }),
  ],
  ["fiat24GetAvailability", async (set, d) => set.fiat24GetAvailability({ deployment: d })],
  ["fiat24VerifyDeployment", async (set, d) => set.fiat24VerifyDeployment({ deployment: d })],
  [
    "fiat24AssertDeployment",
    async (set, d) => set.fiat24AssertDeployment({ contracts: ["card"], deployment: d }),
  ],
  [
    "fiat24GetExchangeQuote",
    async (set, d) =>
      set.fiat24GetExchangeQuote({
        side: "exact-in",
        from: "EUR24",
        to: "USD24",
        amount: 1n,
        deployment: d,
      }),
  ],
  [
    "fiat24GetTopUpQuote",
    async (set, d) =>
      set.fiat24GetTopUpQuote({ owner: OWNER, output: "EUR24", usdcAmount: 1n, deployment: d }),
  ],
  [
    "fiat24CheckTransfer",
    async (set, d) =>
      set.fiat24CheckTransfer({
        from: OWNER,
        to: { address: RECIPIENT },
        currency: "EUR24",
        amount: 1n,
        deployment: d,
      }),
  ],
  [
    "fiat24GetPayoutMinimum",
    async (set, d) => set.fiat24GetPayoutMinimum({ currency: "EUR24", deployment: d }),
  ],
  [
    "fiat24GetPayoutSettlement",
    async (set, d) =>
      set.fiat24GetPayoutSettlement({
        currency: "EUR24",
        tokenId: TOKEN_ID,
        contactId: "CH",
        txid: "trx-1",
        fromBlock: 0n,
        deployment: d,
      }),
  ],
  [
    "fiat24GetMintQuote",
    async (set, d) => set.fiat24GetMintQuote({ tokenId: 402001n, deployment: d }),
  ],
  [
    "fiat24GetHistory",
    async (set, d) =>
      set.fiat24GetHistory({ owner: OWNER, fromBlock: 0n, toBlock: 1n, deployment: d }),
  ],
];

function honestStorage(): Map<string, Hex> {
  const table = new Map<string, Hex>();
  for (const pin of [
    C.account,
    C.tokens.USD24,
    C.tokens.EUR24,
    C.tokens.CHF24,
    C.tokens.CNH24,
    C.deposit,
    C.card,
    C.priceList,
    C.f24Sales,
  ]) {
    table.set(`${pin.proxy.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(pin.implementation));
    table.set(`${pin.proxy.toLowerCase()}:${ADMIN_SLOT}`, wordWithAddress(pin.admin));
  }
  const priceList = C.priceList.proxy.toLowerCase().slice(2);
  table.set(`${C.account.proxy.toLowerCase()}:0x167`, `0x${"0".repeat(22)}01${priceList}` as Hex);
  const f24 = C.f24.address.toLowerCase().slice(2);
  table.set(`${C.account.proxy.toLowerCase()}:0x166`, `0x${"0".repeat(20)}${f24}0600` as Hex);
  return table;
}

describe("fiat24PublicActions", () => {
  test("exposes exactly the 15 prefixed methods", () => {
    const stub = makeStub({ blockNumber: B });
    const set = fiat24PublicActions()(stub.client);
    expect(Object.keys(set).toSorted()).toStrictEqual([...NAMES].toSorted());
    for (const name of NAMES) {
      expect(set[name]).toBeTypeOf("function");
    }
  });

  test("methods run through to the actions with the client", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.EUR24.proxy.toLowerCase()}:balanceOf`,
          { args: [OWNER], answer: { result: 0n } },
        ],
        [
          `${C.tokens.USD24.proxy.toLowerCase()}:balanceOf`,
          { args: [OWNER], answer: { result: 0n } },
        ],
        [
          `${C.tokens.CHF24.proxy.toLowerCase()}:balanceOf`,
          { args: [OWNER], answer: { result: 0n } },
        ],
        [
          `${C.tokens.CNH24.proxy.toLowerCase()}:balanceOf`,
          { args: [OWNER], answer: { result: 0n } },
        ],
      ]),
    });
    const set = fiat24PublicActions()(stub.client);
    const { balances, blockNumber } = await set.fiat24GetBalances({
      owner: OWNER,
      blockNumber: B,
    });
    expect(balances.EUR24).toBe(0n);
    expect(blockNumber).toBe(B);
  });

  test("args.deployment beats the decorator deployment", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.EUR24.proxy.toLowerCase()}:balanceOf`,
          { args: [OWNER], answer: { result: 3n } },
        ],
        [
          `${C.tokens.USD24.proxy.toLowerCase()}:balanceOf`,
          { args: [OWNER], answer: { result: 0n } },
        ],
        [
          `${C.tokens.CHF24.proxy.toLowerCase()}:balanceOf`,
          { args: [OWNER], answer: { result: 0n } },
        ],
        [
          `${C.tokens.CNH24.proxy.toLowerCase()}:balanceOf`,
          { args: [OWNER], answer: { result: 0n } },
        ],
      ]),
    });
    // Bound to a wrong-chain deployment; the per-call deployment overrides it.
    const set = fiat24PublicActions({ deployment: WRONG_CHAIN })(stub.client);
    const { balances } = await set.fiat24GetBalances({
      owner: OWNER,
      deployment: C,
      blockNumber: B,
    });
    expect(balances.EUR24).toBe(3n);

    // Without the override, the wrong-chain binding is refused.
    await expectErrorAsync(
      async () => set.fiat24GetBalances({ owner: OWNER, blockNumber: B }),
      "unsupported-chain",
    );
  });

  test("the decorator deployment is used when args omits one", async () => {
    expect.hasAssertions();
    const stub = makeStub({ blockNumber: B });
    const set = fiat24PublicActions({ deployment: WRONG_CHAIN })(stub.client);
    await expectErrorAsync(
      async () => set.fiat24GetAvailability({ blockNumber: B }),
      "unsupported-chain",
    );
  });

  test("getAvailability and verifyDeployment accept a bare call", async () => {
    const calls = new Map<string, { answer: { result: unknown } }>();
    for (const pin of [
      C.account.proxy,
      C.tokens.USD24.proxy,
      C.tokens.EUR24.proxy,
      C.tokens.CHF24.proxy,
      C.tokens.CNH24.proxy,
      C.deposit.proxy,
      C.card.proxy,
      C.f24Sales.proxy,
    ]) {
      calls.set(`${pin.toLowerCase()}:paused`, { answer: { result: false } });
    }
    calls.set(`${C.deposit.proxy.toLowerCase()}:marketClosed`, {
      answer: { result: false },
    });
    calls.set(`${C.account.proxy.toLowerCase()}:maxDigitForSale`, {
      answer: { result: 6 },
    });
    calls.set(`${C.account.proxy.toLowerCase()}:F24SalesAddress`, {
      answer: { result: C.f24Sales.proxy },
    });
    calls.set(`${C.deposit.proxy.toLowerCase()}:usdc`, {
      answer: { result: C.usdc },
    });
    calls.set(`${C.proxyAdmin.address.toLowerCase()}:owner`, {
      answer: { result: C.proxyAdmin.owner },
    });
    const stub = makeStub({ blockNumber: B, calls, storage: honestStorage() });
    const set = fiat24PublicActions()(stub.client);
    const availability = await set.fiat24GetAvailability({});
    expect(availability.blockNumber).toBe(B);
    const check = await set.fiat24VerifyDeployment({});
    expect(check.ok).toBe(true);
    for (const call of stub.calls) {
      expect(call.blockTag).toBe(B_HEX);
    }
  });

  test("fiat24SimulateCall passes args straight through (no deployment injected)", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [`${C.tokens.EUR24.proxy.toLowerCase()}:approve`, { answer: { result: true } }],
      ]),
    });
    const set = fiat24PublicActions({ deployment: WRONG_CHAIN })(stub.client);
    const out = await set.fiat24SimulateCall({
      call: approveCall({ asset: "EUR24", spender: "card", amount: 1n }),
      from: OWNER,
      blockNumber: B,
    });
    expect(out).toBe(`0x${"0".repeat(63)}1`);
  });

  test.each(METHOD_CALLS)(
    "bound deployment reaches %s when the call omits one",
    async (_name, invoke) => {
      expect.hasAssertions();
      const stub = makeStub({ blockNumber: B });
      const set = fiat24PublicActions({ deployment: WRONG_CHAIN })(stub.client);
      await expectErrorAsync(async () => invoke(set), "unsupported-chain");
    },
  );

  test.each(METHOD_CALLS)("%s deployment arg beats the bound deployment", async (_name, invoke) => {
    expect.hasAssertions();
    const stub = makeStub({ blockNumber: B });
    const set = fiat24PublicActions({ deployment: C })(stub.client);
    await expectErrorAsync(async () => invoke(set, WRONG_CHAIN), "unsupported-chain");
  });
});
