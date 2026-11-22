import * as fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { ibanOf, isValidIban } from "../../src/core/index.ts";
import { okOrCode } from "../helpers.ts";

const INVALID_ACCOUNT_ID = new Set(["invalid-account-id"]);

// Independent ISO 7064 mod 97-10 check (rearranged digits % 97 === 1).
function mod97(iban: string): bigint {
  const rearranged = (iban.slice(4) + iban.slice(0, 4)).replaceAll(/[A-Z]/g, (ch) =>
    String((ch.codePointAt(0) ?? 0) - 55),
  );
  return BigInt(rearranged) % 97n;
}

describe("ibanOf properties", () => {
  test("every valid id produces an IBAN with mod-97 === 1", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.bigInt({ min: 1n, max: 99999999999n }), (id) => {
          const iban = ibanOf(id);
          expect(iban).toHaveLength(21);
          expect(iban.startsWith("CH")).toBe(true);
          expect(mod97(iban)).toBe(1n);
          expect(isValidIban(iban)).toBe(true);
        }),
      ),
    ).not.toThrow();
  });

  test("any bigint resolves to an IBAN or throws invalid-account-id", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.bigInt(), (id) =>
          okOrCode(
            () => isValidIban(ibanOf(id)),
            INVALID_ACCOUNT_ID,
            (value) => value === true,
          ),
        ),
      ),
    ).not.toThrow();
  });
});

describe("isValidIban properties", () => {
  test("never throws and always returns a boolean, even on huge inputs", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.string({ maxLength: 2000 }),
          (text) => typeof isValidIban(text) === "boolean",
        ),
      ),
    ).not.toThrow();
    expect(isValidIban("A".repeat(10_000_000))).toBe(false);
  });

  test("any string accepted by isValidIban round-trips through the sanitizer", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.string(),
          // Sanitising changes nothing: an accepted string stays accepted.
          (text) =>
            isValidIban(text.toUpperCase().replaceAll(/[^A-Z0-9]/g, "")) === isValidIban(text),
        ),
      ),
    ).not.toThrow();
  });
});
