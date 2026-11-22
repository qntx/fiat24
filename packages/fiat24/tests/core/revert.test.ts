import { encodeAbiParameters, toFunctionSelector } from "viem";
import type { Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { fiat24ErrorsAbi } from "../../src/abi/index.ts";
import { decodeFiat24Revert, revertCode } from "../../src/core/index.ts";
import type { Fiat24ErrorCode } from "../../src/core/index.ts";

const A = "0x133CAEecA096cA54889db71956c7f75862Ead7A0";

const errorString = (reason: string): Hex =>
  `0x08c379a0${encodeAbiParameters([{ type: "string" }], [reason]).slice(2)}`;

const panic = (code: bigint): Hex =>
  `0x4e487b71${encodeAbiParameters([{ type: "uint256" }], [code]).slice(2)}`;

function custom(errorName: string, args: ReadonlyArray<unknown>): Hex {
  for (const entry of fiat24ErrorsAbi) {
    if (entry.type === "error" && entry.name === errorName) {
      const signature = `${errorName}(${entry.inputs.map((input) => input.type).join(",")})`;
      const params = entry.inputs.map((input) => ({ type: input.type }));
      return `0x${toFunctionSelector(signature).slice(2)}${encodeAbiParameters(params, args).slice(2)}`;
    }
  }
  throw new Error(`error ${errorName} not in fiat24ErrorsAbi`);
}

describe("decodeFiat24Revert", () => {
  test("decodes Error(string)", () => {
    expect(decodeFiat24Revert(errorString("STF"))).toStrictEqual({ kind: "error", reason: "STF" });
    expect(decodeFiat24Revert(errorString(""))).toStrictEqual({ kind: "error", reason: "" });
  });

  test("decodes Panic(uint256)", () => {
    expect(decodeFiat24Revert(panic(0x11n))).toStrictEqual({ kind: "panic", code: 17n });
    expect(decodeFiat24Revert(panic(1n))).toStrictEqual({ kind: "panic", code: 1n });
  });

  test("decodes uppercase hex identically", () => {
    const upcase = (data: Hex): Hex => `0x${data.slice(2).toUpperCase()}`;
    expect(decodeFiat24Revert(upcase(errorString("STF")))).toStrictEqual({
      kind: "error",
      reason: "STF",
    });
    expect(decodeFiat24Revert(upcase(panic(0x11n)))).toStrictEqual({ kind: "panic", code: 17n });
    expect(decodeFiat24Revert(upcase(custom("F24Sales__Paused", [])))).toStrictEqual({
      kind: "custom",
      name: "F24Sales__Paused",
    });
    expect(decodeFiat24Revert(upcase(errorString("x".repeat(201))))).toStrictEqual({
      kind: "unknown",
    });
  });

  test("decodes a custom error to its ABI name", () => {
    expect(decodeFiat24Revert(custom("F24Sales__Paused", []))).toStrictEqual({
      kind: "custom",
      name: "F24Sales__Paused",
    });
    expect(decodeFiat24Revert(custom("Fiat24CryptoDeposit__AddressHasNoToken", [A]))).toStrictEqual(
      { kind: "custom", name: "Fiat24CryptoDeposit__AddressHasNoToken" },
    );
  });

  test.each([
    ["0x", "empty"],
    ["0x12", "shorter than a selector"],
    ["0xdeadbeef", "unrecognised selector"],
    ["0x08c379a0a", "odd hex length"],
    ["0xzzzzzzzz", "non-hex"],
    ["0x08c379a0", "Error(string) selector with no arguments"],
    [`0x08c379a0${"00".repeat(10)}`, "Error(string) selector, truncated arguments"],
    [`0x4e487b71${"00".repeat(10)}`, "Panic selector, truncated arguments"],
  ])("decodes %s to unknown (%s)", (data) => {
    expect(decodeFiat24Revert(data as Hex)).toStrictEqual({ kind: "unknown" });
  });

  test("rejects an over-long Error(string) reason as unknown", () => {
    expect(decodeFiat24Revert(errorString("x".repeat(200)))).toStrictEqual({
      kind: "error",
      reason: "x".repeat(200),
    });
    expect(decodeFiat24Revert(errorString("x".repeat(201)))).toStrictEqual({ kind: "unknown" });
  });

  test.each(["line\nbreak", `bell${String.fromCodePoint(7)}`, "emoji 🚀", "ümlaut"])(
    "rejects a non-printable-ASCII reason %j as unknown",
    (reason) => {
      expect(decodeFiat24Revert(errorString(reason))).toStrictEqual({ kind: "unknown" });
    },
  );

  test("a known selector with truncated arguments is unknown", () => {
    const hasNoToken = custom("Fiat24CryptoDeposit__AddressHasNoToken", [A]);
    const truncated = hasNoToken.slice(0, -34);
    expect(decodeFiat24Revert(truncated as Hex)).toStrictEqual({ kind: "unknown" });
  });
});

describe("revertCode (SPEC §6.3)", () => {
  test.each([
    // @uniswap TransferHelper.sol:21,35,49
    ["STF", "contract-revert"],
    ["ST", "contract-revert"],
    ["SA", "contract-revert"],
    // Fiat24Token.sol:423
    ["Fiat24Token: Transfer not allowed for various reason", "transfer-not-allowed"],
    // Fiat24Token.sol:133,141
    ["Fiat24Token: amount < minimal payout amount", "below-minimum"],
    // Fiat24Token.sol:157-158,420-421 (both capitalisations)
    ["Fiat24Token: All account transfers are paused", "unavailable"],
    ["Fiat24Token: All account transfers of this currency are paused", "unavailable"],
    ["Fiat24Token: all account transfers are paused", "unavailable"],
    ["Fiat24Token: all account transfers of this currency are paused", "unavailable"],
    // Fiat24Token.sol:162,164
    ["Fiat24Token: Transfer to sanctioned address", "transfer-not-allowed"],
    ["Fiat24Token: Transfer from sanctioned address", "transfer-not-allowed"],
    // OZ ERC20(Upgradeable).sol
    ["ERC20: transfer amount exceeds balance", "insufficient-balance"],
    ["ERC20: burn amount exceeds balance", "insufficient-balance"],
    // Fiat24Token.sol:83, OZ ERC20Burnable.sol
    ["ERC20: transfer amount exceeds allowance", "insufficient-allowance"],
    ["ERC20: burn amount exceeds allowance", "insufficient-allowance"],
    // OZ ERC721(Upgradeable).sol
    ["ERC721: owner query for nonexistent token", "no-account"],
    ["ERC721: token already minted", "account-id-taken"],
    // OZ ERC721EnumerableUpgradeable.sol:47
    ["ERC721Enumerable: owner index out of bounds", "no-account"],
    // Fiat24Account.sol:412
    ["Account transfers suspended", "unavailable"],
    // Fiat24Account.sol:121
    ["Not allowed. The address has/had another NFT.", "address-ineligible"],
    // Fiat24Account.sol:118
    ["F24 is inactive", "unavailable"],
    // Fiat24Account.sol:120,119
    ["Number of digits of accountId > max. digits", "invalid-account-id"],
    ["9xx cannot be mint by client", "invalid-account-id"],
    // Fiat24Account.sol:108
    ["Not sufficient msg.value for F24 purchase", "quote-changed"],
    // anything else
    ["Not an operator", "contract-revert"],
    ["mint not allowed", "contract-revert"],
    ["some unknown reason", "contract-revert"],
  ] as Array<[string, Fiat24ErrorCode]>)("maps %j to %s", (reason, expected) => {
    const payload = errorString(reason);
    expect(decodeFiat24Revert(payload)).toStrictEqual({ kind: "error", reason });
    expect(revertCode(decodeFiat24Revert(payload))).toBe(expected);
  });

  test.each([
    // Fiat24CryptoDeposit.sol:21, F24Sales.sol:12
    ["Fiat24CryptoDeposit__Paused", [], "unavailable"],
    ["F24Sales__Paused", [], "unavailable"],
    // F24Sales.sol:14,15
    ["F24Sales__NotEnoughF24", [1n, 2n], "unavailable"],
    ["F24Sales__F24AmountTooSmall", [1n, A], "below-minimum"],
    // Fiat24CryptoDeposit.sol:26,30,29
    ["Fiat24CryptoDeposit__ValueZero", [], "below-minimum"],
    ["Fiat24CryptoDeposit__UsdcAmountLowerMinDepositAmount", [1n, 2n], "below-minimum"],
    ["Fiat24CryptoDeposit__UsdcAmountHigherMaxDepositAmount", [1n, 2n], "above-maximum"],
    // Fiat24CryptoDeposit.sol:25
    ["Fiat24CryptoDeposit__AddressHasNoToken", [A], "no-account"],
    // Fiat24CryptoDeposit.sol:23,22,24
    ["Fiat24CryptoDeposit__NotValidInputToken", [A], "unsupported-currency"],
    ["Fiat24CryptoDeposit__NotValidOutputToken", [A], "unsupported-currency"],
    ["Fiat24CryptoDeposit__InputTokenOutputTokenSame", [A, A], "unsupported-currency"],
    // unmapped custom errors stay contract-revert
    ["F24Sales__MsgValueZero", [5n], "contract-revert"],
    ["F24Sales__NotAuthorizer", [A], "contract-revert"],
    ["Fiat24CryptoDeposit__EthRefundFailed", [], "contract-revert"],
    ["Fiat24CardAuthorizationMarqeta__Suspended", [], "contract-revert"],
  ] as Array<[string, ReadonlyArray<unknown>, Fiat24ErrorCode]>)(
    "maps %s to %s",
    (errorName, args, expected) => {
      const payload = custom(errorName, args);
      expect(decodeFiat24Revert(payload)).toStrictEqual({ kind: "custom", name: errorName });
      expect(revertCode(decodeFiat24Revert(payload))).toBe(expected);
    },
  );

  test("panic and unknown map to contract-revert", () => {
    expect(revertCode(decodeFiat24Revert(panic(0x11n)))).toBe("contract-revert");
    expect(revertCode(decodeFiat24Revert("0xdeadbeef"))).toBe("contract-revert");
    expect(revertCode({ kind: "unknown" })).toBe("contract-revert");
    expect(revertCode({ kind: "panic", code: 1n })).toBe("contract-revert");
  });

  test("an arbitrary reason string cannot read a prototype property", () => {
    for (const reason of ["constructor", "hasOwnProperty", "toString", "__proto__"]) {
      expect(revertCode(decodeFiat24Revert(errorString(reason)))).toBe("contract-revert");
    }
  });
});
