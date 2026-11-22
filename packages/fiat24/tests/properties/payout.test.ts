import * as fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { isValidContactId, isValidPayoutRef } from "../../src/calls/index.ts";

// Independent char-by-char reference implementations written straight from §6.2 —
// deliberately NOT the same regex the SDK uses.

const isUpperAlpha = (ch: string): boolean => ch >= "A" && ch <= "Z";
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isHexLower = (ch: string): boolean => (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f");

/** §6.2 `^[A-Z]{2,8}(-[0-9]{1,16})?$` by hand. */
function contactRef(text: string): boolean {
  if (typeof text !== "string") {
    return false;
  }
  const dash = text.indexOf("-");
  const head = dash === -1 ? text : text.slice(0, dash);
  const tail = dash === -1 ? "" : text.slice(dash + 1);
  if (tail.includes("-")) {
    return false;
  }
  if (head.length < 2 || head.length > 8 || !head.split("").every(isUpperAlpha)) {
    return false;
  }
  if (dash === -1) {
    return true;
  }
  return tail.length > 0 && tail.length <= 16 && tail.split("").every(isDigit);
}

/** §6.2 `P "-" U Z` by hand: uuid 8-4-4-4-12, then only NULs filling to exactly 45. */
function payoutRefRef(text: string, tokenId: bigint): boolean {
  if (typeof text !== "string" || typeof tokenId !== "bigint" || tokenId < 1n) {
    return false;
  }
  const prefix = `${tokenId}-`;
  if (!text.startsWith(prefix)) {
    return false;
  }
  const rest = text.slice(prefix.length);
  const uuid = rest.slice(0, 36);
  const padding = rest.slice(36);
  if (uuid.length !== 36) {
    return false;
  }
  const groups = [8, 4, 4, 4, 12];
  let index = 0;
  for (const [groupIndex, size] of groups.entries()) {
    for (let i = 0; i < size; i += 1) {
      if (!isHexLower(uuid[index + i] ?? "")) {
        return false;
      }
    }
    index += size;
    if (groupIndex < groups.length - 1) {
      if (uuid[index] !== "-") {
        return false;
      }
      index += 1;
    }
  }
  if (padding.length === 0) {
    return true;
  }
  if (text.length !== 45) {
    return false;
  }
  return padding.split("").every((ch) => ch === "\u0000");
}

const stringWithNuls = fc.string({
  unit: fc.constantFrom(..."0123456789abcdef-XYZ\u0000".split("")),
});

describe("isValidContactId properties", () => {
  test("never throws and agrees with the char-by-char reference", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), (text) => {
          let result = false;
          try {
            result = isValidContactId(text);
          } catch {
            return false;
          }
          return result === contactRef(text);
        }),
      ),
    ).not.toThrow();
  });

  test("agrees on biased contact-shaped inputs", () => {
    expect(() =>
      fc.assert(fc.property(stringWithNuls, (text) => isValidContactId(text) === contactRef(text))),
    ).not.toThrow();
  });
});

describe("isValidPayoutRef properties", () => {
  test("never throws and agrees with the char-by-char reference", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), fc.bigInt({ min: -5n, max: 10n ** 12n }), (text, tokenId) => {
          let result = false;
          try {
            result = isValidPayoutRef(text, tokenId);
          } catch {
            return false;
          }
          return result === payoutRefRef(text, tokenId);
        }),
      ),
    ).not.toThrow();
  });

  test("agrees on biased ref-shaped inputs (uuid chars, dashes, NULs)", () => {
    expect(() =>
      fc.assert(
        fc.property(
          stringWithNuls,
          fc.bigInt({ min: 0n, max: 10n ** 11n - 1n }),
          (text, tokenId) => isValidPayoutRef(text, tokenId) === payoutRefRef(text, tokenId),
        ),
      ),
    ).not.toThrow();
  });

  test("non-string / non-bigint inputs never throw", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.anything(), fc.anything(), (text, tokenId) => {
          try {
            void isValidPayoutRef(text as string, tokenId as bigint);
            return true;
          } catch {
            return false;
          }
        }),
      ),
    ).not.toThrow();
  });
});
