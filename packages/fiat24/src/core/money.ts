import { Fiat24Error } from "./errors.ts";
import type { Asset } from "./types.ts";

// Token decimals of the pinned implementations: the four cash tokens are pure
// `decimals() = 2` (Fiat24Token.sol:256-258), F24 `decimals() = 2`, Circle USDC
// on Arbitrum `decimals() = 6` (SPEC §4.2).
export const DECIMALS: Readonly<Record<Asset, number>> = Object.freeze({
  USD24: 2,
  EUR24: 2,
  CHF24: 2,
  CNH24: 2,
  USDC: 6,
  F24: 2,
});

// All Fiat24 amounts stay below 10^18 units; the same bound doubles as the
// "unlimited approval" ceiling in calls.
export const MAX_UNITS: bigint = 10n ** 18n;

// SPEC §5.1: ASCII digits with an optional fraction part — no sign, exponent,
// separators, whitespace or non-ASCII digits — and at most 40 characters.
const AMOUNT_RE = /^[0-9]+(\.[0-9]+)?$/;
const MAX_AMOUNT_TEXT_LENGTH = 40;

function decimalsOf(asset: Asset): number {
  // A JS caller can pass a string outside the Asset union; reject it rather
  // than silently reading `undefined` decimals.
  if (!Object.hasOwn(DECIMALS, asset)) {
    throw new Fiat24Error("invalid-argument", "unknown asset");
  }
  return DECIMALS[asset];
}

export function parseAmount(asset: Asset, text: string): bigint {
  const decimals = decimalsOf(asset);
  if (typeof text !== "string" || text.length > MAX_AMOUNT_TEXT_LENGTH || !AMOUNT_RE.test(text)) {
    throw new Fiat24Error("invalid-amount", "invalid amount");
  }
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? "" : text.slice(dot + 1);
  // Trailing zeros count too: `1.230` on a 2-decimal asset is refused, never
  // rounded (SPEC §5.1).
  if (fraction.length > decimals) {
    throw new Fiat24Error("too-many-decimals", "amount has too many decimals");
  }
  const units = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (units >= MAX_UNITS) {
    throw new Fiat24Error("amount-out-of-range", "amount out of range");
  }
  return units;
}

export function formatAmount(asset: Asset, units: bigint): string {
  const decimals = decimalsOf(asset);
  if (units < 0n) {
    throw new Fiat24Error("invalid-amount", "invalid amount");
  }
  if (units >= MAX_UNITS) {
    throw new Fiat24Error("amount-out-of-range", "amount out of range");
  }
  const digits = units.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals)}`;
}
