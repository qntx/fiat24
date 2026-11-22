import { decodeFunctionData, erc20Abi } from "viem";
import type { Abi } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { f24Abi, tokenAbi } from "../../src/abi/index.ts";
import { approveCall } from "../../src/calls/index.ts";
import type { ApprovalSpender, Asset } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { expectError, expectFrozenCall } from "../helpers.ts";

const CASH = ["USD24", "EUR24", "CHF24", "CNH24"] as const;

const ABI_OF: Record<Asset, Abi> = {
  USD24: tokenAbi,
  EUR24: tokenAbi,
  CHF24: tokenAbi,
  CNH24: tokenAbi,
  USDC: erc20Abi,
  F24: f24Abi,
};

// §6.1 contracts column per asset (cash ⇒ [asset, spender contract name]).
const expectedContracts = (asset: Asset, spender: ApprovalSpender): ReadonlyArray<string> =>
  asset === "USDC" ? ["deposit"] : asset === "F24" ? ["f24", "account"] : [asset, spender];

describe("approveCall", () => {
  test("encodes approve(spender, amount) for every allowed pair (§6.1)", () => {
    const allowed: ReadonlyArray<readonly [Asset, ApprovalSpender, `0x${string}`, `0x${string}`]> =
      [
        ...CASH.flatMap(
          (
            asset,
          ): ReadonlyArray<readonly [Asset, ApprovalSpender, `0x${string}`, `0x${string}`]> => [
            [asset, "card", arbitrum.tokens[asset].proxy, arbitrum.card.proxy],
            [asset, "deposit", arbitrum.tokens[asset].proxy, arbitrum.deposit.proxy],
          ],
        ),
        ["USDC", "deposit", arbitrum.usdc, arbitrum.deposit.proxy],
        ["F24", "account", arbitrum.f24.address, arbitrum.account.proxy],
      ];
    for (const [asset, spender, target, spenderAddress] of allowed) {
      const call = approveCall({ asset, spender, amount: 25000n });
      expect(call.to).toBe(target);
      const abi = ABI_OF[asset];
      const decoded = decodeFunctionData({ abi, data: call.data });
      expect(decoded.functionName).toBe("approve");
      expect(decoded.args).toStrictEqual([spenderAddress, 25000n]);
      expect(call.intent).toStrictEqual({ kind: "approve", asset, spender, amount: 25000n });
      const contracts = expectedContracts(asset, spender);
      expect(call.contracts).toStrictEqual(contracts);
      expect(call.value).toBe(0n);
      expectFrozenCall(call);
    }
  });

  test("amount 0 is allowed (revoke)", () => {
    const call = approveCall({ asset: "EUR24", spender: "deposit", amount: 0n });
    const decoded = decodeFunctionData({ abi: tokenAbi, data: call.data });
    expect(decoded.args).toStrictEqual([arbitrum.deposit.proxy, 0n]);
  });

  test("amount >= MAX_UNITS is unlimited-approval (I11)", () => {
    expect.hasAssertions();
    for (const amount of [10n ** 18n, 2n ** 256n - 1n]) {
      expectError(
        () => approveCall({ asset: "EUR24", spender: "deposit", amount }),
        "unlimited-approval",
      );
    }
    // the largest bounded approval is allowed
    expect(
      approveCall({ asset: "EUR24", spender: "deposit", amount: 10n ** 18n - 1n }).data,
    ).toBeDefined();
  });

  test("negative amount is invalid-amount", () => {
    expect.hasAssertions();
    expectError(
      () => approveCall({ asset: "EUR24", spender: "deposit", amount: -1n }),
      "invalid-amount",
    );
  });

  test("disallowed pairs are invalid-argument", () => {
    expect.hasAssertions();
    const disallowed: ReadonlyArray<readonly [Asset, ApprovalSpender]> = [
      ["EUR24", "account"],
      ["USD24", "account"],
      ["USDC", "card"],
      ["USDC", "account"],
      ["F24", "card"],
      ["F24", "deposit"],
    ];
    for (const [asset, spender] of disallowed) {
      expectError(() => approveCall({ asset, spender, amount: 1n }), "invalid-argument");
    }
  });

  test("runtime-invalid asset is unsupported-currency; spender is invalid-argument", () => {
    expect.hasAssertions();
    expectError(
      () => approveCall({ asset: "DOGE" as never, spender: "deposit", amount: 1n }),
      "unsupported-currency",
    );
    expectError(
      () => approveCall({ asset: "EUR24", spender: "owner" as never, amount: 1n }),
      "invalid-argument",
    );
  });
});
