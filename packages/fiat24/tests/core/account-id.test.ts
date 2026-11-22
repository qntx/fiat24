import { describe, expect, test } from "vite-plus/test";

import {
  assertTokenId,
  INTERNAL_ACCOUNTS,
  isInternalAccount,
  isStandardMintId,
} from "../../src/core/index.ts";

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

describe("assertTokenId", () => {
  test.each([1n, 2n, 123456n, 99999999999n, 2n ** 256n - 1n])("accepts %d", (id) => {
    expect(() => assertTokenId(id)).not.toThrow();
  });

  test.each([-1n, 0n, 2n ** 256n, 2n ** 256n + 1n])("rejects %d as invalid-account-id", (id) => {
    expect(code(() => assertTokenId(id))).toBe("invalid-account-id");
  });
});

describe("isInternalAccount", () => {
  test.each([
    [9099n, false],
    [9100n, true],
    [9102n, true],
    [9203n, true],
    [9299n, true],
    [9300n, false],
    [0n, false],
    [123456n, false],
  ])("isInternalAccount(%d) === %s", (id, expected) => {
    expect(isInternalAccount(id)).toBe(expected);
  });
});

describe("INTERNAL_ACCOUNTS", () => {
  test("pins the nine internal desks (SPEC §4.2)", () => {
    expect(INTERNAL_ACCOUNTS).toStrictEqual({
      treasury: 9100n,
      cashDesk: 9101n,
      payoutDesk: 9102n,
      sundry: 9103n,
      payoutBurn: 9104n,
      cryptoDesk: 9105n,
      closedCollector: 9106n,
      cardBooked: 9110n,
      feeDesk: 9203n,
    });
    expect(Object.isFrozen(INTERNAL_ACCOUNTS)).toBe(true);
  });
});

describe("isStandardMintId", () => {
  test.each([
    [0n, false],
    [99999n, false],
    [100000n, true],
    [123456n, true],
    [350000n, true],
    [799999n, true],
    [800000n, false],
    [9100n, false],
    [99999999999n, false],
  ])("isStandardMintId(%d) === %s", (id, expected) => {
    expect(isStandardMintId(id)).toBe(expected);
  });
});
