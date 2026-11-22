import { isAddress } from "viem";

import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import { isValidIban } from "../core/iban.ts";
import { request } from "./http.ts";
import {
  parseBank,
  parseBanks,
  parseCountries,
  parseCountryCities,
  parseKycStatus,
  parsePaymentPurposes,
  parseRates,
  parseTimestamp,
} from "./schemas.ts";
import { createSecured } from "./secured.ts";
import { createSession } from "./session.ts";
import type { Fiat24Api, Fiat24ApiOptions } from "./types.ts";

const BANKS_MAX_BYTES = 8_388_608; // 8 MiB (§9.4; the recorded body is ~1.5 MB).
const IBAN_STRIP = /[^A-Z0-9]/g;

function invalid(): never {
  throw new Fiat24Error("invalid-argument", "invalid argument");
}

/**
 * The public half of §3.7: unauthenticated GETs plus `openSession` (lazy — the first secured call
 * mints the §9.3 grant). `options.fetch` defaults to a call-time `globalThis.fetch` lookup;
 * `options.now` supplies the local clock in ms.
 */
export function createFiat24Api(options: Fiat24ApiOptions): Fiat24Api {
  if (typeof options !== "object" || options === null || typeof options.now !== "function") {
    invalid();
  }
  const fetchOption = options.fetch;
  const { now } = options;
  const get = async <T>(
    template: string,
    path: string,
    convert: (json: unknown) => T,
    maxBytes?: number,
  ): Promise<T> =>
    convert(
      await request(fetchOption, {
        method: "GET",
        template,
        path,
        secured: false,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      }),
    );

  const api: Fiat24Api = {
    timestamp: async () => get("/timestamp", "/timestamp", parseTimestamp),
    countries: async () => get("/countries", "/countries", parseCountries),
    rates: async () => get("/rates", "/rates", parseRates),
    paymentPurposes: async () =>
      get("/payment-purposes", "/payment-purposes", parsePaymentPurposes),
    banks: async () => get("/banks", "/banks", parseBanks, BANKS_MAX_BYTES),
    bankByIban: async (iban) => {
      // isValidIban never throws and refuses non-strings from JS callers.
      if (!isValidIban(iban)) {
        invalid();
      }
      const path = `/banks/iban/${iban.toUpperCase().replaceAll(IBAN_STRIP, "")}`;
      return get("/banks/iban/{iban}", path, parseBank);
    },
    countryCities: async () => get("/country-cities", "/country-cities", parseCountryCities),
    kycStatus: async (tokenId) => {
      assertTokenId(tokenId);
      return get("/status-kyc", `/status-kyc?id=${tokenId}`, parseKycStatus);
    },
    openSession: (args) => {
      if (typeof args !== "object" || args === null) {
        invalid();
      }
      assertTokenId(args.tokenId);
      const { signer } = args;
      if (typeof signer !== "object" || signer === null) {
        invalid();
      }
      if (!isAddress(signer.address)) {
        throw new Fiat24Error("invalid-address", "invalid address");
      }
      if (typeof signer.signSessionGrant !== "function") {
        invalid();
      }
      // No I/O here: the session mints its grant on the first secured call (§9.3).
      const session = createSession({
        tokenId: args.tokenId,
        signer,
        now,
        timestamp: async () => api.timestamp(),
      });
      return createSecured({ fetch: fetchOption, tokenId: args.tokenId, session });
    },
  };
  return Object.freeze(api);
}
