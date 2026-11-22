import { describe, expect, test } from "vite-plus/test";

import {
  DECIMALS,
  formatAmount,
  isFiat24Error,
  MAX_UNITS,
  parseAmount,
} from "../../src/core/index.ts";
import type { Asset } from "../../src/core/index.ts";

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isFiat24Error(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected a Fiat24Error");
}

describe("DECIMALS", () => {
  test("pin the contract decimals (SPEC §4.2)", () => {
    expect(DECIMALS).toStrictEqual({
      USD24: 2,
      EUR24: 2,
      CHF24: 2,
      CNH24: 2,
      USDC: 6,
      F24: 2,
    });
    expect(Object.isFrozen(DECIMALS)).toBe(true);
  });
});

describe("parseAmount", () => {
  test.each([
    ["EUR24", "0", 0n],
    ["EUR24", "0.00", 0n],
    ["EUR24", "12.3", 1230n],
    ["EUR24", "01.50", 150n],
    ["USDC", "0.000001", 1n],
    ["F24", "1", 100n],
    ["EUR24", "9999999999999999.99", 999999999999999999n],
  ] as const)("parses %s %s to %d", (asset, input, expected) => {
    expect(parseAmount(asset, input)).toBe(expected);
  });

  test.each([
    "1.234", // more fraction digits than decimals
    "1.230", // trailing zero still counts
    "0.000",
  ])("rejects %s as too-many-decimals", (input) => {
    expect(code(() => parseAmount("EUR24", input))).toBe("too-many-decimals");
  });

  test.each([
    "",
    " 1",
    "1 ",
    "-1",
    "+1",
    "1e3",
    "1.",
    ".5",
    "1,5",
    "١٢",
    "0x10",
    "1.2.3",
    "NaN",
    // 41 characters: the length cap applies independently of the grammar.
    "11111111111111111111111111111111111111111",
    "9999999999999999999999999999999999999999.9",
  ])("rejects %j as invalid-amount", (input) => {
    expect(code(() => parseAmount("EUR24", input))).toBe("invalid-amount");
  });

  test("rejects results >= MAX_UNITS as amount-out-of-range", () => {
    expect(code(() => parseAmount("EUR24", "10000000000000000"))).toBe("amount-out-of-range");
    expect(parseAmount("EUR24", "9999999999999999.99")).toBe(MAX_UNITS - 1n);
  });

  test("rejects an asset outside the union as invalid-argument", () => {
    expect(code(() => parseAmount("GBP24" as Asset, "1"))).toBe("invalid-argument");
    expect(code(() => parseAmount("toString" as Asset, "1"))).toBe("invalid-argument");
  });
});

describe("formatAmount", () => {
  test.each([
    ["EUR24", 0n, "0.00"],
    ["EUR24", 5n, "0.05"],
    ["EUR24", 1230n, "12.30"],
    ["USDC", 1n, "0.000001"],
    ["USDC", 5000000n, "5.000000"],
    ["F24", 100n, "1.00"],
    ["EUR24", MAX_UNITS - 1n, "9999999999999999.99"],
  ] as const)("formats %s %d as %s", (asset, units, expected) => {
    expect(formatAmount(asset, units)).toBe(expected);
  });

  test("rejects negative units as invalid-amount", () => {
    expect(code(() => formatAmount("EUR24", -1n))).toBe("invalid-amount");
  });

  test("rejects units >= MAX_UNITS as amount-out-of-range", () => {
    expect(code(() => formatAmount("EUR24", MAX_UNITS))).toBe("amount-out-of-range");
  });

  test("rejects an asset outside the union as invalid-argument", () => {
    expect(code(() => formatAmount("GBP24" as Asset, 1n))).toBe("invalid-argument");
  });
});

describe("MAX_UNITS", () => {
  test("is 10^18", () => {
    expect(MAX_UNITS).toBe(10n ** 18n);
  });
});
