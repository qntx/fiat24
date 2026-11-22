import { describe, expect, test } from "vite-plus/test";

import { ibanOf, isValidIban } from "../../src/core/index.ts";

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      return String(error.code);
    }
    throw error;
  }
  throw new Error("expected a Fiat24Error");
}

describe("ibanOf", () => {
  // Recorded GET /iban/{id} bodies, network 42161 (vectors/core/iban.json).
  test.each([
    [1n, "CH6483051000000000001"],
    [12345n, "CH6883051000000012345"],
    [9102n, "CH3883051000000009102"],
    [123456n, "CH8783051000000123456"],
    [350000n, "CH2583051000000350000"],
    [99999999999n, "CH8083051099999999999"],
  ] as const)("ibanOf(%d) === %s", (id, iban) => {
    expect(ibanOf(id)).toBe(iban);
    expect(iban).toHaveLength(21);
    expect(isValidIban(iban)).toBe(true);
  });

  test.each([-1n, 0n, 100000000000n, 999999999999n, 2n ** 256n - 1n])(
    "rejects %d as invalid-account-id",
    (id) => {
      expect(code(() => ibanOf(id))).toBe("invalid-account-id");
    },
  );

  test("99999999999 is the last unambiguous id (Mantle shares the account field)", () => {
    expect(() => ibanOf(99999999999n)).not.toThrow();
    expect(code(() => ibanOf(99999999999n + 1n))).toBe("invalid-account-id");
  });
});

describe("isValidIban", () => {
  test.each([
    "CH6483051000000000001",
    "ch64 8305 1000 0000 0000 1", // lowercase + grouping spaces
    "CH64-8305-1000-0000-0000-1", // dashes are stripped like spaces
    "CH!!6483051000000000001", // non-alphanumerics are stripped before matching
    "DE89370400440532013000", // a non-CH IBAN from the country table
    "GB29NWBK60161331926819",
  ])("accepts %j", (text) => {
    expect(isValidIban(text)).toBe(true);
  });

  test.each([
    "",
    "CH6483051000000000002", // one digit changed: mod-97 fails
    "CH648305100000000000", // wrong length for CH
    "CH64830510000000000012", // wrong length for CH
    "XX6483051000000000001", // country not in the table
    "12DE893704004405320130", // check digits must be digits, country letters
    "not an iban",
    "CH6483051000000000001ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", // too long
  ])("rejects %j", (text) => {
    expect(isValidIban(text)).toBe(false);
  });

  test("bounds work by the length table before any mod-97 step", () => {
    const huge = `CH64${"8".repeat(1_000_000)}`;
    expect(isValidIban(huge)).toBe(false);
    expect(isValidIban("x".repeat(1_000_000))).toBe(false);
  });
});
