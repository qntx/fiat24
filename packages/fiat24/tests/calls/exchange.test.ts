import { decodeFunctionData } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { depositAbi } from "../../src/abi/index.ts";
import { exchangeCall } from "../../src/calls/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { expectError, expectFrozenCall } from "../helpers.ts";

describe("exchangeCall", () => {
  // Fiat24CryptoDeposit.sol:369-404: exact-in takes the input amount, exact-out
  // takes the desired output amount; both pass it as the third argument.
  test("exact-in encodes moneyExchangeExactIn(from, to, inputAmount)", () => {
    const call = exchangeCall({ side: "exact-in", from: "EUR24", to: "USD24", amount: 123456n });
    expect(call.to).toBe(arbitrum.deposit.proxy);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: depositAbi, data: call.data });
    expect(decoded.functionName).toBe("moneyExchangeExactIn");
    expect(decoded.args).toStrictEqual([
      arbitrum.tokens.EUR24.proxy,
      arbitrum.tokens.USD24.proxy,
      123456n,
    ]);
    expect(call.intent).toStrictEqual({
      kind: "exchange",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: 123456n,
    });
    expect(call.contracts).toStrictEqual(["deposit", "EUR24", "USD24", "account"]);
    expectFrozenCall(call);
  });

  test("exact-out encodes moneyExchangeExactOut(from, to, outputAmount)", () => {
    const call = exchangeCall({ side: "exact-out", from: "CHF24", to: "EUR24", amount: 500n });
    const decoded = decodeFunctionData({ abi: depositAbi, data: call.data });
    expect(decoded.functionName).toBe("moneyExchangeExactOut");
    expect(decoded.args).toStrictEqual([
      arbitrum.tokens.CHF24.proxy,
      arbitrum.tokens.EUR24.proxy,
      500n,
    ]);
    expect(call.contracts).toStrictEqual(["deposit", "CHF24", "EUR24", "account"]);
  });

  test("from === to is invalid-argument", () => {
    expect.hasAssertions();
    expectError(
      () => exchangeCall({ side: "exact-in", from: "EUR24", to: "EUR24", amount: 1n }),
      "invalid-argument",
    );
    expectError(
      () => exchangeCall({ side: "exact-out", from: "CNH24", to: "CNH24", amount: 1n }),
      "invalid-argument",
    );
  });

  test("runtime-invalid side is invalid-argument", () => {
    expect.hasAssertions();
    expectError(
      () => exchangeCall({ side: "market" as never, from: "EUR24", to: "USD24", amount: 1n }),
      "invalid-argument",
    );
  });

  test("runtime-invalid currency is unsupported-currency", () => {
    expect.hasAssertions();
    expectError(
      () => exchangeCall({ side: "exact-in", from: "DOGE" as never, to: "USD24", amount: 1n }),
      "unsupported-currency",
    );
    expectError(
      () => exchangeCall({ side: "exact-in", from: "EUR24", to: "DOGE" as never, amount: 1n }),
      "unsupported-currency",
    );
  });

  test("invalid amount rules apply", () => {
    expect.hasAssertions();
    expectError(
      () => exchangeCall({ side: "exact-in", from: "EUR24", to: "USD24", amount: 0n }),
      "invalid-amount",
    );
    expectError(
      () => exchangeCall({ side: "exact-in", from: "EUR24", to: "USD24", amount: 10n ** 18n }),
      "amount-out-of-range",
    );
  });
});
