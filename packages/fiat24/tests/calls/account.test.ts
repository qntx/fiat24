import { decodeFunctionData } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { accountAbi } from "../../src/abi/index.ts";
import { mintAccountCall, mintAccountWithEthCall } from "../../src/calls/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { expectError, expectFrozenCall } from "../helpers.ts";

describe("mintAccountCall", () => {
  test("encodes mintByClient(tokenId)", () => {
    const call = mintAccountCall({ tokenId: 123456n });
    expect(call.to).toBe(arbitrum.account.proxy);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: accountAbi, data: call.data });
    expect(decoded.functionName).toBe("mintByClient");
    expect(decoded.args).toStrictEqual([123456n]);
    expect(call.intent).toStrictEqual({ kind: "mint", tokenId: 123456n, payment: "f24" });
    expect(call.contracts).toStrictEqual(["account", "priceList", "f24"]);
    expectFrozenCall(call);
  });

  test("non-standard mint ids are invalid-account-id", () => {
    expect.hasAssertions();
    for (const tokenId of [0n, 99999n, 800000n, 900000n, 9100n, 2n ** 256n - 1n]) {
      expectError(() => mintAccountCall({ tokenId }), "invalid-account-id");
    }
    for (const tokenId of [100000n, 799999n]) {
      expect(mintAccountCall({ tokenId }).data).toBeDefined();
    }
  });
});

describe("mintAccountWithEthCall", () => {
  test("encodes mintByClientWithETH(tokenId) with the ETH value", () => {
    const call = mintAccountWithEthCall({ tokenId: 123456n, value: 10n ** 16n });
    expect(call.to).toBe(arbitrum.account.proxy);
    expect(call.value).toBe(10n ** 16n);
    const decoded = decodeFunctionData({ abi: accountAbi, data: call.data });
    expect(decoded.functionName).toBe("mintByClientWithETH");
    expect(decoded.args).toStrictEqual([123456n]);
    expect(call.intent).toStrictEqual({ kind: "mint", tokenId: 123456n, payment: "eth" });
    expect(call.contracts).toStrictEqual(["account", "priceList", "f24", "f24Sales"]);
  });

  test("value <= 0 is invalid-amount; no upper bound", () => {
    expect.hasAssertions();
    for (const value of [0n, -1n]) {
      expectError(() => mintAccountWithEthCall({ tokenId: 123456n, value }), "invalid-amount");
    }
    expect(mintAccountWithEthCall({ tokenId: 123456n, value: 10n ** 20n }).value).toBe(10n ** 20n);
  });

  test("non-standard mint ids are invalid-account-id", () => {
    expect.hasAssertions();
    expectError(() => mintAccountWithEthCall({ tokenId: 99999n, value: 1n }), "invalid-account-id");
  });
});
