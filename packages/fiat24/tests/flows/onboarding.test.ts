import { encodeFunctionData, getAddress, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { accountAbi, f24Abi } from "../../src/abi/index.ts";
import type { Fiat24Api } from "../../src/api/types.ts";
import { topic0Of } from "../../src/chain/context.ts";
import { Fiat24Error } from "../../src/core/errors.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceOnboarding, kycUrl, startOnboarding } from "../../src/flows/index.ts";
import type { OnboardingState } from "../../src/flows/index.ts";
import type { CallEntry } from "../chain/stub.ts";
import { expectErrorAsync } from "../chain/stub.ts";
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
  word,
  wordWithAddress,
} from "./stub.ts";

const ACCOUNT = C.account.proxy;
const F24 = C.f24.address;
const PRICE_LIST = C.priceList.proxy;
const F24SALES = C.f24Sales.proxy;
const OWNER_CS = getAddress(OWNER);

const PRICE_F24 = 20_000n;
const QUOTE_PER_ETHER = 10_000n;
// mintPriceWei: quote < price ⇒ (price / quote) * 1e18 = 2e18 wei.
const PRICE_WEI = 2_000_000_000_000_000_000n;
const PRICELIST_SLOT = "0x167" as Hex;

const CHECK: OnboardingState = {
  flow: "onboarding",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "check",
  tokenId: SENDER_ID,
  payment: "f24",
};

const CHECK_ETH: OnboardingState = { ...CHECK, payment: "eth" };

const READY_F24: OnboardingState = {
  ...CHECK,
  step: "ready",
  quote: { input: PRICE_F24, blockNumber: B },
};

const READY_ETH: OnboardingState = {
  ...CHECK_ETH,
  step: "ready",
  quote: { input: PRICE_WEI, blockNumber: B },
};

const CONFIRMED_MAIN = {
  purpose: "main" as const,
  phase: "confirmed" as const,
  fromBlock: B,
  nonce: 6,
  hash: TXID_1,
};

const TOURIST: OnboardingState = {
  ...READY_F24,
  step: "tourist",
  txs: [CONFIRMED_MAIN],
};

const KYC: OnboardingState = {
  ...TOURIST,
  step: "kyc",
  kyc: "processing",
};

const APPROVE_SUBMITTED: OnboardingState = {
  ...READY_F24,
  step: "tx",
  txs: [{ purpose: "approve", phase: "submitted", fromBlock: B, nonce: 5, hash: TXID_1 }],
};

const MAIN_READY_F24: OnboardingState = {
  ...READY_F24,
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

const MAIN_READY_ETH: OnboardingState = {
  ...READY_ETH,
  step: "tx",
  txs: [{ purpose: "main", phase: "ready" }],
};

function approveData(amount: bigint): Hex {
  return encodeFunctionData({ abi: f24Abi, functionName: "approve", args: [ACCOUNT, amount] });
}

function mintData(): Hex {
  return encodeFunctionData({ abi: accountAbi, functionName: "mintByClient", args: [SENDER_ID] });
}

function mintEthData(): Hex {
  return encodeFunctionData({
    abi: accountAbi,
    functionName: "mintByClientWithETH",
    args: [SENDER_ID],
  });
}

function mintLog(from: Address, to: Address, tokenId: bigint): Record<string, unknown> {
  return logPayload({
    address: ACCOUNT,
    topics: [topic0Of(accountAbi, "Transfer"), addressTopic(from), addressTopic(to), word(tokenId)],
    data: "0x",
    blockNumber: B + 1n,
    transactionHash: TXID_1,
  });
}

type TableOpts = {
  readonly rounds?: number;
  readonly paused?: Readonly<Record<string, boolean>>;
  readonly f24Active?: boolean;
  readonly maxDigitForSale?: number;
  readonly historic?: bigint;
  readonly nftBalance?: bigint;
  readonly taken?: boolean;
  readonly priceF24?: bigint;
  readonly quotePerEther?: bigint;
  readonly f24Balance?: bigint;
  readonly f24Allowance?: bigint;
  readonly f24Supply?: bigint;
};

/** Every read the check guards + plan + send consume, per round. */
function onboardingTable(opts: TableOpts = {}): Map<string, CallEntry[]> {
  return mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false, maxDigitForSale: opts.maxDigitForSale }),
    new Map<string, CallEntry[]>([
      [
        `${ACCOUNT.toLowerCase()}:historicOwnership`,
        [
          {
            args: [OWNER],
            answer: { result: opts.historic ?? 0n },
          },
        ],
      ],
      [
        `${ACCOUNT.toLowerCase()}:balanceOf`,
        [
          {
            args: [OWNER],
            answer: { result: opts.nftBalance ?? 0n },
          },
        ],
      ],
      [
        `${ACCOUNT.toLowerCase()}:exists`,
        [
          {
            args: [SENDER_ID],
            answer: { result: opts.taken ?? false },
          },
        ],
      ],
      [
        `${PRICE_LIST.toLowerCase()}:getPrice`,
        [
          {
            args: [SENDER_ID],
            answer: { result: opts.priceF24 ?? PRICE_F24 },
          },
        ],
      ],
      [
        `${F24SALES.toLowerCase()}:quotePerEther`,
        [
          {
            answer: { result: opts.quotePerEther ?? QUOTE_PER_ETHER },
          },
        ],
      ],
      [
        `${F24.toLowerCase()}:balanceOf`,
        [
          {
            args: [OWNER],
            answer: { result: opts.f24Balance ?? PRICE_F24 },
          },
        ],
      ],
      [
        `${F24.toLowerCase()}:allowance`,
        [
          {
            args: [OWNER, ACCOUNT],
            answer: { result: opts.f24Allowance ?? 0n },
          },
        ],
      ],
      [
        `${F24.toLowerCase()}:totalSupply`,
        [
          {
            answer: { result: opts.f24Supply ?? 1_000_000n },
          },
        ],
      ],
      [
        `${F24.toLowerCase()}:approve`,
        [
          {
            args: [ACCOUNT, PRICE_F24],
            answer: { result: true },
          },
        ],
      ],
      [
        `${ACCOUNT.toLowerCase()}:mintByClient`,
        [
          {
            args: [SENDER_ID],
            answer: { raw: "0x" },
          },
        ],
      ],
      [
        `${ACCOUNT.toLowerCase()}:mintByClientWithETH`,
        [
          {
            args: [SENDER_ID],
            answer: { raw: "0x" },
          },
        ],
      ],
    ]),
  );
}

function storageWith(opts: { readonly f24Active?: boolean } = {}): Map<string, Hex> {
  const storage = honestStorage();
  if (opts.f24Active === false) {
    const priceList = PRICE_LIST.toLowerCase().slice(2);
    // byte 20 (little-endian) of slot 0x167 is f24IsActive.
    storage.set(
      `${ACCOUNT.toLowerCase()}:${PRICELIST_SLOT}`,
      `0x${"0".repeat(22)}00${priceList}` as Hex,
    );
  }
  return storage;
}

/** The getAccount({tokenId}) round the tourist/kyc poll consumes. */
function accountByIdEntries(
  opts: { readonly statusIndex?: number } = {},
): Map<string, CallEntry[]> {
  const statusIndex = opts.statusIndex ?? 2;
  return new Map<string, CallEntry[]>([
    [`${ACCOUNT.toLowerCase()}:exists`, [{ args: [SENDER_ID], answer: { result: true } }]],
    [`${ACCOUNT.toLowerCase()}:status`, [{ args: [SENDER_ID], answer: { result: statusIndex } }]],
    [
      `${ACCOUNT.toLowerCase()}:limit`,
      [{ args: [SENDER_ID], answer: { result: [0n, 10_000n, 0n] } }],
    ],
    [`${ACCOUNT.toLowerCase()}:limitTourist`, [{ answer: { result: 400n } }]],
    [`${ACCOUNT.toLowerCase()}:walletProvider`, [{ args: [SENDER_ID], answer: { result: 0n } }]],
    [`${ACCOUNT.toLowerCase()}:ownerOf`, [{ args: [SENDER_ID], answer: { result: OWNER } }]],
    [
      `${ACCOUNT.toLowerCase()}:getApproved`,
      [{ args: [SENDER_ID], answer: { result: zeroAddress } }],
    ],
  ]);
}

function apiStub(status: string): Fiat24Api {
  return { kycStatus: async () => Promise.resolve(status as never) } as unknown as Fiat24Api;
}

describe("startOnboarding", () => {
  test("validates tokenId and payment, returns check", () => {
    const state = startOnboarding({ owner: OWNER, tokenId: SENDER_ID, payment: "f24" });
    expect(state).toStrictEqual(CHECK);
    expect(Object.isFrozen(state)).toBe(true);
  });

  test("refuses non-standard ids and bad payment", () => {
    const attempts: ReadonlyArray<readonly [() => unknown, ReadonlySet<string>]> = [
      [
        () => startOnboarding({ owner: OWNER, tokenId: 9100n, payment: "f24" }),
        new Set(["invalid-account-id"]),
      ],
      [
        () =>
          startOnboarding({
            owner: OWNER,
            tokenId: SENDER_ID,
            payment: "usd" as never,
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () => startOnboarding({ owner: "0x1234", tokenId: SENDER_ID, payment: "f24" }),
        new Set(["invalid-address"]),
      ],
    ];
    const results = attempts.map(([attempt, codes]) => throwsCode(attempt, codes));
    expect(results.every(Boolean)).toBe(true);
  });
});

describe("advanceOnboarding check guards", () => {
  test("account paused ⇒ unavailable account-paused", async () => {
    const stub = makeFlowStub({
      calls: onboardingTable({ paused: { [ACCOUNT.toLowerCase()]: true } }),
      storage: honestStorage(),
    });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceOnboarding(deps, CHECK), "unavailable");
    expect(error.detail.reason).toBe("account-paused");
    expect(error.detail.contract).toBe("account");
  });

  test("f24 inactive ⇒ unavailable f24-inactive", async () => {
    const stub = makeFlowStub({
      calls: onboardingTable(),
      storage: storageWith({ f24Active: false }),
    });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceOnboarding(deps, CHECK), "unavailable");
    expect(error.detail.reason).toBe("f24-inactive");
  });

  test("eth path: f24Sales paused ⇒ unavailable f24-sales-paused", async () => {
    const stub = makeFlowStub({
      calls: onboardingTable({ paused: { [F24SALES.toLowerCase()]: true } }),
      storage: honestStorage(),
    });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceOnboarding(deps, CHECK_ETH),
      "unavailable",
    );
    expect(error.detail.reason).toBe("f24-sales-paused");
    expect(error.detail.contract).toBe("f24Sales");
  });

  test("maxDigitForSale below 6 ⇒ unavailable mint-digits", async () => {
    const stub = makeFlowStub({
      calls: onboardingTable({ maxDigitForSale: 5 }),
      storage: honestStorage(),
    });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceOnboarding(deps, CHECK), "unavailable");
    expect(error.detail.reason).toBe("mint-digits");
    expect(error.detail.contract).toBe("account");
  });

  test("address-ineligible when the owner already has or had an account", async () => {
    const cases = [onboardingTable({ historic: SENDER_ID }), onboardingTable({ nftBalance: 1n })];
    await Promise.all(
      cases.map(async (table) => {
        const stub = makeFlowStub({ calls: table, storage: honestStorage() });
        const { deps } = flowDeps(stub.client);
        const error = await expectErrorAsync(
          async () => advanceOnboarding(deps, CHECK),
          "address-ineligible",
        );
        expect(error).toBeInstanceOf(Fiat24Error);
      }),
    );
  });

  test("taken tokenId ⇒ account-id-taken", async () => {
    const stub = makeFlowStub({
      calls: onboardingTable({ taken: true }),
      storage: honestStorage(),
    });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceOnboarding(deps, CHECK),
      "account-id-taken",
    );
    expect(error).toBeInstanceOf(Fiat24Error);
  });

  test("f24 path: low F24 balance ⇒ insufficient-balance", async () => {
    const stub = makeFlowStub({
      calls: onboardingTable({ f24Balance: PRICE_F24 - 1n }),
      storage: honestStorage(),
    });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceOnboarding(deps, CHECK),
      "insufficient-balance",
    );
    expect(error).toBeInstanceOf(Fiat24Error);
  });
});

describe("advanceOnboarding check → ready", () => {
  test("f24 stores priceF24; eth stores priceWei", async () => {
    const cases: ReadonlyArray<{
      readonly state: OnboardingState;
      readonly input: bigint;
    }> = [
      { state: CHECK, input: PRICE_F24 },
      { state: CHECK_ETH, input: PRICE_WEI },
    ];
    await Promise.all(
      cases.map(async ({ state, input }) => {
        const stub = makeFlowStub({ calls: onboardingTable(), storage: honestStorage() });
        const { deps, persisted } = flowDeps(stub.client);
        const next = await advanceOnboarding(deps, state);
        expect(next.step).toBe("ready");
        expect(next.quote).toStrictEqual({ input, blockNumber: B });
        expect(persisted).toHaveLength(1);
      }),
    );
  });
});

describe("advanceOnboarding ready → tx", () => {
  test("f24 approves exactly quote.input when the allowance differs (incl. down)", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: onboardingTable({ f24Allowance: 999_999n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceOnboarding(deps, READY_F24);
    expect(next.txs[0]?.purpose).toBe("approve");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.to).toBe(F24);
    expect(requests[0]?.data).toBe(approveData(PRICE_F24));
  });

  test("f24 skips the approve when the allowance already matches", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: onboardingTable({ f24Allowance: PRICE_F24 }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceOnboarding(deps, READY_F24);
    expect(next.txs[0]?.purpose).toBe("main");
    expect(requests[0]?.data).toBe(mintData());
  });

  test("eth sends the mint with value = quoted wei, no approve", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: onboardingTable(),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceOnboarding(deps, READY_ETH);
    expect(next.txs[0]?.purpose).toBe("main");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.to).toBe(ACCOUNT);
    expect(requests[0]?.data).toBe(mintEthData());
    expect(requests[0]?.value).toBe(PRICE_WEI);
  });

  test("supply bound on the F24 approve ⇒ unlimited-approval", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: onboardingTable({ f24Allowance: 0n, f24Supply: PRICE_F24 - 1n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceOnboarding(deps, READY_F24), "unlimited-approval");
    expect(requests).toHaveLength(0);
  });
});

describe("advanceOnboarding tx records", () => {
  test("f24 quote-changed: fresh price above the stored input", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: onboardingTable({ priceF24: PRICE_F24 + 1n, f24Balance: 50_000n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceOnboarding(deps, MAIN_READY_F24), "quote-changed");
    expect(requests).toHaveLength(0);
  });

  test("f24 quote-changed: drifted allowance", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: onboardingTable({ f24Allowance: PRICE_F24 - 1n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceOnboarding(deps, MAIN_READY_F24), "quote-changed");
    expect(requests).toHaveLength(0);
  });

  test("f24 quote-changed: allowance above the quoted input", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: onboardingTable({ f24Allowance: PRICE_F24 + 1n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceOnboarding(deps, MAIN_READY_F24), "quote-changed");
    expect(requests).toHaveLength(0);
  });

  test("eth quote-changed: fresh priceWei above the stored input", async () => {
    const { signer, requests } = makeSigner(OWNER);
    const stub = makeFlowStub({
      calls: onboardingTable({ quotePerEther: 6000n }),
      storage: honestStorage(),
      count: { pending: 7 },
    });
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceOnboarding(deps, MAIN_READY_ETH), "quote-changed");
    expect(requests).toHaveLength(0);
  });

  test("mint confirmed requires the account-transfer event", async () => {
    const mainSubmitted: OnboardingState = {
      ...READY_ETH,
      step: "tx",
      txs: [{ purpose: "main", phase: "submitted", fromBlock: B, nonce: 6, hash: TXID_1 }],
    };
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [mintLog(zeroAddress, OWNER, SENDER_ID)],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: ACCOUNT,
          input: mintEthData(),
          value: PRICE_WEI,
          nonce: 6,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceOnboarding(deps, mainSubmitted);
    expect(next.step).toBe("tourist");
    expect(persisted).toHaveLength(1);
  });

  test("no account-transfer event ⇒ invalid-rpc-response, no transition", async () => {
    const mainSubmitted: OnboardingState = {
      ...READY_ETH,
      step: "tx",
      txs: [{ purpose: "main", phase: "submitted", fromBlock: B, nonce: 6, hash: TXID_1 }],
    };
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [mintLog(OWNER, OWNER, SENDER_ID)],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: ACCOUNT,
          input: mintEthData(),
          value: PRICE_WEI,
          nonce: 6,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    await expectErrorAsync(
      async () => advanceOnboarding(deps, mainSubmitted),
      "invalid-rpc-response",
    );
    expect(persisted).toHaveLength(0);
  });

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
          to: F24,
          input: approveData(PRICE_F24),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceOnboarding(deps, APPROVE_SUBMITTED);
    expect(next.step).toBe("tx");
    expect(next.txs[1]).toStrictEqual({ purpose: "main", phase: "ready" });
    expect(requests).toHaveLength(0);
  });
});

describe("advanceOnboarding tourist/kyc polling", () => {
  test("deps.api missing ⇒ invalid-argument", async () => {
    const stub = makeFlowStub({});
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceOnboarding(deps, TOURIST),
      "invalid-argument",
    );
    expect(error).toBeInstanceOf(Fiat24Error);
  });

  test("API completed + chain tourist ⇒ stays kyc with the API status", async () => {
    const stub = makeFlowStub({ calls: accountByIdEntries({ statusIndex: 2 }) });
    const { deps: base } = flowDeps(stub.client);
    const deps = { ...base, api: apiStub("completed") };
    const next = await advanceOnboarding(deps, TOURIST);
    expect(next.step).toBe("kyc");
    expect(next.kyc).toBe("completed");
  });

  test("API completed + chain live ⇒ live", async () => {
    const stub = makeFlowStub({ calls: accountByIdEntries({ statusIndex: 5 }) });
    const { deps: base } = flowDeps(stub.client);
    const deps = { ...base, api: apiStub("completed") };
    const next = await advanceOnboarding(deps, TOURIST);
    expect(next.step).toBe("live");
  });

  test("API rejected + chain not live ⇒ rejected", async () => {
    const stub = makeFlowStub({ calls: accountByIdEntries({ statusIndex: 2 }) });
    const { deps: base } = flowDeps(stub.client);
    const deps = { ...base, api: apiStub("rejected") };
    const next = await advanceOnboarding(deps, KYC);
    expect(next.step).toBe("rejected");
  });

  test("API rejected + chain live ⇒ live wins", async () => {
    const stub = makeFlowStub({ calls: accountByIdEntries({ statusIndex: 5 }) });
    const { deps: base } = flowDeps(stub.client);
    const deps = { ...base, api: apiStub("rejected") };
    const next = await advanceOnboarding(deps, KYC);
    expect(next.step).toBe("live");
  });

  test("terminal steps ⇒ invalid-state with no I/O", async () => {
    const live: OnboardingState = { ...KYC, step: "live", kyc: undefined as never };
    const stub = makeFlowStub({});
    const { deps, persisted } = flowDeps(stub.client);
    await expectErrorAsync(async () => advanceOnboarding(deps, live), "invalid-state");
    expect(stub.requests).toHaveLength(0);
    expect(persisted).toHaveLength(0);
  });
});

describe("kycUrl", () => {
  test("no id, valid id, invalid id", () => {
    expect(kycUrl()).toBe("https://id.fiat24.com/login");
    expect(kycUrl(123n)).toBe("https://id.fiat24.com/login?wallet=123");
    const attempts: ReadonlyArray<() => unknown> = [
      () => kycUrl(0n),
      () => kycUrl("abc" as never),
      () => kycUrl(-1n),
    ];
    const results = attempts.map((attempt) => throwsCode(attempt, new Set(["invalid-argument"])));
    expect(results.every(Boolean)).toBe(true);
  });
});

describe("advanceOnboarding drift before guard reads", () => {
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

  test("check ⇒ contract-changed before any guard read", async () => {
    const storage = honestStorage();
    storage.set(`${ACCOUNT.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(OWNER));
    const stub = makeFlowStub({ calls: proxyAdminEntry(), storage });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceOnboarding(deps, CHECK),
      "contract-changed",
    );
    expect(error.detail).toMatchObject({ contract: "account", field: "implementation" });
    expect(guardCalls(stub)).toStrictEqual([]);
  });

  test("ready planning ⇒ contract-changed before any guard read", async () => {
    const storage = honestStorage();
    // Wiring slot 359: bytes 0-19 hold the priceList address — zeroed ⇒ drift.
    storage.set(`${ACCOUNT.toLowerCase()}:${PRICELIST_SLOT}`, word(0n));
    const stub = makeFlowStub({ calls: proxyAdminEntry(), storage });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceOnboarding(deps, READY_F24),
      "contract-changed",
    );
    expect(error.detail).toMatchObject({ contract: "account", field: "priceList" });
    expect(guardCalls(stub)).toStrictEqual([]);
  });
});
