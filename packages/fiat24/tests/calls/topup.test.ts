import { decodeFunctionData } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { depositAbi } from "../../src/abi/index.ts";
import { topUpCall } from "../../src/calls/index.ts";
import type { Currency } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { expectError, expectFrozenCall } from "../helpers.ts";

describe("topUpCall", () => {
  // Fiat24CryptoDeposit.sol:212-269: (usdc, outputToken, usdcAmount).
  test("encodes depositTokenViaUsdc(usdc, outputToken, usdcAmount)", () => {
    const call = topUpCall({ output: "EUR24", usdcAmount: 2_000_000n });
    expect(call.to).toBe(arbitrum.deposit.proxy);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: depositAbi, data: call.data });
    expect(decoded.functionName).toBe("depositTokenViaUsdc");
    expect(decoded.args).toStrictEqual([arbitrum.usdc, arbitrum.tokens.EUR24.proxy, 2_000_000n]);
    expect(call.intent).toStrictEqual({ kind: "top-up", output: "EUR24", usdcAmount: 2_000_000n });
    expect(call.contracts).toStrictEqual(["deposit", "account", "EUR24", "USD24"]);
    expectFrozenCall(call);
  });

  test("USD24 output deduplicates the contracts list", () => {
    const call = topUpCall({ output: "USD24", usdcAmount: 1n });
    expect(call.contracts).toStrictEqual(["deposit", "account", "USD24"]);
    const decoded = decodeFunctionData({ abi: depositAbi, data: call.data });
    expect(decoded.args).toStrictEqual([arbitrum.usdc, arbitrum.tokens.USD24.proxy, 1n]);
  });

  test("contracts for the other outputs", () => {
    for (const output of ["EUR24", "CHF24", "CNH24"] as const) {
      expect(topUpCall({ output, usdcAmount: 1n }).contracts).toStrictEqual([
        "deposit",
        "account",
        output,
        "USD24",
      ]);
    }
  });

  test("runtime-invalid output is unsupported-currency", () => {
    expect.hasAssertions();
    expectError(
      () => topUpCall({ output: "DOGE" as Currency, usdcAmount: 1n }),
      "unsupported-currency",
    );
  });

  test("invalid amount rules apply", () => {
    expect.hasAssertions();
    expectError(() => topUpCall({ output: "EUR24", usdcAmount: 0n }), "invalid-amount");
    expectError(
      () => topUpCall({ output: "EUR24", usdcAmount: 10n ** 18n }),
      "amount-out-of-range",
    );
  });
});
