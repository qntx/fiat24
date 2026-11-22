import { Fiat24Error } from "../core/errors.ts";
import { freeze } from "../core/freeze.ts";
import { isValidIban } from "../core/iban.ts";
import type { SwissQr } from "./types.ts";

// SIX IG QR-bill v2.3 (en) / v2.4 (de) §4.2.2: the Swiss QR payload is at most 997 chars, lines
// separated by CR LF (LF accepted), with the element order used below (SPEC §9.4).
const MAX_QR_LENGTH = 997;
const QR_ACCOUNT = /^(CH|LI)[0-9]{2}[A-Z0-9]{17}$/;
const QR_AMOUNT = /^[0-9]{1,9}\.[0-9]{2}$/;

function invalid(): never {
  throw new Fiat24Error("invalid-argument", "invalid argument");
}

function isCurrency(line: string | undefined): line is "CHF" | "EUR" {
  return line === "CHF" || line === "EUR";
}

/**
 * Parses the creditor fields the /verify binding needs (SPEC §9.4): line 0 `SPC`, line 1 `0200`,
 * line 3 the creditor account in electronic IBAN form (fixed 21 chars, no spaces; CH or LI), then
 * the `amount`/`currency` pair at the strict SIX element order positions — line 18/19 after the
 * seven UltmtCdtr fields (the doc's published example lands there). An empty amount (open QR) is
 * refused because it cannot be bound; the amount comes out in cents. Everything else ⇒
 * `invalid-argument`.
 */
export function parseSwissQr(qr: string): SwissQr {
  if (typeof qr !== "string" || qr.length > MAX_QR_LENGTH) {
    invalid();
  }
  const lines = qr.split(/\r?\n/);
  if (lines.length < 20 || lines[0] !== "SPC" || lines[1] !== "0200") {
    invalid();
  }
  const account = lines[3] ?? "";
  if (!QR_ACCOUNT.test(account) || !isValidIban(account)) {
    invalid();
  }
  const { 18: amountLine = "", 19: currency } = lines;
  if (!QR_AMOUNT.test(amountLine) || !isCurrency(currency)) {
    invalid();
  }
  const dot = amountLine.indexOf(".");
  const amount = BigInt(amountLine.slice(0, dot)) * 100n + BigInt(amountLine.slice(dot + 1));
  return freeze({ account, amount, currency });
}
