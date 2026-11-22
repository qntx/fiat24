// Internal §6.2 grammars shared by calls (builder checks + public re-export) and api (the §10.6
// /verify bindings). Not re-exported from core/index.ts: the public surface stays on calls.

const CONTACT_ID = /^[A-Z]{2,8}(-[0-9]{1,16})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `^[A-Z]{2,8}(-[0-9]{1,16})?$` (§6.2); never throws. */
export function isValidContactId(text: string): boolean {
  return typeof text === "string" && CONTACT_ID.test(text);
}

/**
 * §6.2 `P "-" U Z`: the payer's tokenId in canonical decimal, a lowercase uuid, then zero or more
 * U+0000; padding, when present, must fill the field to exactly 45 chars (observed on chain:
 * `690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\0\0`). Never throws.
 */
export function isValidPayoutRef(text: string, tokenId: bigint): boolean {
  if (typeof text !== "string" || typeof tokenId !== "bigint" || tokenId < 1n) {
    return false;
  }
  const prefix = `${tokenId}-`;
  if (!text.startsWith(prefix) || !UUID.test(text.slice(prefix.length, prefix.length + 36))) {
    return false;
  }
  const padding = text.slice(prefix.length + 36);
  if (padding.length === 0) {
    return true;
  }
  return text.length === 45 && padding.split("").every((ch) => ch === "\u0000");
}
