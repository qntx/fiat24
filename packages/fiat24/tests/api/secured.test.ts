import { describe, expect, test } from "vite-plus/test";

import { createFiat24Api } from "../../src/api/index.ts";
import type { Fiat24Error } from "../../src/core/index.ts";
import { isFiat24Error } from "../../src/core/index.ts";
import { caught, expectCode, fixtureBody, json, stubFetch, testSigner } from "./stub.ts";
import type { Route } from "./stub.ts";

const TOKEN_ID = 690333n;
const SERVER_MS = 1_795_328_524_822;

function sessionApi(routes: Record<string, Route>) {
  const stub = stubFetch({
    "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
    ...routes,
  });
  const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
  const session = api.openSession({ tokenId: TOKEN_ID, signer: testSigner() });
  return { api, session, calls: stub.calls };
}

const jsonPrint = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

const CARD_BODY = {
  statusCode: 200,
  body: [
    {
      externalId: "x",
      status: "Hold",
      currency: "CHF24",
      currencies: ["CHF"],
      masked: { cardNumber: "xxxx 9999" },
    },
  ],
};

describe("secured reads", () => {
  test("doc /br maps to the hand-written Profile", async () => {
    const { session } = sessionApi({ "/br": json(fixtureBody("secured/br.json")) });
    const profile = await session.profile();
    expect(profile).toStrictEqual({
      tokenId: 690333n,
      name: "PII-SENTINEL-1",
      email: "PII-SENTINEL-3",
      mobile: "PII-SENTINEL-4",
      address: {
        street: "PII-SENTINEL-5",
        postalCode: "PII-SENTINEL-6",
        city: "PII-SENTINEL-7",
        country: "ESP",
      },
      contacts: {
        CHF: [
          {
            id: "EC-0000001",
            name: "PII-SENTINEL-8",
            account: "•••• 0001",
            bank: "PostFinance",
            country: "CH",
          },
        ],
        EUR: [
          {
            id: "EC-0000002",
            name: "PII-SENTINEL-10",
            account: "•••• 1234",
            bank: "PostFinance",
            country: "ES",
          },
        ],
      },
      isCardEligible: true,
      cardActivation: { amount: "10", currency: "EUR" },
    });
    expect(Object.isFrozen(profile)).toBe(true);
  });

  test.each([
    [10, "10"],
    ["10.50", "10.50"],
  ])("cardActivation amount %s => %s", async (amount, expected) => {
    const body = JSON.parse(fixtureBody("secured/br.json")) as Record<string, unknown>;
    body["cardActivation"] = { amount, currency: "EUR" };
    const { session } = sessionApi({ "/br": json(JSON.stringify(body)) });
    const profile = await session.profile();
    expect(profile.cardActivation?.amount).toBe(expected);
  });

  test("cardActivation amount 1e21 => invalid-response", async () => {
    const body = JSON.parse(fixtureBody("secured/br.json")) as Record<string, unknown>;
    const raw = JSON.stringify(body).replace(
      '"cardActivation":{"amount":10,"currency":"EUR"}',
      '"cardActivation":{"amount":1e21,"currency":"EUR"}',
    );
    // V8 emits 1e+21, Hermes/JSC 1e21 — the exponent form must reach the parser either way.
    expect(raw).toMatch(/"amount":1e\+?21/);
    const { session } = sessionApi({ "/br": json(raw) });
    await expectCode(async () => session.profile(), "invalid-response");
  });

  test("doc /cards maps to Card; cardToken never leaks", async () => {
    const { session } = sessionApi({ "/cards": json(fixtureBody("secured/cards-ok.json")) });
    const cards = await session.cards();
    expect(cards).toStrictEqual([
      {
        externalId: "123456",
        status: "active",
        currency: "EUR24",
        currencies: ["EUR", "CHF", "USD", "CNH"],
        last4: "4455",
        activeTokens: [{ id: "active_token_id", type: "Fiat24 Phone", createdAt: 1725523620885n }],
        inactiveTokens: [
          { id: "inactive_token_id", type: "Fiat24 Phone", createdAt: 1725523620885n },
        ],
      },
    ]);
    const card = cards.at(0);
    expect(card).toBeDefined();
    expect("cardToken" in (card as Record<string, unknown>)).toBe(false);
    const printed = jsonPrint(cards);
    expect(printed).not.toContain("cardToken");
    expect(printed).not.toContain("PII-SENTINEL-31");
  });

  test("{statusCode:404} => [], {statusCode:500} => api-rejected, unknown status => unknown", async () => {
    const empty = sessionApi({ "/cards": json('{"statusCode":404}') });
    await expect(empty.session.cards()).resolves.toStrictEqual([]);
    const nok = sessionApi({ "/cards": json(fixtureBody("secured/cards-nok.json")) });
    const error = await caught(async () => nok.session.cards());
    expect(isFiat24Error(error)).toBe(true);
    const rejected = error as Fiat24Error;
    expect(rejected.code).toBe("api-rejected");
    expect((rejected.detail as Record<string, unknown>)["status"]).toBe(500);
    const unknown = sessionApi({ "/cards": json(JSON.stringify(CARD_BODY)) });
    const cards = await unknown.session.cards();
    expect(cards[0]?.status).toBe("unknown");
    expect(cards[0]?.last4).toBe("9999");
  });

  test("cardDisplayToken hit / miss / 404", async () => {
    const { session } = sessionApi({ "/cards": json(fixtureBody("secured/cards-ok.json")) });
    await expect(session.cardDisplayToken("123456")).resolves.toBe("PII-SENTINEL-31");
    await expectCode(async () => session.cardDisplayToken("999999"), "api-rejected");
    const empty = sessionApi({ "/cards": json('{"statusCode":404}') });
    await expectCode(async () => empty.session.cardDisplayToken("123456"), "api-rejected");
    const noToken = sessionApi({
      "/cards": json(
        JSON.stringify({
          statusCode: 200,
          body: [
            {
              externalId: "123456",
              status: "Active",
              currency: "EUR24",
              currencies: ["EUR"],
              masked: { cardNumber: "•••• 4455" },
            },
          ],
        }),
      ),
    });
    await expectCode(async () => noToken.session.cardDisplayToken("123456"), "api-rejected");
    // An empty cardToken is not displayable (§9.4).
    const emptyToken = sessionApi({
      "/cards": json(
        JSON.stringify({
          statusCode: 200,
          body: [
            {
              externalId: "123456",
              status: "Active",
              currency: "EUR24",
              currencies: ["EUR"],
              masked: { cardNumber: "•••• 4455" },
              cardToken: "",
            },
          ],
        }),
      ),
    });
    await expectCode(async () => emptyToken.session.cardDisplayToken("123456"), "api-rejected");
  });

  test.each([
    [
      { currency: "EUR", fromRecord: 0n, recordsCount: 6n },
      "/transactions?currency=EUR&fromrecord=0&recordscount=6",
    ],
    [
      { currency: "EUR", fromTimestamp: 1683797408116n, toTimestamp: 1683897408116n },
      "/transactions?currency=EUR&fromtimestamp=1683797408116&totimestamp=1683897408116",
    ],
    [
      { currency: "USD", fromRecord: 0n, recordsCount: 50n, fromTimestamp: 1683797408116n },
      "/transactions?currency=USD&fromrecord=0&recordscount=50&fromtimestamp=1683797408116",
    ],
    [
      { currency: "USD", fromRecord: 51n, recordsCount: 50n, fromTimestamp: 1683797408116n },
      "/transactions?currency=USD&fromrecord=51&recordscount=50&fromtimestamp=1683797408116",
    ],
    [
      { currency: "ALL", direction: "IN", types: ["P2P", "CWD"] },
      "/transactions?currency=ALL&direction=IN&type=P2P,CWD",
    ],
  ])("transactions query #%#", async (query, path) => {
    const { session, calls } = sessionApi({
      [path]: json(fixtureBody("secured/transactions.json")),
    });
    await session.transactions(query as Parameters<typeof session.transactions>[0]);
    expect(calls[1]?.url).toBe(`https://api.fiat24.com${path}`);
  });

  test.each([
    [{ currency: "GBP" }],
    [{ currency: "EUR", recordsCount: 0n }],
    [{ currency: "EUR", recordsCount: 1001n }],
    [{ currency: "EUR", fromRecord: -1n }],
    [{ currency: "EUR", fromTimestamp: 9007199254740992n }],
    [{ currency: "EUR", direction: "in" }],
    [{ currency: "EUR", types: [] }],
    [{ currency: "EUR", types: ["P2P", "FRX", "CTU", "CRD", "CDP", "CWD", "XXX"] }],
    [{ currency: "EUR", types: ["XXX"] }],
  ])("invalid transactions query #%# refused before I/O", async (query) => {
    const { session, calls } = sessionApi({});
    await expectCode(
      async () => session.transactions(query as Parameters<typeof session.transactions>[0]),
      "invalid-argument",
    );
    expect(calls).toHaveLength(0);
  });

  test("doc transactions response mapping", async () => {
    const { session } = sessionApi({
      "/transactions?currency=EUR": json(fixtureBody("secured/transactions.json")),
    });
    const page = await session.transactions({ currency: "EUR" });
    expect(page.count).toBe(6n);
    const t0 = page.transactions.at(0);
    const t3 = page.transactions.at(3);
    expect(t0?.amount).toBe("-1.89");
    expect(t0?.timestamp).toBe(1683221111000n);
    expect(t0?.txId).toBe("0x815da6bf2b2767c61e11f2378e31d2e92c397b860e18c80b0ed7fb05ed5897a2");
    expect(t0?.from).toBe(9105n);
    expect(t0?.to).toBe(903n);
    expect(t0?.blockNumber).toBe(238639288n);
    expect(t3?.amount).toBe("29405.00");
  });

  test("10-digit timestamp is scaled to ms", async () => {
    const body = JSON.stringify({
      count: 1,
      transactions: [
        {
          title: "x",
          subtitle: "y",
          amount: "-1.89",
          timestamp: 1683221111,
        },
      ],
    });
    const { session } = sessionApi({ "/transactions?currency=EUR": json(body) });
    const page = await session.transactions({ currency: "EUR" });
    expect(page.transactions[0]?.timestamp).toBe(1683221111000n);
  });

  test("lossy fields are dropped, never coerced", async () => {
    const body =
      '{"count":1,"transactions":[{"title":"x","subtitle":"y","amount":"1.00","timestamp":1683221111000,"txId":"0x12","from":9007199254740993,"to":"0010","blockNumber":"0123"}]}';
    const { session } = sessionApi({ "/transactions?currency=EUR": json(body) });
    const page = await session.transactions({ currency: "EUR" });
    const t = page.transactions.at(0);
    expect(t?.txId).toBeUndefined();
    expect(t?.from).toBeUndefined();
    expect(t?.to).toBeUndefined();
    expect(t?.blockNumber).toBeUndefined();
  });

  test("amount 1e21 and a 12-digit timestamp => invalid-response", async () => {
    expect.hasAssertions();
    const badAmount =
      '{"count":1,"transactions":[{"title":"x","subtitle":"y","amount":1e21,"timestamp":1683221111000}]}';
    const { session } = sessionApi({ "/transactions?currency=EUR": json(badAmount) });
    await expectCode(async () => session.transactions({ currency: "EUR" }), "invalid-response");
    const badTs =
      '{"count":1,"transactions":[{"title":"x","subtitle":"y","amount":"1.00","timestamp":168322111100}]}';
    const other = sessionApi({ "/transactions?currency=EUR": json(badTs) });
    await expectCode(
      async () => other.session.transactions({ currency: "EUR" }),
      "invalid-response",
    );
  });
});
