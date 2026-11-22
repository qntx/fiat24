import * as fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { createFiat24Api } from "../../src/api/index.ts";
import type { Fiat24Api, Fiat24Session } from "../../src/api/index.ts";
import { isFiat24Error } from "../../src/core/index.ts";
import { DOC_QR, fixtureBody, json, stubFetch, testSigner } from "../api/stub.ts";

const TOKEN_ID = 690333n;
const SERVER_MS = 1_795_328_524_822;

const BANK_REQUEST = {
  account: "LI7830174502999200012",
  bankName: "SR Saphirstein AG",
  bic: "SAHHCHZ2",
  purpose: 2n,
  creditor: "BR" as const,
};

const SP_PATH = `/verify?sp=${encodeURIComponent(
  JSON.stringify({
    account: BANK_REQUEST.account,
    bankName: BANK_REQUEST.bankName,
    bic: BANK_REQUEST.bic,
    purpose: 2,
    creditor: "BR",
  }),
)}`;
const QR_PATH = `/verify?qr=${encodeURIComponent(DOC_QR)}`;

const READ_CODES = new Set(["invalid-response", "api-rejected"]);
const VERIFY_CODES = new Set(["invalid-response", "api-rejected", "api-mismatch"]);

type Endpoint = {
  readonly name: string;
  readonly route: string;
  readonly valid: string;
  readonly codes: ReadonlySet<string>;
  readonly run: (api: Fiat24Api, session: Fiat24Session) => Promise<unknown>;
};

const ENDPOINTS: ReadonlyArray<Endpoint> = [
  {
    name: "timestamp",
    route: "/timestamp",
    valid: fixtureBody("public/timestamp.json"),
    codes: READ_CODES,
    run: async (api) => api.timestamp(),
  },
  {
    name: "countries",
    route: "/countries",
    valid: fixtureBody("public/countries.json"),
    codes: READ_CODES,
    run: async (api) => api.countries(),
  },
  {
    name: "rates",
    route: "/rates",
    valid: fixtureBody("public/rates.json"),
    codes: READ_CODES,
    run: async (api) => api.rates(),
  },
  {
    name: "payment-purposes",
    route: "/payment-purposes",
    valid: fixtureBody("public/payment-purposes.json"),
    codes: READ_CODES,
    run: async (api) => api.paymentPurposes(),
  },
  {
    name: "banks",
    route: "/banks",
    valid: fixtureBody("public/banks.json"),
    codes: READ_CODES,
    run: async (api) => api.banks(),
  },
  {
    name: "banks-iban",
    route: "/banks/iban/CH9300762011623852957",
    valid: fixtureBody("secured/banks-iban-ok.json"),
    codes: READ_CODES,
    run: async (api) => api.bankByIban("CH9300762011623852957"),
  },
  {
    name: "country-cities",
    route: "/country-cities",
    valid: fixtureBody("public/country-cities.json"),
    codes: READ_CODES,
    run: async (api) => api.countryCities(),
  },
  {
    name: "status-kyc",
    route: "/status-kyc?id=1",
    valid: fixtureBody("public/status-kyc-9102.json"),
    codes: READ_CODES,
    run: async (api) => api.kycStatus(1n),
  },
  {
    name: "br",
    route: "/br",
    valid: fixtureBody("secured/br.json"),
    codes: READ_CODES,
    run: async (_api, session) => session.profile(),
  },
  {
    name: "cards",
    route: "/cards",
    valid: fixtureBody("secured/cards-ok.json"),
    codes: READ_CODES,
    run: async (_api, session) => session.cards(),
  },
  {
    name: "transactions",
    route: "/transactions?currency=EUR",
    valid: fixtureBody("secured/transactions.json"),
    codes: READ_CODES,
    run: async (_api, session) => session.transactions({ currency: "EUR" }),
  },
  {
    name: "verify-sp",
    route: SP_PATH,
    valid: fixtureBody("secured/verify-sp.json"),
    codes: VERIFY_CODES,
    run: async (_api, session) => session.verifyBankPayment(BANK_REQUEST),
  },
  {
    name: "verify-qr",
    route: QR_PATH,
    valid: fixtureBody("secured/verify-qr.json"),
    codes: VERIFY_CODES,
    run: async (_api, session) => session.verifySwissQr(DOC_QR),
  },
  {
    name: "card",
    route: "/card",
    valid: fixtureBody("secured/write-ok.json"),
    codes: READ_CODES,
    run: async (_api, session) => session.createCard(),
  },
  {
    name: "card-status",
    route: "/card-status",
    valid: fixtureBody("secured/write-ok.json"),
    codes: READ_CODES,
    run: async (_api, session) => session.setCardStatus({ externalId: "123456", status: "block" }),
  },
];

// Serves `body` on the endpoint's route (plus /timestamp for the grant) and runs the method.
async function outcome(endpoint: Endpoint, body: string): Promise<string> {
  const stub = stubFetch({
    "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
    [endpoint.route]: json(body),
  });
  const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
  const session = api.openSession({ tokenId: TOKEN_ID, signer: testSigner() });
  try {
    await endpoint.run(api, session);
    return "ok";
  } catch (error) {
    return isFiat24Error(error) ? error.code : "non-fiat24-throw";
  }
}

function allowed(result: string, codes: ReadonlySet<string>): boolean {
  return result === "ok" || codes.has(result);
}

const mutation = fc.oneof(
  fc.record({ kind: fc.constant("truncate"), at: fc.nat() }),
  fc.record({ kind: fc.constant("append"), tail: fc.string({ maxLength: 8 }) }),
  fc.record({ kind: fc.constant("delete-key") }),
  fc.record({ kind: fc.constant("replace-key"), value: fc.jsonValue() }),
  fc.record({ kind: fc.constant("duplicate-key"), value: fc.jsonValue() }),
);

// Text-level mutation of the raw body: deletes/replaces/duplicates a top-level key when the
// body is a JSON object, truncates or appends raw text otherwise.
function mutate(
  text: string,
  m: {
    kind: "truncate" | "append" | "delete-key" | "replace-key" | "duplicate-key";
    at?: number;
    tail?: string;
    value?: unknown;
  },
): string {
  if (m.kind === "truncate") {
    return text.slice(0, (m.at ?? 0) % (text.length + 1));
  }
  if (m.kind === "append") {
    return text + (m.tail ?? "");
  }
  const keyMatch = /"([^"\\]+)"\s*:/.exec(text);
  const key = keyMatch?.[1];
  if (key === undefined) {
    return text;
  }
  if (m.kind === "duplicate-key") {
    const at = text.indexOf(`"${key}"`);
    return `${text.slice(0, at)}${JSON.stringify(key)}:${JSON.stringify(m.value ?? null)},${text.slice(at)}`;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return text;
  }
  const copy: Record<string, unknown> =
    m.kind === "delete-key"
      ? Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(([k]) => k !== key),
        )
      : { ...(parsed as Record<string, unknown>), [key]: m.value };
  return JSON.stringify(copy);
}

describe("api property tests (I14)", () => {
  describe.each(ENDPOINTS.map((e) => [e.name, e] as const))("%s", (_name, endpoint) => {
    test("arbitrary JSON bodies", async () => {
      return fc.assert(
        fc.asyncProperty(fc.jsonValue(), async (value) => {
          expect(allowed(await outcome(endpoint, JSON.stringify(value)), endpoint.codes)).toBe(
            true,
          );
        }),
      );
    });

    test("mutated fixture", async () => {
      return fc.assert(
        fc.asyncProperty(mutation, async (m) => {
          expect(allowed(await outcome(endpoint, mutate(endpoint.valid, m)), endpoint.codes)).toBe(
            true,
          );
        }),
      );
    });

    test("random strings", async () => {
      return fc.assert(
        fc.asyncProperty(fc.string({ maxLength: 400 }), async (text) => {
          expect(allowed(await outcome(endpoint, text), endpoint.codes)).toBe(true);
        }),
      );
    });
  });
});
