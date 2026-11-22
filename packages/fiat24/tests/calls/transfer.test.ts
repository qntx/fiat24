import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import { transferCall, transferToAccountCall } from "../../src/calls/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import type { Deployment } from "../../src/deployments/index.ts";
import { expectError, expectFrozenCall } from "../helpers.ts";

const TO = "0x1111111111111111111111111111111111111111";
const foreign: Deployment = { ...arbitrum, chainId: 1 as never };

describe("transferCall", () => {
  test("encodes transfer(to, amount) on the token proxy", () => {
    const call = transferCall({ currency: "EUR24", to: TO, amount: 12345n });
    expect(call.to).toBe(arbitrum.tokens.EUR24.proxy);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: tokenAbi, data: call.data });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toStrictEqual([TO, 12345n]);
    expectFrozenCall(call);
  });

  test("intent carries the checksummed recipient", () => {
    const lower = "0xcf4bf4fe76893cacc21b729a41ed22d83745f54b";
    const call = transferCall({ currency: "USD24", to: lower, amount: 1n });
    expect(call.intent).toStrictEqual({
      kind: "transfer",
      currency: "USD24",
      amount: 1n,
      to: { address: getAddress(lower) },
    });
    const decoded = decodeFunctionData({ abi: tokenAbi, data: call.data });
    expect(decoded.args).toStrictEqual([getAddress(lower), 1n]);
  });

  test("contracts = [currency, account] (§6.1)", () => {
    for (const currency of ["USD24", "EUR24", "CHF24", "CNH24"] as const) {
      const call = transferCall({ currency, to: TO, amount: 1n });
      expect(call.contracts).toStrictEqual([currency, "account"]);
    }
  });

  test("zero address is invalid-address", () => {
    expect.hasAssertions();
    expectError(
      () => transferCall({ currency: "EUR24", to: `0x${"0".repeat(40)}`, amount: 1n }),
      "invalid-address",
    );
  });

  test("any address of the deployment is invalid-address", () => {
    expect.hasAssertions();
    const pinned = [
      arbitrum.account.proxy,
      arbitrum.account.implementation,
      arbitrum.account.admin,
      arbitrum.tokens.EUR24.proxy,
      arbitrum.tokens.EUR24.implementation,
      arbitrum.deposit.proxy,
      arbitrum.card.proxy,
      arbitrum.priceList.proxy,
      arbitrum.f24Sales.proxy,
      arbitrum.f24.address,
      arbitrum.usdc,
      arbitrum.proxyAdmin.address,
      arbitrum.proxyAdmin.owner,
    ];
    for (const target of pinned) {
      expectError(
        () => transferCall({ currency: "EUR24", to: target, amount: 1n }),
        "invalid-address",
      );
    }
    // case-insensitive: a lowercased proxy is still a deployment address
    expectError(
      () =>
        transferCall({
          currency: "EUR24",
          to: arbitrum.tokens.CHF24.proxy.toLowerCase() as `0x${string}`,
          amount: 1n,
        }),
      "invalid-address",
    );
  });

  test("badly checksummed address is invalid-address", () => {
    expect.hasAssertions();
    expectError(
      () =>
        transferCall({
          currency: "EUR24",
          to: "0x111111111111111111111111111111111111De11",
          amount: 1n,
        }),
      "invalid-address",
    );
    expectError(
      () => transferCall({ currency: "EUR24", to: "0x123", amount: 1n }),
      "invalid-address",
    );
  });

  test("amount < 1 is invalid-amount; amount >= MAX_UNITS is amount-out-of-range", () => {
    expect.hasAssertions();
    expectError(() => transferCall({ currency: "EUR24", to: TO, amount: 0n }), "invalid-amount");
    expectError(
      () => transferCall({ currency: "EUR24", to: TO, amount: 10n ** 18n }),
      "amount-out-of-range",
    );
  });

  test("runtime-invalid currency is unsupported-currency", () => {
    expect.hasAssertions();
    expectError(
      () => transferCall({ currency: "DOGE" as never, to: TO, amount: 1n }),
      "unsupported-currency",
    );
  });

  test("foreign deployment is unsupported-chain (checked first)", () => {
    expect.hasAssertions();
    expectError(
      () =>
        transferCall({
          currency: "DOGE" as never,
          to: "0x123",
          amount: 0n,
          deployment: foreign,
        }),
      "unsupported-chain",
    );
  });
});

describe("transferToAccountCall", () => {
  test("encodes transferByAccountId(tokenId, amount)", () => {
    const call = transferToAccountCall({ currency: "CHF24", tokenId: 123456n, amount: 100n });
    expect(call.to).toBe(arbitrum.tokens.CHF24.proxy);
    const decoded = decodeFunctionData({ abi: tokenAbi, data: call.data });
    expect(decoded.functionName).toBe("transferByAccountId");
    expect(decoded.args).toStrictEqual([123456n, 100n]);
    expect(call.intent).toStrictEqual({
      kind: "transfer",
      currency: "CHF24",
      amount: 100n,
      to: { tokenId: 123456n },
    });
    expect(call.contracts).toStrictEqual(["CHF24", "account"]);
  });

  test("internal ids are internal-account (I12)", () => {
    expect.hasAssertions();
    for (const tokenId of [9100n, 9199n, 9299n]) {
      expectError(
        () => transferToAccountCall({ currency: "EUR24", tokenId, amount: 1n }),
        "internal-account",
      );
    }
  });

  test("boundary ids 9099 and 9300 are accepted", () => {
    for (const tokenId of [9099n, 9300n]) {
      expect(transferToAccountCall({ currency: "EUR24", tokenId, amount: 1n }).data).toBeDefined();
    }
  });

  test("tokenId 0 is invalid-account-id", () => {
    expect.hasAssertions();
    expectError(
      () => transferToAccountCall({ currency: "EUR24", tokenId: 0n, amount: 1n }),
      "invalid-account-id",
    );
  });

  test("invalid amount rules apply", () => {
    expect.hasAssertions();
    expectError(
      () => transferToAccountCall({ currency: "EUR24", tokenId: 123456n, amount: 0n }),
      "invalid-amount",
    );
  });
});
