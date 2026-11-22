import { Fiat24Error } from "../core/errors.ts";
import { isValidIban } from "../core/iban.ts";
import { isValidContactId, isValidPayoutRef } from "../core/payout-grammar.ts";
import { apiError, request } from "./http.ts";
import type { ApiCard, VerifiedQrResponse } from "./schemas.ts";
import {
  freeze,
  parseCards,
  parseProfile,
  parseTransactions,
  parseVerifiedPayout,
  parseVerifiedQr,
  parseWriteAck,
} from "./schemas.ts";
import type { SessionCore, SessionHeaders } from "./session.ts";
import { parseSwissQr } from "./swiss-qr.ts";
import type {
  BankPaymentRequest,
  Card,
  Fiat24Session,
  SwissQr,
  TransactionQuery,
  VerifiedQrPayout,
} from "./types.ts";

function invalid(): never {
  throw new Fiat24Error("invalid-argument", "invalid argument");
}

// Request fields are single-line, bounded strings; errors never echo the input (§9.5, I7).
function checkedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    invalid();
  }
  return value;
}

function checkedRange(value: unknown, min: bigint, max: bigint): bigint {
  if (typeof value !== "bigint" || value < min || value > max) {
    invalid();
  }
  return value;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const BIC = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const CARD_STATUS: ReadonlyMap<string, Card["status"]> = new Map([
  ["Active", "active"],
  ["Blocked", "blocked"],
  ["Expired", "expired"],
]);
const LAST4 = /([0-9]{4})$/;
const CURRENCY_QUERY: ReadonlySet<string> = new Set(["EUR", "USD", "CHF", "CNH", "ALL"]);
const CARD_CURRENCIES: ReadonlySet<string> = new Set(["EUR", "USD", "CHF", "CNH"]);
const CARD_STATUS_CHANGES: ReadonlySet<string> = new Set(["block", "unblock"]);
const DEVICE_TOKEN_CHANGES: ReadonlySet<string> = new Set(["activate", "deactivate"]);
const TRANSACTION_TYPES: ReadonlySet<string> = new Set(["P2P", "FRX", "CTU", "CRD", "CDP", "CWD"]);

// IBAN countries in ISO2, verbatim from the docs (Part 2 §10, step "Check the destination bank
// account format"); the BIC's country field (ISO 9362 chars 5-6) decides the local IBAN check.
const IBAN_COUNTRIES: ReadonlySet<string> = new Set(
  "AD,AE,AL,AT,AZ,BA,BE,BG,BH,BR,BY,CH,CR,CY,CZ,DE,DK,DO,DZ,EE,EG,ES,FI,FO,FR,GB,GE,GI,GL,GR,GT,HR,HU,IE,IL,IQ,IS,IT,JO,KW,KZ,LB,LC,LI,LK,LT,LU,LV,LY,MC,MD,ME,MK,MR,MT,MU,NL,NO,PK,PL,PS,PT,QA,RO,RS,SA,SC,SE,SI,SK,SM,ST,SV,TG,TL,TN,TR,UA,VA,VG,XK".split(
    ",",
  ),
);

function toCard(card: ApiCard): Card {
  const last4 = LAST4.exec(card.cardNumber)?.[1];
  if (last4 === undefined) {
    throw apiError("invalid-response", "GET /cards");
  }
  return freeze({
    externalId: card.externalId,
    status: CARD_STATUS.get(card.status) ?? "unknown",
    currency: card.currency,
    currencies: card.currencies,
    last4,
    activeTokens: card.activeTokens,
    inactiveTokens: card.inactiveTokens,
  });
}

function checkedQuery(query: TransactionQuery): string {
  if (typeof query !== "object" || query === null) {
    invalid();
  }
  const { currency, fromRecord, recordsCount, fromTimestamp, toTimestamp, direction, types } =
    query;
  if (!CURRENCY_QUERY.has(currency)) {
    invalid();
  }
  const parts = [`currency=${currency}`];
  if (fromRecord !== undefined) {
    parts.push(`fromrecord=${checkedRange(fromRecord, 0n, MAX_SAFE)}`);
  }
  if (recordsCount !== undefined) {
    parts.push(`recordscount=${checkedRange(recordsCount, 1n, 1000n)}`);
  }
  if (fromTimestamp !== undefined) {
    parts.push(`fromtimestamp=${checkedRange(fromTimestamp, 0n, MAX_SAFE)}`);
  }
  if (toTimestamp !== undefined) {
    parts.push(`totimestamp=${checkedRange(toTimestamp, 0n, MAX_SAFE)}`);
  }
  if (direction !== undefined) {
    if (direction !== "IN" && direction !== "OUT" && direction !== "ALL") {
      invalid();
    }
    parts.push(`direction=${direction}`);
  }
  if (types !== undefined) {
    if (!Array.isArray(types) || types.length === 0 || types.length > 6) {
      invalid();
    }
    const items: ReadonlyArray<unknown> = types;
    for (const type of items) {
      if (typeof type !== "string" || !TRANSACTION_TYPES.has(type)) {
        invalid();
      }
    }
    parts.push(`type=${items.join(",")}`);
  }
  return `/transactions?${parts.join("&")}`;
}

function checkedBankPayment(request: BankPaymentRequest): BankPaymentRequest {
  if (typeof request !== "object" || request === null) {
    invalid();
  }
  const account = checkedText(request.account);
  const bankName = checkedText(request.bankName);
  const { bic } = request;
  if (typeof bic !== "string" || !BIC.test(bic)) {
    invalid();
  }
  const purpose = checkedRange(request.purpose, 0n, 1_000_000n);
  let reference: string | undefined;
  if (request.reference !== undefined) {
    if (typeof request.reference !== "string" || request.reference.length > 1024) {
      invalid();
    }
    ({ reference } = request);
  }
  let creditor: BankPaymentRequest["creditor"];
  const { creditor: c } = request;
  if (c === "BR") {
    creditor = "BR";
  } else if (typeof c === "object" && c !== null) {
    creditor = {
      name: checkedText(c.name),
      street: checkedText(c.street),
      city: checkedText(c.city),
      zip: checkedText(c.zip),
      country: checkedText(c.country),
    };
  } else {
    invalid();
  }
  // The only bank-country field in the request is the BIC's (ISO 9362 chars 5-6); an IBAN-country
  // destination must carry a locally valid IBAN (doc Part 2 §10, step 2).
  if (IBAN_COUNTRIES.has(bic.slice(4, 6)) && !isValidIban(account)) {
    invalid();
  }
  return {
    account,
    bankName,
    bic,
    purpose,
    ...(reference === undefined ? {} : { reference }),
    creditor,
  };
}

function mismatch(): never {
  throw apiError("api-mismatch", "GET /verify");
}

function bindQr(parsed: VerifiedQrResponse, qr: SwissQr, tokenId: bigint): VerifiedQrPayout {
  if (
    parsed.type !== "QRCH" ||
    parsed.currency !== `${qr.currency}24` ||
    parsed.amount !== qr.amount ||
    parsed.contactId !== "QRCH" ||
    !isValidPayoutRef(parsed.ref, tokenId) ||
    parsed.account.toUpperCase().replaceAll(" ", "") !== qr.account
  ) {
    mismatch();
  }
  const currency = qr.currency === "CHF" ? "CHF24" : "EUR24";
  return freeze({
    contactId: parsed.contactId,
    purposeId: parsed.purposeId,
    ref: parsed.ref,
    currency,
    amount: qr.amount,
    account: qr.account,
    creditor: { name: parsed.creditor.name },
    ...(parsed.reference === undefined ? {} : { reference: parsed.reference }),
  });
}

/**
 * The secured half of §3.7: every method validates inputs before any I/O (`invalid-argument`), goes
 * through the session for headers, and binds /verify responses to the request (§10.6) so a hostile
 * API cannot redirect a payout.
 */
export function createSecured(args: {
  fetch: typeof fetch | undefined;
  tokenId: bigint;
  session: SessionCore;
}): Fiat24Session {
  const { fetch: fetchOption, tokenId, session } = args;

  const get = async <T>(
    template: string,
    path: string,
    convert: (json: unknown) => T,
  ): Promise<T> =>
    convert(
      await session.read(async (headers: SessionHeaders) =>
        request(fetchOption, { method: "GET", template, path, secured: true, headers }),
      ),
    );

  const write = async (method: "POST" | "PUT", template: string, body: unknown): Promise<void> =>
    parseWriteAck(
      await session.write(async (headers: SessionHeaders) =>
        request(fetchOption, {
          method,
          template,
          path: template,
          secured: true,
          headers,
          body,
        }),
      ),
      `${method} ${template}`,
    );

  const cards = async (): Promise<ReadonlyArray<ApiCard>> => get("/cards", "/cards", parseCards);

  return freeze({
    tokenId,
    profile: async () => get("/br", "/br", parseProfile),
    cards: async () => {
      const list = await cards();
      return freeze(list.map(toCard));
    },
    cardDisplayToken: async (externalId) => {
      const id = checkedText(externalId);
      const list = await cards();
      const card = list.find((candidate) => candidate.externalId === id);
      if (card?.cardToken === undefined || card.cardToken.length === 0) {
        throw apiError("api-rejected", "GET /cards");
      }
      return card.cardToken;
    },
    transactions: async (query) => get("/transactions", checkedQuery(query), parseTransactions),
    verifyBankPayment: async (request) => {
      const checked = checkedBankPayment(request);
      const body = {
        account: checked.account,
        bankName: checked.bankName,
        bic: checked.bic,
        purpose: Number(checked.purpose),
        ...(checked.reference === undefined ? {} : { reference: checked.reference }),
        creditor: checked.creditor,
      };
      const parsed = await get(
        "/verify",
        `/verify?sp=${encodeURIComponent(JSON.stringify(body))}`,
        parseVerifiedPayout,
      );
      if (
        parsed.purposeId !== checked.purpose ||
        !isValidContactId(parsed.contactId) ||
        !isValidPayoutRef(parsed.ref, tokenId)
      ) {
        mismatch();
      }
      return parsed;
    },
    verifySwissQr: async (qr) => {
      const scanned = parseSwissQr(qr);
      let path: string;
      try {
        path = `/verify?qr=${encodeURIComponent(qr)}`;
      } catch {
        invalid();
      }
      const parsed = await get("/verify", path, parseVerifiedQr);
      return bindQr(parsed, scanned, tokenId);
    },
    createCard: async () => write("POST", "/card", {}),
    setCardStatus: async (args) => {
      if (typeof args !== "object" || args === null) {
        invalid();
      }
      const externalId = checkedText(args.externalId);
      if (!CARD_STATUS_CHANGES.has(args.status)) {
        invalid();
      }
      return write("POST", "/card-status", { statusChange: args.status, externalId });
    },
    setCardCurrency: async (args) => {
      if (typeof args !== "object" || args === null) {
        invalid();
      }
      const externalId = checkedText(args.externalId);
      if (typeof args.currency !== "string" || !CARD_CURRENCIES.has(args.currency)) {
        invalid();
      }
      return write("PUT", "/card-currency", { currency: args.currency, externalId });
    },
    setDeviceToken: async (args) => {
      if (typeof args !== "object" || args === null) {
        invalid();
      }
      const externalId = checkedText(args.externalId);
      const cardTokenId = checkedText(args.cardTokenId);
      if (!DEVICE_TOKEN_CHANGES.has(args.status)) {
        invalid();
      }
      return write("POST", "/card-device-token", {
        statusChange: args.status,
        cardTokenId,
        externalId,
      });
    },
    end: () => session.end(),
  });
}
