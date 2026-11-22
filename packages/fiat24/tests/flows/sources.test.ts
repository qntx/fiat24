import { getAddress, zeroAddress } from "viem";
import type { Address } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { createFiat24Api } from "../../src/api/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import {
  advanceCard,
  advanceExchange,
  advanceOnboarding,
  advancePayout,
} from "../../src/flows/index.ts";
import type {
  CardState,
  ExchangeState,
  OnboardingState,
  PayoutState,
} from "../../src/flows/index.ts";
import { fixtureBody, json, stubFetch, testSigner } from "../api/stub.ts";
import type { CallEntry } from "../chain/stub.ts";
import { expectErrorAsync } from "../chain/stub.ts";
import {
  accountEntries,
  availabilityEntries,
  B,
  flowDeps,
  honestStorage,
  makeFlowStub,
  mergeCalls,
  OWNER,
  proxyAdminEntry,
  SENDER_ID,
  TXID_1,
} from "./stub.ts";

const EUR24 = C.tokens.EUR24.proxy;
const USD24 = C.tokens.USD24.proxy;
const DEPOSIT = C.deposit.proxy;
const CARD = C.card.proxy;
const ACCOUNT = C.account.proxy;
const OWNER_CS = getAddress(OWNER);
const TREASURY = "0x0000000000000000000000000000000000009100" as Address;
const CRYPTO = "0x0000000000000000000000000000000000009105" as Address;
const PAYOUT_DESK = "0x0000000000000000000000000000000000009102" as Address;

const TOKEN_ID = 690333n;
const NOW = () => 1_795_328_524_822;

// exact-in EUR24→USD24 amount=100, rate 10968, spread 9950 ⇒ output 108 (chain math).
const INPUT = 100n;
const OUTPUT = 108n;
const RATE = 10968n;
const SPREAD = 9950n;

const EXCHANGE_DRAFT: ExchangeState = {
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

const SET_CAP: CardState = {
  flow: "card",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "ready",
  tokenId: TOKEN_ID,
  operation: { kind: "set-cap", currency: "EUR24", amount: 100n },
};

const TOURIST: OnboardingState = {
  flow: "onboarding",
  version: 1,
  owner: OWNER_CS,
  txs: [
    {
      purpose: "main",
      phase: "confirmed",
      fromBlock: B,
      nonce: 6,
      hash: TXID_1,
      blockNumber: B + 1n,
    },
  ],
  step: "tourist",
  tokenId: SENDER_ID,
  payment: "f24",
  quote: { input: 20_000n, blockNumber: B },
};

const VERIFIED: PayoutState = {
  flow: "payout",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "verified",
  tokenId: TOKEN_ID,
  currency: "EUR24",
  amount: INPUT,
  contactId: "EA-123456",
};

/** The draft→quoted guard round for an exact-in exchange: every decision read is on-chain. */
function exchangeTable(): Map<string, CallEntry[]> {
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: false }),
    accountEntries(OWNER, { historic: SENDER_ID }),
    new Map<string, CallEntry[]>([
      [
        `${DEPOSIT.toLowerCase()}:getExchangeRate`,
        [{ args: [EUR24, USD24], answer: { result: RATE } }],
      ],
      [
        `${DEPOSIT.toLowerCase()}:getSpread`,
        [{ args: [EUR24, USD24, false], answer: { result: SPREAD } }],
      ],
      [`${DEPOSIT.toLowerCase()}:marketClosed`, [{ answer: { result: false } }]],
      [`${EUR24.toLowerCase()}:balanceOf`, [{ args: [OWNER], answer: { result: 1000n } }]],
      [
        `${EUR24.toLowerCase()}:tokenTransferAllowed`,
        [{ args: [OWNER, TREASURY, INPUT], answer: { result: true } }],
      ],
      [`${EUR24.toLowerCase()}:convertToChf`, [{ args: [INPUT], answer: { result: INPUT } }]],
      [
        `${ACCOUNT.toLowerCase()}:checkLimit`,
        [{ args: [SENDER_ID, INPUT], answer: { result: true } }],
      ],
      [
        `${USD24.toLowerCase()}:tokenTransferAllowed`,
        [{ args: [CRYPTO, OWNER, OUTPUT], answer: { result: true } }],
      ],
    ]),
  );
  table.set(`${ACCOUNT.toLowerCase()}:ownerOf`, [
    { args: [SENDER_ID], answer: { result: OWNER } },
    { args: [9100n], answer: { result: TREASURY } },
    { args: [9105n], answer: { result: CRYPTO } },
  ]);
  return table;
}

/** The getAccount({tokenId}) round the onboarding tourist/kyc poll consumes. */
function accountByIdEntries(statusIndex: number): Map<string, CallEntry[]> {
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

describe("API fixtures contradicting chain do not change decisions", () => {
  test("exchange: the recorded /rates fixture disagrees with the chain quote — chain wins", async () => {
    const apiStub = stubFetch({
      "/rates": json(fixtureBody("public/rates.json")),
    });
    const api = createFiat24Api({ fetch: apiStub.fetch, now: NOW });
    const stub = makeFlowStub({ calls: exchangeTable(), storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const next = await advanceExchange({ ...deps, api }, EXCHANGE_DRAFT);
    // The decision output is the chain-computed quote, not the API's contradicting rate.
    expect(next.step).toBe("quoted");
    expect(next.quote?.output).toBe(OUTPUT);
    expect(next.quote?.rate).toBe(RATE);
    // The API was never consulted at all.
    expect(apiStub.calls).toStrictEqual([]);
  });

  test("card set-cap: /br cardActivation contradicts chain totalSupply — chain wins", async () => {
    const apiStub = stubFetch({
      "/timestamp": json('{"timestamp":1795328524822}'),
      "/br": json(fixtureBody("secured/br.json")), // cardActivation: 10 EUR, limits.max 100000
    });
    const api = createFiat24Api({ fetch: apiStub.fetch, now: NOW });
    const session = api.openSession({ tokenId: TOKEN_ID, signer: testSigner() });
    const stub = makeFlowStub({
      calls: mergeCalls(
        proxyAdminEntry(),
        availabilityEntries({ paused: false }),
        accountEntries(OWNER, { historic: TOKEN_ID }),
        new Map<string, CallEntry[]>([
          [`${EUR24.toLowerCase()}:allowance`, [{ args: [OWNER, CARD], answer: { result: 0n } }]],
          // chain supply 99 < cap 100 — below the /br cardActivation(10)'s suggestion either way.
          [`${EUR24.toLowerCase()}:totalSupply`, [{ answer: { result: 99n } }]],
        ]),
      ),
      storage: honestStorage(),
    });
    const { deps } = flowDeps(stub.client);
    await expectErrorAsync(
      async () => advanceCard({ ...deps, session }, SET_CAP),
      "unlimited-approval",
    );
    expect(apiStub.calls).toStrictEqual([]);
  });

  test("onboarding: /status-kyc COMPLETED while chain status is tourist stays kyc", async () => {
    const apiStub = stubFetch({
      [`/status-kyc?id=${SENDER_ID}`]: json(fixtureBody("public/status-kyc-9102.json")),
    });
    const api = createFiat24Api({ fetch: apiStub.fetch, now: NOW });
    // statusIndex 2 = tourist on chain, while the recorded API status is COMPLETED.
    const stub = makeFlowStub({ calls: accountByIdEntries(2) });
    const { deps } = flowDeps(stub.client);
    const next = await advanceOnboarding({ ...deps, api }, TOURIST);
    expect(next.step).toBe("kyc");
    expect(next.kyc).toBe("completed");
    expect(apiStub.calls.map((call) => call.url)).toStrictEqual([
      `https://api.fiat24.com/status-kyc?id=${SENDER_ID}`,
    ]);
  });

  test("payout: /br limits would allow the payout — the chain minimum decides", async () => {
    const apiStub = stubFetch({
      "/timestamp": json('{"timestamp":1795328524822}'),
      "/br": json(fixtureBody("secured/br.json")), // limits.max 100000, 2 contacts
    });
    const api = createFiat24Api({ fetch: apiStub.fetch, now: NOW });
    const session = api.openSession({ tokenId: TOKEN_ID, signer: testSigner() });
    const stub = makeFlowStub({
      calls: mergeCalls(
        proxyAdminEntry(),
        availabilityEntries({ paused: false }),
        accountEntries(OWNER, { historic: TOKEN_ID }),
        new Map<string, CallEntry[]>([
          // chain says the payout is below the minimum even though /br limits.max claims room.
          [`${EUR24.toLowerCase()}:minimalPayoutAmount`, [{ answer: { result: 1_000_000n } }]],
          [`${EUR24.toLowerCase()}:balanceOf`, [{ args: [OWNER], answer: { result: 1000n } }]],
          [
            `${EUR24.toLowerCase()}:tokenTransferAllowed`,
            [{ args: [OWNER, PAYOUT_DESK, INPUT], answer: { result: true } }],
          ],
          [`${EUR24.toLowerCase()}:convertToChf`, [{ args: [INPUT], answer: { result: INPUT } }]],
          [
            `${ACCOUNT.toLowerCase()}:checkLimit`,
            [{ args: [TOKEN_ID, INPUT], answer: { result: true } }],
          ],
        ]),
      ),
      storage: honestStorage(),
    });
    const { deps } = flowDeps(stub.client);
    await expectErrorAsync(
      async () => advancePayout({ ...deps, session }, VERIFIED),
      "below-minimum",
    );
    expect(apiStub.calls).toStrictEqual([]);
  });
});
