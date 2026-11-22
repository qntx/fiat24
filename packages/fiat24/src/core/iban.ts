import { Fiat24Error } from "./errors.ts";

// The 12-digit account field of the IBAN is shared with the Mantle deployment
// (network 5000 maps account n to "1" + pad11(n)), so an Arbitrum IBAN is only
// unambiguous while the id stays below 10^11 (SPEC §5.3).
const MAX_IBAN_ID: bigint = 10n ** 11n - 1n;

/**
 * `ibanOf` reproduces `GET /iban/{id}` (network 42161): `acct` is the decimal id left-padded to 12
 * digits, `bban = "83051" + acct` (the Arbitrum bank namespace, SPEC §4.2), and the check digits
 * are ISO 13616 / ISO 7064 mod 97-10 over `bban + "121700"` ("CH" is C=12, H=17). Electronic form,
 * 21 chars.
 */
export function ibanOf(tokenId: bigint): string {
  if (tokenId < 1n || tokenId > MAX_IBAN_ID) {
    throw new Fiat24Error("invalid-account-id", `invalid account id ${tokenId}`);
  }
  const bban = `83051${tokenId.toString().padStart(12, "0")}`;
  const check = 98n - (BigInt(`${bban}121700`) % 97n);
  return `CH${check.toString().padStart(2, "0")}${bban}`;
}

// Per-country IBAN lengths, from the Fiat24 docs (Part 2 API Reference, §10
// Bank Payout, step "Check the destination bank account format",
// `isValidIbanNumber`) checked against the SWIFT IBAN Registry Release 103
// (Sep 2026, https://www.swift.com/swift-resource/9606/download?language=en):
// every docs entry matches the registry and LY (effective 2021-01) was added
// from it; DZ, LK and TG appear in the docs but are not registered (R-07).
const IBAN_CODE_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  // SWIFT IBAN Registry Release 103 (effective 2021-01; not in the docs' table).
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TN: 24,
  TR: 26,
  AL: 28,
  BY: 28,
  CR: 22,
  EG: 29,
  GE: 22,
  IQ: 23,
  LC: 32,
  SC: 31,
  ST: 25,
  SV: 28,
  TL: 23,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
};

const IBAN_SHAPE = /^([A-Z]{2})([0-9]{2})([A-Z0-9]+)$/;
const IBAN_STRIP = /[^A-Z0-9]/g;
const IBAN_LETTER = /[A-Z]/g;

/**
 * Doc check (same source as IBAN_CODE_LENGTHS): uppercase, strip non-alphanumerics, match
 * `^[A-Z]{2}[0-9]{2}[A-Z0-9]+$`, length must equal the per-country table, then the ISO 7064 mod
 * 97-10 of the rearranged digits must equal 1. Never throws; the length gate runs before the mod-97
 * step so a huge input is rejected without arithmetic.
 */
export function isValidIban(text: string): boolean {
  if (typeof text !== "string") {
    return false;
  }
  const iban = text.toUpperCase().replaceAll(IBAN_STRIP, "");
  const match = IBAN_SHAPE.exec(iban);
  const country = match?.[1];
  const check = match?.[2];
  const bban = match?.[3];
  if (country === undefined || check === undefined || bban === undefined) {
    return false;
  }
  const expectedLength = IBAN_CODE_LENGTHS[country];
  if (expectedLength === undefined || iban.length !== expectedLength) {
    return false;
  }
  const rearranged = (bban + country + check).replaceAll(IBAN_LETTER, (ch) =>
    String((ch.codePointAt(0) ?? 0) - 55),
  );
  return BigInt(rearranged) % 97n === 1n;
}
