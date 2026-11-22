/**
 * R-04 — JSON numbers in amount and id positions must be safe integers or decimal strings; an
 * unsafe integer, an exponent form, a >15-significant-digit fraction or a non-scalar is
 * `invalid-response`, never silently rounded or dropped.
 */
import { describe, expect, test } from "vite-plus/test";

import { createFiat24Api } from "../../src/api/index.ts";
import type { Fiat24Api, Fiat24Session } from "../../src/api/index.ts";
import { DOC_QR, expectCode, fixtureBody, json, stubFetch, testSigner } from "./stub.ts";
import type { Route } from "./stub.ts";

const TOKEN_ID = 690333n;
const SERVER_MS = 1_795_328_524_822;
const UNSAFE = "9007199254740993"; // 2^53 + 1

function sessionApi(routes: Record<string, Route>): { api: Fiat24Api; session: Fiat24Session } {
  const stub = stubFetch({
    "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
    ...routes,
  });
  const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
  return {
    api,
    session: api.openSession({ tokenId: TOKEN_ID, signer: testSigner() }),
  };
}

function transactionsBody(amount: string, extra = ""): string {
  return `{"count":1,"transactions":[{"title":"x","subtitle":"y","amount":${amount},"timestamp":1683221111000${extra}}]}`;
}

function brWithActivation(amount: string): string {
  return fixtureBody("secured/br.json").replace(
    '"cardActivation":{"amount":10,"currency":"EUR"}',
    `"cardActivation":{"amount":${amount},"currency":"EUR"}`,
  );
}

describe("display decimals (R-04)", () => {
  test.each([
    ["-1.89", "-1.89"],
    ["29405", "29405"],
    ['"29405.00"', "29405.00"],
    ["0.1", "0.1"],
    ["0.123456789012345", "0.123456789012345"],
  ])("transactions amount %s comes back as %s", async (raw, expected) => {
    const { session } = sessionApi({
      "/transactions?currency=EUR": json(transactionsBody(raw)),
    });
    const page = await session.transactions({ currency: "EUR" });
    expect(page.transactions[0]?.amount).toBe(expected);
  });

  test.each([
    UNSAFE,
    "1e21",
    "1e-7",
    "0.30000000000000004",
    "0.3000000000000001",
    "12345678901234567890",
    "null",
    "true",
    '"1e3"',
    '"10.5.0"',
    "{}",
  ])("transactions amount %s is invalid-response", async (raw) => {
    expect.hasAssertions();
    const { session } = sessionApi({
      "/transactions?currency=EUR": json(transactionsBody(raw)),
    });
    await expectCode(async () => session.transactions({ currency: "EUR" }), "invalid-response");
  });

  test.each([[UNSAFE], ["12345678901234567890"], ["1e-7"], ["null"], ['"1e3"']])(
    "cardActivation.amount %s is invalid-response",
    async (raw) => {
      expect.hasAssertions();
      const { session } = sessionApi({ "/br": json(brWithActivation(raw)) });
      await expectCode(async () => session.profile(), "invalid-response");
    },
  );

  test.each([
    ["29405", "29405"],
    ['"10.50"', "10.50"],
    ["-1.89", "-1.89"],
  ])("cardActivation.amount %s comes back as %s", async (raw, expected) => {
    const { session } = sessionApi({ "/br": json(brWithActivation(raw)) });
    const profile = await session.profile();
    expect(profile.cardActivation?.amount).toBe(expected);
  });
});

describe("transaction ids (R-04)", () => {
  test.each([
    ['"238639288"', 238639288n],
    ["42", 42n],
    ["0", 0n],
  ])("blockNumber %s is kept as %s", async (raw, expected) => {
    const { session } = sessionApi({
      "/transactions?currency=EUR": json(transactionsBody('"1.00"', `,"blockNumber":${raw}`)),
    });
    const page = await session.transactions({ currency: "EUR" });
    expect(page.transactions[0]?.blockNumber).toBe(expected);
  });

  test.each([
    ["unsafe number", `,"from":${UNSAFE}`],
    ["negative number", ',"to":-5'],
    ["fraction", ',"blockNumber":1.5'],
    ["null", ',"from":null'],
    ["non-canonical string", ',"to":"0123"'],
    ["non-decimal string", ',"blockNumber":"0x10"'],
    ["boolean", ',"from":true'],
    ["object", ',"to":{}'],
  ])("a present %s id is invalid-response", async (_name, extra) => {
    expect.hasAssertions();
    const { session } = sessionApi({
      "/transactions?currency=EUR": json(transactionsBody('"1.00"', extra)),
    });
    await expectCode(async () => session.transactions({ currency: "EUR" }), "invalid-response");
  });

  test("a malformed txId is still dropped, not coerced", async () => {
    const { session } = sessionApi({
      "/transactions?currency=EUR": json(transactionsBody('"1.00"', ',"txId":"0x12"')),
    });
    const page = await session.transactions({ currency: "EUR" });
    expect(page.transactions[0]?.txId).toBeUndefined();
  });
});

describe("safe-integer positions (R-04)", () => {
  const QR_BODY = (amount: string): string =>
    JSON.stringify({
      type: "QRCH",
      account: "LI7830174502999200012",
      clientPayoutRefParams: {
        currency: "CHF24",
        amount: JSON.parse(amount),
        contactId: "QRCH",
        purposeId: 101,
        ref: "690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000",
      },
      creditor: { name: "x" },
    });

  const POSITIONS: ReadonlyArray<{
    readonly name: string;
    readonly route: string;
    readonly body: string;
    readonly run: (api: Fiat24Api, session: Fiat24Session) => Promise<unknown>;
  }> = [
    {
      name: "/timestamp timestamp",
      route: "/timestamp",
      body: `{"timestamp":${UNSAFE}}`,
      run: async (api) => api.timestamp(),
    },
    {
      name: "/payment-purposes purposeId",
      route: "/payment-purposes",
      body: `{"purposes":[{"value":${UNSAFE},"name":"x"}]}`,
      run: async (api) => api.paymentPurposes(),
    },
    {
      name: "/banks lastUpdateAt",
      route: "/banks",
      body: `{"lastUpdateAt":${UNSAFE},"banks":{}}`,
      run: async (api) => api.banks(),
    },
    {
      name: "/country-cities lastUpdateAt",
      route: "/country-cities",
      body: `{"lastUpdateAt":${UNSAFE},"countries":{}}`,
      run: async (api) => api.countryCities(),
    },
    {
      name: "/br tokenId",
      route: "/br",
      body: fixtureBody("secured/br.json").replace('"tokenId":690333', `"tokenId":${UNSAFE}`),
      run: async (_api, session) => session.profile(),
    },
    {
      name: "/cards statusCode",
      route: "/cards",
      body: `{"statusCode":${UNSAFE},"body":[]}`,
      run: async (_api, session) => session.cards(),
    },
    {
      name: "/cards deviceToken createdAt",
      route: "/cards",
      body: fixtureBody("secured/cards-ok.json").replace(
        '"createdAt":1725523620885',
        `"createdAt":${UNSAFE}`,
      ),
      run: async (_api, session) => session.cards(),
    },
    {
      name: "/transactions count",
      route: "/transactions?currency=EUR",
      body: `{"count":${UNSAFE},"transactions":[]}`,
      run: async (_api, session) => session.transactions({ currency: "EUR" }),
    },
    {
      name: "/transactions timestamp",
      route: "/transactions?currency=EUR",
      body: `{"count":1,"transactions":[{"title":"x","subtitle":"y","amount":"1.00","timestamp":${UNSAFE}}]}`,
      run: async (_api, session) => session.transactions({ currency: "EUR" }),
    },
    {
      name: "/verify?qr amount",
      route: `/verify?qr=${encodeURIComponent(DOC_QR)}`,
      body: QR_BODY(UNSAFE),
      run: async (_api, session) => session.verifySwissQr(DOC_QR),
    },
  ];

  test.each(POSITIONS)("$name 2^53+1 is invalid-response", async (position) => {
    expect.hasAssertions();
    const { api, session } = sessionApi({ [position.route]: json(position.body) });
    await expectCode(async () => position.run(api, session), "invalid-response");
  });
});
