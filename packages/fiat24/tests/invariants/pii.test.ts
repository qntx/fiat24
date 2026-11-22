import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { encodeAbiParameters, encodeFunctionData, getAddress } from "viem";
import type { Address } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import { createFiat24Api } from "../../src/api/index.ts";
import type {
  Fiat24Api,
  Fiat24Session,
  VerifiedPayout,
  VerifiedQrPayout,
} from "../../src/api/index.ts";
import { topic0Of } from "../../src/chain/context.ts";
import { Fiat24Error } from "../../src/core/errors.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceCard, advancePayout, encodeFlowState, startPayout } from "../../src/flows/index.ts";
import type { CardState, FlowState, PayoutDraft } from "../../src/flows/index.ts";
import {
  DOC_QR,
  caught,
  expectRedacted,
  fixtureBody,
  json,
  stubFetch,
  testSigner,
} from "../api/stub.ts";
import type { Route } from "../api/stub.ts";
import type { CallEntry } from "../chain/stub.ts";
import {
  accountEntries,
  addressTopic,
  availabilityEntries,
  B,
  flowDeps,
  honestStorage,
  logPayload,
  makeFlowStub,
  makeSigner,
  mergeCalls,
  OWNER,
  proxyAdminEntry,
  receiptPayload,
  txPayload,
  TXID_1,
  word,
} from "../flows/stub.ts";

const TOKEN_ID = 690333n;
const SERVER_MS = 1_795_328_524_822;

const BANK_REQUEST = {
  account: "LI7830174502999200012",
  bankName: "PII-SENTINEL-80",
  bic: "SAHHCHZ2",
  purpose: 2n,
  reference: "PII-SENTINEL-81",
  creditor: "BR" as const,
};

const SP_PATH = `/verify?sp=${encodeURIComponent(
  JSON.stringify({
    account: BANK_REQUEST.account,
    bankName: BANK_REQUEST.bankName,
    bic: BANK_REQUEST.bic,
    purpose: 2,
    reference: BANK_REQUEST.reference,
    creditor: "BR",
  }),
)}`;

// A QR whose creditor/debtor names are sentinels.
const SENTINEL_QR = DOC_QR.replace("Robert Schneider AG", "PII-SENTINEL-82").replace(
  "Hans Mustermann",
  "PII-SENTINEL-83",
);
const QR_PATH = `/verify?qr=${encodeURIComponent(SENTINEL_QR)}`;

const SECURED = fileURLToPath(new URL("../fixtures/api/secured", import.meta.url));

const SENTINEL_PATHS = {
  "/countries": true,
  "/rates": true,
  "/payment-purposes": true,
  "/banks": true,
  "/banks/iban/CH9300762011623852957": true,
  "/country-cities": true,
  "/status-kyc?id=1": true,
  "/br": true,
  "/cards": true,
  "/transactions?currency=EUR": true,
  [SP_PATH]: true,
  [QR_PATH]: true,
  "/card": true,
  "/card-status": true,
  "/card-currency": true,
  "/card-device-token": true,
} as const;

function routesFor(body: string): Record<string, Route> {
  return {
    "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
    ...Object.fromEntries(Object.keys(SENTINEL_PATHS).map((path) => [path, json(body)])),
  };
}

// Runs every API method against the routed fixture body and collects the thrown errors.
async function collectErrors(api: Fiat24Api, session: Fiat24Session): Promise<unknown[]> {
  const calls: ReadonlyArray<() => Promise<unknown>> = [
    async () => api.timestamp(),
    async () => api.countries(),
    async () => api.rates(),
    async () => api.paymentPurposes(),
    async () => api.banks(),
    async () => api.bankByIban("CH9300762011623852957"),
    async () => api.countryCities(),
    async () => api.kycStatus(1n),
    async () => session.profile(),
    async () => session.cards(),
    async () => session.cardDisplayToken("123456"),
    async () => session.transactions({ currency: "EUR" }),
    async () => session.verifyBankPayment(BANK_REQUEST),
    async () => session.verifySwissQr(SENTINEL_QR),
    async () => session.createCard(),
    async () => session.setCardStatus({ externalId: "123456", status: "block" }),
    async () => session.setCardCurrency({ externalId: "123456", currency: "EUR" }),
    async () =>
      session.setDeviceToken({ externalId: "123456", cardTokenId: "t", status: "deactivate" }),
  ];
  const results = await Promise.allSettled(calls.map(async (call) => call()));
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

const TRAPPED = ["localStorage", "sessionStorage", "indexedDB", "document", "console"] as const;

function trap(name: string, touched: string[]) {
  return new Proxy(() => {}, {
    get(_t, p) {
      touched.push(`${name}.${String(p)}`);
      throw new Error(`${name} touched`);
    },
    set(_t, p) {
      touched.push(`${name}.${String(p)}`);
      throw new Error(`${name} touched`);
    },
    apply() {
      touched.push(`${name}()`);
      throw new Error(`${name} called`);
    },
  });
}

function installTraps(touched: string[]): Record<string, unknown> {
  const globals = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(TRAPPED.map((name) => [name, globals[name]]));
  for (const name of TRAPPED) {
    globals[name] = trap(name, touched);
  }
  return saved;
}

function restoreGlobals(saved: Record<string, unknown>): void {
  const globals = globalThis as Record<string, unknown>;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      Reflect.deleteProperty(globals, name);
    } else {
      globals[name] = value;
    }
  }
}

// Runs every API method over every secured fixture plus the {error:"PII-SENTINEL-…"} body and
// collects everything thrown.
async function runAll(): Promise<unknown[]> {
  const fixtureFiles = readdirSync(SECURED).filter((f) => f.endsWith(".json"));
  expect(fixtureFiles.length).toBeGreaterThan(15);
  const perFixture = await Promise.all(
    fixtureFiles.map(async (file) => {
      const stub = stubFetch(routesFor(fixtureBody(`secured/${file}`)));
      const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
      const session = api.openSession({ tokenId: TOKEN_ID, signer: testSigner() });
      return collectErrors(api, session);
    }),
  );
  const stub = stubFetch({
    "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
    "/br": json(JSON.stringify({ error: "PII-SENTINEL-99" })),
  });
  const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
  const session = api.openSession({ tokenId: TOKEN_ID, signer: testSigner() });
  return [...perFixture.flat(), await caught(async () => session.profile())];
}

// I6/I7: the SDK never touches ambient storage/DOM/log surfaces and never leaks PII into errors.
describe("API PII invariants", () => {
  test("no ambient storage, DOM or console access", async () => {
    const touched: string[] = [];
    const saved = installTraps(touched);
    try {
      await runAll();
    } finally {
      restoreGlobals(saved);
    }
    expect(touched).toStrictEqual([]);
  });

  test("errors", async () => {
    const errors = await runAll();
    for (const error of errors) {
      expectRedacted(error);
    }
    expect(errors.length).toBeGreaterThan(0);
  });
});

const EUR24 = C.tokens.EUR24.proxy;
const ACCOUNT = C.account.proxy;
const OWNER_CS = getAddress(OWNER);
const PAYOUT_DESK = "0x0000000000000000000000000000000000009102" as Address;

const QR_AMOUNT = 194975n;
const QR_PURPOSE_ID = 101n;
const SP_REF = "690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000";

function stringifyBig(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v));
}

const CARD_CREATE: CardState = {
  flow: "card",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "ready",
  tokenId: TOKEN_ID,
  operation: { kind: "create" },
};

const CARD_BLOCK: CardState = {
  ...CARD_CREATE,
  operation: { kind: "block", externalId: "123456" },
};

const CARD_BLOCK_MISSING: CardState = {
  ...CARD_CREATE,
  operation: { kind: "block", externalId: "DOES-NOT-EXIST" },
};

/** Pushes an error's message and detail into the haystack for the sentinel sweep. */
function collectError(haystack: string[], error: unknown): void {
  if (error instanceof Fiat24Error) {
    haystack.push(error.message);
    haystack.push(JSON.stringify(error.detail));
  } else {
    haystack.push(String(error));
  }
}

/** The verified→tx guard round for a bank-verified EUR24 payout of 100 to EA-123456. */
function payoutChainTable(ref: string): Map<string, CallEntry[]> {
  const token = EUR24.toLowerCase();
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: false }),
    accountEntries(OWNER, { historic: TOKEN_ID }),
    new Map<string, CallEntry[]>([
      [`${token}:minimalPayoutAmount`, [{ answer: { result: 5n } }]],
      [`${token}:balanceOf`, [{ args: [OWNER], answer: { result: 1000n } }]],
      [
        `${token}:tokenTransferAllowed`,
        [{ args: [OWNER, PAYOUT_DESK, 100n], answer: { result: true } }],
      ],
      [`${token}:convertToChf`, [{ args: [100n], answer: { result: 100n } }]],
      [
        `${ACCOUNT.toLowerCase()}:checkLimit`,
        [{ args: [TOKEN_ID, 100n], answer: { result: true } }],
      ],
      [`${token}:clientPayoutRef`, [{ args: [100n, "EA-123456", 2n, ref], answer: { raw: "0x" } }]],
    ]),
  );
  table.set(`${ACCOUNT.toLowerCase()}:ownerOf`, [
    { args: [TOKEN_ID], answer: { result: OWNER } },
    { args: [9102n], answer: { result: PAYOUT_DESK } },
  ]);
  return table;
}

/** The ClientPayoutRef evidence log for the confirmed leg. */
function payoutRefLog(ref: string): Record<string, unknown> {
  return logPayload({
    address: EUR24,
    topics: [topic0Of(tokenAbi, "ClientPayoutRef"), word(TOKEN_ID), addressTopic(OWNER)],
    data: encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "string" },
        { type: "string" },
        { type: "uint256" },
        { type: "string" },
      ],
      [9102n, 100n, "EA-123456", "pacs.008-pii", 2n, ref],
    ),
    blockNumber: B + 1n,
    transactionHash: TXID_1,
  });
}

// I6/I7 for the flows layer: sentinel PII may live in the in-memory draft and cross the API
// boundary, but it must never reach a persisted state, an encoded state, or a thrown error.
describe("flow PII invariants", () => {
  test("payout and card flows never persist or throw sentinel PII", async () => {
    const touched: string[] = [];
    const haystack: string[] = [];
    const persist = async (state: FlowState): Promise<void> => {
      haystack.push(stringifyBig(state));
      haystack.push(encodeFlowState(state));
      return Promise.resolve();
    };
    const collect = (error: unknown): void => {
      collectError(haystack, error);
    };
    const saved = installTraps(touched);
    try {
      const { signer } = makeSigner(OWNER);
      const empty = makeFlowStub({});
      const { deps } = flowDeps(empty.client, { signer });
      const flowDepsWith = (session: Fiat24Session) => ({ ...deps, persist, session });

      // bank draft → verified through a real session (sentinels in the request).
      const bankApi = createFiat24Api({
        fetch: stubFetch({
          "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
          [SP_PATH]: json(fixtureBody("secured/verify-sp.json")),
        }).fetch,
        now: () => SERVER_MS,
      });
      const bankDraft: PayoutDraft = startPayout({
        owner: OWNER,
        tokenId: TOKEN_ID,
        currency: "EUR24",
        amount: 100n,
        target: { kind: "bank", request: BANK_REQUEST },
      });
      try {
        encodeFlowState(bankDraft as unknown as FlowState);
      } catch (error) {
        collect(error);
      }
      const verifiedBank = await advancePayout(
        flowDepsWith(bankApi.openSession({ tokenId: TOKEN_ID, signer: testSigner() })),
        bankDraft,
      );
      expect(verifiedBank.step).toBe("verified");
      expect(verifiedBank.ref).toBe(SP_REF);

      // QR draft → verified through a real session (sentinel names inside the QR).
      const qrApi = createFiat24Api({
        fetch: stubFetch({
          "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
          [QR_PATH]: json(fixtureBody("secured/verify-qr.json")),
        }).fetch,
        now: () => SERVER_MS,
      });
      const qrDraft: PayoutDraft = startPayout({
        owner: OWNER,
        tokenId: TOKEN_ID,
        currency: "CHF24",
        amount: QR_AMOUNT,
        target: { kind: "swiss-qr", qr: SENTINEL_QR },
      });
      try {
        encodeFlowState(qrDraft as unknown as FlowState);
      } catch (error) {
        collect(error);
      }
      const verifiedQr = await advancePayout(
        flowDepsWith(qrApi.openSession({ tokenId: TOKEN_ID, signer: testSigner() })),
        qrDraft,
      );
      expect(verifiedQr.step).toBe("verified");
      expect(verifiedQr.contactId).toBe("QRCH");

      // The verified bank payout drives the full chain leg: submitted then confirmed.
      const txStub = makeFlowStub({
        calls: payoutChainTable(SP_REF),
        storage: honestStorage(),
        count: { pending: 5 },
        receipts: {
          [TXID_1]: receiptPayload({
            transactionHash: TXID_1,
            blockNumber: B + 1n,
            status: "success",
            logs: [payoutRefLog(SP_REF)],
          }),
        },
        transactions: {
          [TXID_1]: txPayload({
            hash: TXID_1,
            from: OWNER,
            to: EUR24,
            input: encodeFunctionData({
              abi: tokenAbi,
              functionName: "clientPayoutRef",
              args: [100n, "EA-123456", 2n, SP_REF],
            }),
            value: 0n,
            nonce: 5,
            blockNumber: B + 1n,
          }),
        },
      });
      const { deps: txBase } = flowDeps(txStub.client, { signer });
      const txDeps = { ...txBase, persist };
      const submitted = await advancePayout(txDeps, verifiedBank);
      expect(submitted.step).toBe("tx");
      const confirmed = await advancePayout(txDeps, submitted);
      expect(confirmed.step).toBe("confirmed");
      expect(confirmed.txid).toBe("pacs.008-pii");

      // Hostile verified responses whose bindings carry sentinels fail api-mismatch.
      const hostileBank: VerifiedPayout = {
        contactId: "PII-SENTINEL-90",
        purposeId: 2n,
        ref: SP_REF,
      };
      const hostileQr: VerifiedQrPayout = {
        contactId: "QRCH",
        purposeId: QR_PURPOSE_ID,
        ref: SP_REF,
        currency: "CHF24",
        amount: QR_AMOUNT,
        account: "PII-SENTINEL-91",
        creditor: { name: "PII-SENTINEL-92" },
      };
      const hostile = {
        tokenId: TOKEN_ID,
        verifyBankPayment: async () => Promise.resolve(hostileBank),
        verifySwissQr: async () => Promise.resolve(hostileQr),
      } as unknown as Fiat24Session;
      try {
        await advancePayout(flowDepsWith(hostile), bankDraft);
      } catch (error) {
        collect(error);
      }
      try {
        await advancePayout(flowDepsWith(hostile), qrDraft);
      } catch (error) {
        collect(error);
      }

      // card create → confirmed through a real session; block against cards-ok whose
      // cardHolder/cardToken are sentinels; a missing card fails api-rejected.
      const cardApi = createFiat24Api({
        fetch: stubFetch({
          "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
          "/br": json(fixtureBody("secured/br.json")),
          "/cards": json(fixtureBody("secured/cards-ok.json")),
          "/card": json(fixtureBody("secured/write-ok.json")),
          "/card-status": json(fixtureBody("secured/write-ok.json")),
        }).fetch,
        now: () => SERVER_MS,
      });
      const cardSession = cardApi.openSession({ tokenId: TOKEN_ID, signer: testSigner() });
      const cardDeps = { ...deps, persist, session: cardSession };
      const createApi = createFiat24Api({
        fetch: stubFetch({
          "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
          "/br": json(fixtureBody("secured/br.json")),
          "/cards": json(JSON.stringify({ statusCode: 200, body: [] })),
          "/card": json(fixtureBody("secured/write-ok.json")),
        }).fetch,
        now: () => SERVER_MS,
      });
      const created = await advanceCard(
        {
          ...deps,
          persist,
          session: createApi.openSession({ tokenId: TOKEN_ID, signer: testSigner() }),
        },
        CARD_CREATE,
      );
      expect(created.step).toBe("confirmed");
      const blocked = await advanceCard(cardDeps, CARD_BLOCK);
      expect(blocked.step).toBe("confirmed");
      try {
        await advanceCard(cardDeps, CARD_BLOCK_MISSING);
      } catch (error) {
        collect(error);
      }
    } finally {
      restoreGlobals(saved);
    }
    expect(touched).toStrictEqual([]);
    const joined = haystack.join("\n");
    expect(joined).not.toContain("PII-SENTINEL");
  });
});
