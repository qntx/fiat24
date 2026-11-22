import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { createFiat24Api } from "../../src/api/index.ts";
import type { Fiat24Api, Fiat24Session } from "../../src/api/index.ts";
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
