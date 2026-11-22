import * as fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { formatAmount, MAX_UNITS, parseAmount } from "../../src/core/index.ts";
import type { Asset } from "../../src/core/index.ts";
import { okOrCode, throwsCode } from "../helpers.ts";

const ASSETS: ReadonlyArray<Asset> = ["USD24", "EUR24", "CHF24", "CNH24", "USDC", "F24"];
const AMOUNT_CODES = new Set(["invalid-amount", "too-many-decimals", "amount-out-of-range"]);
const TOO_MANY_DECIMALS = new Set(["too-many-decimals"]);
const asset = () => fc.constantFrom(...ASSETS);

describe("parseAmount properties", () => {
  test("any string parses to a bigint or throws one of the three amount codes", () => {
    expect(() =>
      fc.assert(
        fc.property(asset(), fc.string(), (a, text) =>
          okOrCode(
            () => parseAmount(a, text),
            AMOUNT_CODES,
            (value) => typeof value === "bigint",
          ),
        ),
      ),
    ).not.toThrow();
  });

  test("round-trip: parseAmount(asset, formatAmount(asset, units)) === units", () => {
    expect(() =>
      fc.assert(
        fc.property(asset(), fc.bigInt({ min: 0n, max: MAX_UNITS - 1n }), (a, units) => {
          expect(parseAmount(a, formatAmount(a, units))).toBe(units);
        }),
      ),
    ).not.toThrow();
  });

  test("round-trip: a formatted amount re-formats identically", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.tuple(asset(), fc.bigInt({ min: 0n, max: MAX_UNITS - 1n })),
          ([a, units]) => {
            const input = formatAmount(a, units);
            expect(formatAmount(a, parseAmount(a, input))).toBe(input);
          },
        ),
      ),
    ).not.toThrow();
  });

  test("a fraction longer than decimals is always too-many-decimals, never rounded", () => {
    expect(() =>
      fc.assert(
        fc.property(
          asset(),
          fc.bigInt({ min: 0n, max: 9999n }),
          fc.integer({ min: 1, max: 8 }),
          (a, units, extra) => {
            const decimals = { USD24: 2, EUR24: 2, CHF24: 2, CNH24: 2, USDC: 6, F24: 2 }[a];
            const input = `${units}.${"0".repeat(decimals - 1 + extra)}1`;
            return throwsCode(() => parseAmount(a, input), TOO_MANY_DECIMALS);
          },
        ),
      ),
    ).not.toThrow();
  });
});
