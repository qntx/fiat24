import { describe, expect, test } from "vite-plus/test";

import { accountStatusFromIndex } from "../../src/core/index.ts";

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

describe("accountStatusFromIndex", () => {
  // enum Status (Fiat24Account.sol:26)
  test.each([
    [0, "na"],
    [1, "soft-blocked"],
    [2, "tourist"],
    [3, "blocked"],
    [4, "closed"],
    [5, "live"],
  ] as const)("index %d maps to %s", (index, status) => {
    expect(accountStatusFromIndex(index)).toBe(status);
  });

  test.each([6, 7, 100, -1, 1.5, 2.5, Number.NaN])(
    "rejects %d as invalid-rpc-response",
    (index) => {
      expect(code(() => accountStatusFromIndex(index))).toBe("invalid-rpc-response");
    },
  );
});
