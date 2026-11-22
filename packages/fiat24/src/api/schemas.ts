import type { Hash } from "viem";
import * as z from "zod/mini";

import type { Currency } from "../core/types.ts";
import { apiError } from "./http.ts";
import type {
  Bank,
  Banks,
  Countries,
  CountryCities,
  KycStatus,
  PaymentPurpose,
  Profile,
  Rate,
  RatePair,
  TransactionPage,
  VerifiedPayout,
} from "./types.ts";

type FiatCode = "EUR" | "USD" | "CHF" | "CNH";

const FIAT_CODES: ReadonlyArray<FiatCode> = ["EUR", "USD", "CHF", "CNH"];

const RATE_PAIRS: ReadonlyArray<RatePair> = [
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
];

// §9.4 shared atoms: strings capped at 1024 chars, arrays at 10000 items, safe integers via
// zod's safeint check. z.object strips unknown keys; the ISO keys of records are validated.
const text = z.string().check(z.maxLength(1024));
const safeInt = z.int();
const nonNegativeInt = z.int().check(z.gte(0));
const purposeIdSchema = z.int().check(z.gte(0)).check(z.lte(1_000_000));
const iso2 = z.string().check(z.regex(/^[A-Z]{2}$/));
const iso3 = z.string().check(z.regex(/^[A-Z]{3}$/));
const fiatCode = z.enum(["EUR", "USD", "CHF", "CNH"]);
const currencyCode = z.enum(["EUR24", "USD24", "CHF24", "CNH24"]);
const decimal = z.union([z.number(), text]);

const list = <T extends z.ZodMiniType>(element: T) => z.array(element).check(z.maxLength(10_000));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCollection(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Deep-freeze a result (arrays and nested objects included), like the calls results. */
export function freeze<T>(value: T): T {
  if (isCollection(value)) {
    for (const item of Object.values(value)) {
      freeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

/** `z.safeParse` wrapper: a schema failure is `invalid-response` with the endpoint template (§9.5). */
function checked<T>(schema: z.ZodMiniType<T>, json: unknown, endpoint: string): T {
  const parsed = z.safeParse(schema, json);
  if (!parsed.success) {
    throw apiError("invalid-response", endpoint);
  }
  return parsed.data;
}

// A JSON number or capped string that must serialize to a plain decimal — no exponent, sign
// beyond a leading "-", or loss (I4 display-only fields: amounts, cardActivation).
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;

export function decimalText(value: number | string, endpoint: string): string {
  const result = typeof value === "number" ? String(value) : value;
  if (!DECIMAL.test(result)) {
    throw apiError("invalid-response", endpoint);
  }
  return result;
}

const timestampSchema = z.object({ timestamp: z.int().check(z.gt(0)) });

export function parseTimestamp(json: unknown): bigint {
  const parsed = checked(timestampSchema, json, "GET /timestamp");
  return BigInt(parsed.timestamp);
}

const countriesSchema = z.object({
  eligibleDomiciles: list(iso3),
  eligibleDomicilesForCards: list(iso3),
  lowLimitDomiciles: list(iso3),
  blacklistNationalities: list(iso3),
});

export function parseCountries(json: unknown): Countries {
  return freeze(checked(countriesSchema, json, "GET /countries"));
}

const rateSchema = z.object({
  rate: z.number(),
  bid: z.number(),
  ask: z.number(),
  lastUpdateAt: nonNegativeInt,
});
const ratesSchema = z.object({
  USDEUR: z.optional(rateSchema),
  USDCHF: z.optional(rateSchema),
  USDCNH: z.optional(rateSchema),
  EURUSD: z.optional(rateSchema),
  EURCHF: z.optional(rateSchema),
  EURCNH: z.optional(rateSchema),
  CHFUSD: z.optional(rateSchema),
  CHFEUR: z.optional(rateSchema),
  CHFCNH: z.optional(rateSchema),
  CNHUSD: z.optional(rateSchema),
  CNHEUR: z.optional(rateSchema),
  CNHCHF: z.optional(rateSchema),
});

// Only the 12 ordered Fiat24 pairs are kept (§9.4); every other key of the response is stripped.
export function parseRates(json: unknown): Readonly<Partial<Record<RatePair, Rate>>> {
  const parsed = checked(ratesSchema, json, "GET /rates");
  const rates: Partial<Record<RatePair, Rate>> = {};
  for (const pair of RATE_PAIRS) {
    const rate = parsed[pair];
    if (rate !== undefined) {
      rates[pair] = {
        rate: rate.rate,
        bid: rate.bid,
        ask: rate.ask,
        lastUpdateAt: BigInt(rate.lastUpdateAt),
      };
    }
  }
  return freeze(rates);
}

const paymentPurposesSchema = z.object({
  purposes: list(z.object({ value: purposeIdSchema, name: text })),
});

export function parsePaymentPurposes(json: unknown): ReadonlyArray<PaymentPurpose> {
  const parsed = checked(paymentPurposesSchema, json, "GET /payment-purposes");
  return freeze(parsed.purposes.map((p) => ({ value: BigInt(p.value), name: p.name })));
}

const bankSchema = z.object({ name: text, bic: text, country: text, bankCode: text });
const banksSchema = z.object({
  lastUpdateAt: nonNegativeInt,
  banks: z.record(iso2, list(bankSchema)),
});

export function parseBanks(json: unknown): Banks {
  const parsed = checked(banksSchema, json, "GET /banks");
  // zod's record skips an own `__proto__` key silently: refuse it so it can never shadow data.
  if (isRecord(json) && isRecord(json["banks"]) && Object.hasOwn(json["banks"], "__proto__")) {
    throw apiError("invalid-response", "GET /banks");
  }
  const banks: Record<string, ReadonlyArray<Bank>> = {};
  for (const [country, entries] of Object.entries(parsed.banks)) {
    banks[country] = entries;
  }
  return freeze({ lastUpdateAt: BigInt(parsed.lastUpdateAt), banks });
}

export function parseBank(json: unknown): Bank {
  return freeze(checked(bankSchema, json, "GET /banks/iban/{iban}"));
}

const countryCitiesSchema = z.object({
  lastUpdateAt: nonNegativeInt,
  countries: z.record(iso3, z.object({ name: text, postalCodeRegEx: text, cities: list(text) })),
});

export function parseCountryCities(json: unknown): CountryCities {
  const parsed = checked(countryCitiesSchema, json, "GET /country-cities");
  if (
    isRecord(json) &&
    isRecord(json["countries"]) &&
    Object.hasOwn(json["countries"], "__proto__")
  ) {
    throw apiError("invalid-response", "GET /country-cities");
  }
  return freeze({ lastUpdateAt: BigInt(parsed.lastUpdateAt), countries: parsed.countries });
}

const kycStatusSchema = z.object({ status: text });

// §9.4 mapping; a Map lookup keeps untrusted keys off the prototype chain.
const KYC_STATUS: ReadonlyMap<string, KycStatus> = new Map<string, KycStatus>([
  ["NO_INIT", "not-started"],
  ["NOT_INIT", "not-started"],
  ["CA_COMPLETED_PENDING_SCAN", "pending-scan"],
  ["PROCESSING_SCAN", "processing"],
  ["PENDING_ACTION", "action-required"],
  ["MANUAL_REVIEW", "manual-review"],
  ["COMPLETED", "completed"],
  ["REJECTED", "rejected"],
  ["INTERNAL_ERROR", "error"],
]);

export function parseKycStatus(json: unknown): KycStatus {
  const parsed = checked(kycStatusSchema, json, "GET /status-kyc");
  return KYC_STATUS.get(parsed.status) ?? "unknown";
}

const contactSchema = z.object({
  id: text,
  name: text,
  account: text,
  bank: text,
  country: text,
});
const profileSchema = z.object({
  tokenId: z.int().check(z.gt(0)),
  br: text,
  email: text,
  mobile: text,
  street: text,
  postalCode: text,
  city: text,
  country: text,
  isCardEligible: z.boolean(),
  // Only the four fiat keys are inspected; `fullAccount`, `depositBank`, `limits` and unknown
  // keys are stripped (§9.4).
  contacts: z.optional(
    z.object({
      EUR: z.optional(list(contactSchema)),
      USD: z.optional(list(contactSchema)),
      CHF: z.optional(list(contactSchema)),
      CNH: z.optional(list(contactSchema)),
    }),
  ),
  cardActivation: z.optional(z.object({ amount: decimal, currency: fiatCode })),
});

export function parseProfile(json: unknown): Profile {
  const parsed = checked(profileSchema, json, "GET /br");
  const contacts: Partial<Record<FiatCode, NonNullable<Profile["contacts"][FiatCode]>>> = {};
  if (parsed.contacts !== undefined) {
    for (const code of FIAT_CODES) {
      const value = parsed.contacts[code];
      if (value !== undefined) {
        contacts[code] = value;
      }
    }
  }
  const activation = parsed.cardActivation;
  return freeze({
    tokenId: BigInt(parsed.tokenId),
    name: parsed.br,
    email: parsed.email,
    mobile: parsed.mobile,
    address: {
      street: parsed.street,
      postalCode: parsed.postalCode,
      city: parsed.city,
      country: parsed.country,
    },
    contacts,
    isCardEligible: parsed.isCardEligible,
    ...(activation === undefined
      ? {}
      : {
          cardActivation: {
            amount: decimalText(activation.amount, "GET /br"),
            currency: activation.currency,
          },
        }),
  });
}

const deviceTokenSchema = z.object({ id: text, type: text, createdAt: nonNegativeInt });
const cardSchema = z.object({
  externalId: text,
  status: text,
  currency: currencyCode,
  currencies: list(fiatCode),
  masked: z.object({ cardNumber: text }),
  cardToken: z.optional(text),
  activeTokens: z.optional(list(deviceTokenSchema)),
  inactiveTokens: z.optional(list(deviceTokenSchema)),
});
const cardsSchema = z.object({ statusCode: safeInt, body: z.optional(list(cardSchema)) });

// The parsed card including `cardToken` (the 5-min display secret §9.4); `cards()` drops it and
// `cardDisplayToken` returns it. Never surfaced inside a `Card`.
export type ApiCard = {
  readonly externalId: string;
  readonly status: string;
  readonly currency: Currency;
  readonly currencies: ReadonlyArray<FiatCode>;
  readonly cardNumber: string;
  readonly cardToken?: string;
  readonly activeTokens: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly createdAt: bigint;
  }>;
  readonly inactiveTokens: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly createdAt: bigint;
  }>;
};

const mapCardTokens = (
  list: ReadonlyArray<{ id: string; type: string; createdAt: number }> | undefined,
): ReadonlyArray<{ readonly id: string; readonly type: string; readonly createdAt: bigint }> =>
  (list ?? []).map((token) => ({
    id: token.id,
    type: token.type,
    createdAt: BigInt(token.createdAt),
  }));

export function parseCards(json: unknown): ReadonlyArray<ApiCard> {
  const parsed = checked(cardsSchema, json, "GET /cards");
  // Only the body `statusCode` carries the empty-card signal; HTTP-level errors follow §9.5.
  if (parsed.statusCode === 404) {
    return freeze([]);
  }
  if (parsed.statusCode !== 200) {
    throw apiError("api-rejected", "GET /cards", parsed.statusCode);
  }
  if (parsed.body === undefined) {
    throw apiError("invalid-response", "GET /cards");
  }
  return freeze(
    parsed.body.map((card) => {
      const result = {
        externalId: card.externalId,
        status: card.status,
        currency: card.currency,
        currencies: card.currencies,
        cardNumber: card.masked.cardNumber,
        activeTokens: mapCardTokens(card.activeTokens),
        inactiveTokens: mapCardTokens(card.inactiveTokens),
      };
      // cardToken is the display secret; absent means the account has no live token to show.
      return card.cardToken === undefined
        ? result
        : Object.assign(result, { cardToken: card.cardToken });
    }),
  );
}

const transactionSchema = z.object({
  title: text,
  subtitle: text,
  amount: decimal,
  timestamp: safeInt,
  txId: z.optional(z.unknown()),
  from: z.optional(z.unknown()),
  to: z.optional(z.unknown()),
  blockNumber: z.optional(z.unknown()),
});
const transactionsSchema = z.object({
  count: nonNegativeInt,
  transactions: list(transactionSchema),
});

const DECIMAL_FIELD = /^(0|[1-9][0-9]{0,77})$/;
const TX_ID = /^0x[0-9a-fA-F]{64}$/;

function isHash(value: string): value is Hash {
  return TX_ID.test(value);
}

// `from`/`to`/`blockNumber` are kept only as exact values — a safe-integer JSON number >= 0 or a
// canonical decimal string; anything else is dropped rather than coerced to a lossy bigint (§9.4).
function optionalId(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && DECIMAL_FIELD.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

export function parseTransactions(json: unknown): TransactionPage {
  const parsed = checked(transactionsSchema, json, "GET /transactions");
  const transactions = parsed.transactions.map((t) => {
    // 13-digit ms timestamps stay; the doc's 10-digit seconds form is scaled to ms (§9.4).
    const digits = String(t.timestamp);
    let timestamp: bigint;
    if (/^[0-9]{10}$/.test(digits)) {
      timestamp = BigInt(t.timestamp) * 1000n;
    } else if (/^[0-9]{13}$/.test(digits)) {
      timestamp = BigInt(t.timestamp);
    } else {
      throw apiError("invalid-response", "GET /transactions");
    }
    const lowered = typeof t.txId === "string" ? t.txId.toLowerCase() : undefined;
    const txId = lowered !== undefined && isHash(lowered) ? lowered : undefined;
    const from = optionalId(t.from);
    const to = optionalId(t.to);
    const blockNumber = optionalId(t.blockNumber);
    return {
      title: t.title,
      subtitle: t.subtitle,
      amount: decimalText(t.amount, "GET /transactions"),
      timestamp,
      ...(txId === undefined ? {} : { txId }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(blockNumber === undefined ? {} : { blockNumber }),
    };
  });
  return freeze({ count: BigInt(parsed.count), transactions });
}

const verifiedPayoutSchema = z.object({ contactId: text, purposeId: purposeIdSchema, ref: text });

export function parseVerifiedPayout(json: unknown): VerifiedPayout {
  const parsed = checked(verifiedPayoutSchema, json, "GET /verify");
  return freeze({
    contactId: parsed.contactId,
    purposeId: BigInt(parsed.purposeId),
    ref: parsed.ref,
  });
}

const verifiedQrSchema = z.object({
  type: text,
  account: text,
  clientPayoutRefParams: z.object({
    currency: text,
    amount: z.int().check(z.gt(0)),
    contactId: text,
    purposeId: purposeIdSchema,
    ref: text,
  }),
  creditor: z.object({ name: text }),
  reference: z.optional(text),
});

// The parsed /verify?qr body flattened for the §10.6 bindings in secured.ts.
export type VerifiedQrResponse = {
  readonly type: string;
  readonly account: string;
  readonly currency: string;
  readonly amount: bigint;
  readonly contactId: string;
  readonly purposeId: bigint;
  readonly ref: string;
  readonly creditor: { readonly name: string };
  readonly reference?: string;
};

export function parseVerifiedQr(json: unknown): VerifiedQrResponse {
  const parsed = checked(verifiedQrSchema, json, "GET /verify");
  const params = parsed.clientPayoutRefParams;
  return freeze({
    type: parsed.type,
    account: parsed.account,
    currency: params.currency,
    amount: BigInt(params.amount),
    contactId: params.contactId,
    purposeId: BigInt(params.purposeId),
    ref: params.ref,
    creditor: { name: parsed.creditor.name },
    ...(parsed.reference === undefined ? {} : { reference: parsed.reference }),
  });
}

// Write acks: `{status: 200}` is the only success body (§9.4); `{}`, a non-200 status or a
// non-object body is `api-rejected` — `status` from the body when it is a safe integer.
export function parseWriteAck(json: unknown, endpoint: string): void {
  const status = isRecord(json) ? json["status"] : undefined;
  if (status === 200) {
    return;
  }
  throw apiError(
    "api-rejected",
    endpoint,
    typeof status === "number" && Number.isSafeInteger(status) ? status : 200,
  );
}
