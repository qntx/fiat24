import { createHash } from "node:crypto";

import { describe, expect, test } from "vite-plus/test";

import { createFiat24Api } from "../../src/api/index.ts";
import type { Fiat24Api } from "../../src/api/index.ts";
import {
  clock,
  expectApiError,
  expectCode,
  fixtureBody,
  fixtureText,
  json,
  stubFetch,
  testSigner,
} from "./stub.ts";

const SERVER_MS = 1_795_328_524_822;

function publicApi(routes: Record<string, ReturnType<typeof json>>) {
  const stub = stubFetch(routes);
  const api = createFiat24Api({ fetch: stub.fetch, now: clock(SERVER_MS).now });
  return { api, calls: stub.calls };
}

const HOSTILE_BODIES: ReadonlyArray<readonly [string, string, string]> = [
  ["wrong type", "/timestamp", '{"timestamp":"soon"}'],
  ["negative", "/timestamp", '{"timestamp":-1}'],
  ["fractional", "/timestamp", '{"timestamp":1.5}'],
  ["unsafe int", "/timestamp", fixtureBody("secured/unsafe-int.json")],
  [
    "lowercase iso",
    "/countries",
    '{"eligibleDomiciles":["che"],"eligibleDomicilesForCards":[],"lowLimitDomiciles":[],"blacklistNationalities":[]}',
  ],
  ["1025-char string", "/status-kyc?id=1", `{"status":"${"a".repeat(1025)}"}`],
  [
    "10001-item array",
    "/payment-purposes",
    `{"purposes":${JSON.stringify(Array.from({ length: 10_001 }, (_, i) => ({ value: i % 10, name: "x" })))}}`,
  ],
];

const HOSTILE_RUNS: Record<string, (api: Fiat24Api) => Promise<unknown>> = {
  "/timestamp": async (api) => api.timestamp(),
  "/countries": async (api) => api.countries(),
  "/status-kyc?id=1": async (api) => api.kycStatus(1n),
  "/payment-purposes": async (api) => api.paymentPurposes(),
};

type RawRates = Record<string, { rate: number; bid: number; ask: number; lastUpdateAt: number }>;

const rateEntry = (raw: RawRates, pair: string) => {
  const entry = raw[pair];
  if (entry === undefined) {
    return undefined;
  }
  return {
    rate: entry.rate,
    bid: entry.bid,
    ask: entry.ask,
    lastUpdateAt: BigInt(entry.lastUpdateAt),
  };
};

const purposeAt = (
  raw: { purposes: ReadonlyArray<{ value: number; name: string }> },
  index: number,
): string | undefined => raw.purposes[index]?.name;

describe("public api over recorded fixtures", () => {
  test("sha256 of every recorded fixture matches SOURCE.json", () => {
    const source = JSON.parse(fixtureText("public/SOURCE.json")) as Record<
      string,
      { sha256: string }
    >;
    for (const [name, entry] of Object.entries(source)) {
      const digest = createHash("sha256")
        .update(fixtureText(`public/${name}`))
        .digest("hex");
      expect({ [name]: digest }).toStrictEqual({ [name]: entry.sha256 });
    }
  });

  test("timestamp returns the recorded ms as bigint", async () => {
    const raw = JSON.parse(fixtureBody("public/timestamp.json")) as { timestamp: number };
    const { api } = publicApi({ "/timestamp": json(fixtureBody("public/timestamp.json")) });
    await expect(api.timestamp()).resolves.toBe(BigInt(raw.timestamp));
  });

  test("countries returns the four recorded arrays", async () => {
    const raw = JSON.parse(fixtureBody("public/countries.json")) as Record<string, string[]>;
    const { api } = publicApi({ "/countries": json(fixtureBody("public/countries.json")) });
    const countries = await api.countries();
    expect(countries.eligibleDomiciles).toStrictEqual(raw["eligibleDomiciles"]);
    expect(countries.eligibleDomicilesForCards).toStrictEqual(raw["eligibleDomicilesForCards"]);
    expect(countries.lowLimitDomiciles).toStrictEqual(raw["lowLimitDomiciles"]);
    expect(countries.blacklistNationalities).toStrictEqual(raw["blacklistNationalities"]);
    expect(Object.keys(countries)).toHaveLength(4);
  });

  test("rates keeps the 12 fiat pairs that are present", async () => {
    const raw = JSON.parse(fixtureBody("public/rates.json")) as Record<
      string,
      { rate: number; bid: number; ask: number; lastUpdateAt: number }
    >;
    const { api } = publicApi({ "/rates": json(fixtureBody("public/rates.json")) });
    const rates = await api.rates();
    const pairs = [
      "USDEUR",
      "USDCHF",
      "USDCNH",
      "EURUSD",
      "EURCHF",
      "EURCNH",
      "CHFUSD",
      "CHFEUR",
      "CHFCNH",
      "CNHUSD",
      "CNHEUR",
      "CNHCHF",
    ] as const;
    for (const pair of pairs) {
      expect({ [pair]: rates[pair] }).toStrictEqual({ [pair]: rateEntry(raw, pair) });
    }
    // Non-fiat pairs (JPYCHF, SGDUSD, …) are stripped, never inspected.
    expect(Object.keys(rates).every((key) => pairs.some((p) => p === key))).toBe(true);
    expect(Object.keys(rates).length).toBeGreaterThan(0);
  });

  test("payment-purposes returns the 12 recorded purposes", async () => {
    const raw = JSON.parse(fixtureBody("public/payment-purposes.json")) as {
      purposes: Array<{ value: number; name: string }>;
    };
    const { api } = publicApi({
      "/payment-purposes": json(fixtureBody("public/payment-purposes.json")),
    });
    const purposes = await api.paymentPurposes();
    expect(purposes).toHaveLength(12);
    for (const [index, purpose] of purposes.entries()) {
      expect(purpose).toStrictEqual({ value: BigInt(index), name: purposeAt(raw, index) });
    }
  });

  test("banks returns 26 countries / 372 banks", async () => {
    const { api } = publicApi({ "/banks": json(fixtureBody("public/banks.json")) });
    const banks = await api.banks();
    expect(Object.keys(banks.banks)).toHaveLength(26);
    expect(Object.values(banks.banks).reduce((sum, list) => sum + list.length, 0)).toBe(372);
    const ch = banks.banks["CH"];
    expect(ch).toBeDefined();
    expect(ch?.every((bank) => typeof bank.bic === "string")).toBe(true);
  });

  test("country-cities returns 42 countries", async () => {
    const { api } = publicApi({
      "/country-cities": json(fixtureBody("public/country-cities.json")),
    });
    const cities = await api.countryCities();
    expect(Object.keys(cities.countries)).toHaveLength(42);
    expect(cities.countries["CHE"]?.cities.length).toBeGreaterThan(0);
  });

  test("kycStatus maps the recorded codes", async () => {
    const { api } = publicApi({
      "/status-kyc?id=9102": json(fixtureBody("public/status-kyc-9102.json")),
    });
    await expect(api.kycStatus(9102n)).resolves.toBe("completed");
    const other = publicApi({
      "/status-kyc?id=37033549": json(fixtureBody("public/status-kyc-missing.json")),
    });
    await expect(other.api.kycStatus(37033549n)).resolves.toBe("not-started");
  });

  test.each([
    ["NO_INIT", "not-started"],
    ["NOT_INIT", "not-started"],
    ["CA_COMPLETED_PENDING_SCAN", "pending-scan"],
    ["PROCESSING_SCAN", "processing"],
    ["PENDING_ACTION", "action-required"],
    ["MANUAL_REVIEW", "manual-review"],
    ["COMPLETED", "completed"],
    ["REJECTED", "rejected"],
    ["INTERNAL_ERROR", "error"],
    ["SOMETHING_ELSE", "unknown"],
  ])("kyc status %s => %s", async (server, expected) => {
    const { api } = publicApi({
      "/status-kyc?id=1": json(JSON.stringify({ status: server })),
    });
    await expect(api.kycStatus(1n)).resolves.toBe(expected);
  });

  test("recorded banks-iban errors are api-rejected", async () => {
    expect.hasAssertions();
    // Both recorded bodies are `{error}` envelopes; banks-iban-bad's own URL IBAN fails the
    // local check, so it is served here at the valid-IBAN route.
    const { api } = publicApi({
      "/banks/iban/CH9300762011623852957": json(fixtureBody("public/banks-iban.json")),
      "/banks/iban/CH8183051000000010365": json(fixtureBody("public/banks-iban-bad.json")),
    });
    await expectCode(async () => api.bankByIban("CH9300762011623852957"), "api-rejected");
    await expectCode(async () => api.bankByIban("CH8183051000000010365"), "api-rejected");
  });

  test("synthetic /banks/iban success strips the extra doc keys", async () => {
    const { api } = publicApi({
      "/banks/iban/CH9300762011623852957": json(fixtureBody("secured/banks-iban-ok.json")),
    });
    const bank = await api.bankByIban("CH9300762011623852957");
    expect(bank).toStrictEqual({
      name: "Zürcher Kantonalbank",
      bic: "ZKBKCHZZXXX",
      country: "CH",
      bankCode: "00700",
    });
  });

  test("invalid arguments refuse before I/O", async () => {
    const { api, calls } = publicApi({});
    await expectCode(async () => api.bankByIban("CH000000000000000000"), "invalid-argument");
    await expectCode(async () => api.bankByIban("CH0000000000000000000"), "invalid-argument");
    await expectCode(async () => api.kycStatus(0n), "invalid-account-id");
    await expectCode(async () => api.kycStatus(2n ** 256n), "invalid-account-id");
    expect(calls).toHaveLength(0);
  });

  test.each(HOSTILE_BODIES)(
    "hostile body %s => invalid-response",
    async (_name, endpoint, body) => {
      expect.hasAssertions();
      const { api } = publicApi({ [endpoint]: json(body) });
      const run = HOSTILE_RUNS[endpoint];
      await expectApiError(
        async () => run?.(api),
        "invalid-response",
        `GET ${endpoint.replace(/\?.*/u, "")}`,
      );
    },
  );

  test("recorded 401 body => unauthorized", async () => {
    const stub = stubFetch({
      "/timestamp": json(fixtureBody("public/timestamp.json")),
      "/br": json(fixtureText("public/br-noauth.txt"), 401),
    });
    const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
    const session = api.openSession({ tokenId: 690333n, signer: testSigner() });
    await expectCode(async () => session.profile(), "unauthorized");
    // 1 timestamp + 1 /br + 1 re-grant timestamp + 1 /br retry.
    expect(stub.calls).toHaveLength(4);
  });

  test("a __proto__ key is refused, never pollutes", async () => {
    const banks = `{"lastUpdateAt":1,"banks":{"CH":[],"__proto__":[{"name":"x","bic":"y","country":"z","bankCode":"w"}]}}`;
    const { api } = publicApi({ "/banks": json(banks) });
    await expectCode(async () => api.banks(), "invalid-response");
    const cities = `{"lastUpdateAt":1,"countries":{"__proto__":{"name":"x","postalCodeRegEx":"y","cities":[]}}}`;
    const other = publicApi({ "/country-cities": json(cities) });
    await expectCode(async () => other.api.countryCities(), "invalid-response");
    const clean = publicApi({ "/banks": json(fixtureBody("public/banks.json")) });
    const result = await clean.api.banks();
    expect(Object.getPrototypeOf(result.banks)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.banks["CH"])).toBe(Array.prototype);
  });
});
