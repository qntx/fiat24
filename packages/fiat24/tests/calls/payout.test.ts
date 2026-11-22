import { decodeFunctionData } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import {
  isValidContactId,
  isValidPayoutRef,
  payoutCall,
  PAYOUT_CURRENCIES,
  payoutRefCall,
} from "../../src/calls/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { expectError, expectFrozenCall } from "../helpers.ts";

describe("isValidContactId", () => {
  test("§6.2 grammar", () => {
    for (const ok of [
      "SP",
      "EA-00000738",
      "EA-00021246",
      "EC-0000001",
      "QRCH",
      "QRSEPA",
      "AB",
      "ABCDEFGH-1234567890123456",
    ]) {
      expect(isValidContactId(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "S",
      "ABCDEFGHI",
      "sp",
      "Ea-1",
      "EA-",
      "EA-A",
      "EA-12345678901234567",
      "EA_1",
      "A-1-B",
    ]) {
      expect(isValidContactId(bad)).toBe(false);
    }
  });
});

describe("isValidPayoutRef", () => {
  const uuid = "854ee1ef-6fc3-4009-a10e-7c3be268e52c";

  test("prefix + uuid, optional NUL fill to 45 (§6.2)", () => {
    expect(isValidPayoutRef(`109549-${uuid}`, 109549n)).toBe(true);
    expect(isValidPayoutRef(`109549-${uuid}\u0000\u0000`, 109549n)).toBe(true); // 43 + 2 NUL = 45
    expect(isValidPayoutRef(`1-${uuid}${"\u0000".repeat(7)}`, 1n)).toBe(true);
    // real on-chain ref (tx 0xbe87…dea3, 45 bytes)
    expect(
      isValidPayoutRef("690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000", 690333n),
    ).toBe(true);
  });

  test("refusals (§6.2)", () => {
    expect(isValidPayoutRef(uuid, 109549n)).toBe(false); // bare uuidv4
    expect(isValidPayoutRef(`109548-${uuid}`, 109549n)).toBe(false); // foreign prefix
    expect(isValidPayoutRef(`109549-${uuid.toUpperCase()}`, 109549n)).toBe(false); // uppercase
    // one uppercase hex char in each of the five uuid groups, in turn
    for (const upper of [
      "854eE1ef-6fc3-4009-a10e-7c3be268e52c",
      "854ee1ef-6fC3-4009-a10e-7c3be268e52c",
      "854ee1ef-6fc3-400F-a10e-7c3be268e52c",
      "854ee1ef-6fc3-4009-a10E-7c3be268e52c",
      "854ee1ef-6fc3-4009-a10e-7c3be268e52C",
    ]) {
      expect(isValidPayoutRef(`109549-${upper}`, 109549n)).toBe(false);
    }
    expect(isValidPayoutRef(`109549-${uuid} `, 109549n)).toBe(false); // len 44 with padding
    expect(isValidPayoutRef(`109549-${uuid}   `, 109549n)).toBe(false); // len 46
    expect(isValidPayoutRef(`109549-${uuid.slice(0, 35)} `, 109549n)).toBe(false); // NUL in uuid
    expect(isValidPayoutRef(`123456789-${uuid} `, 123456789n)).toBe(false); // 9-digit prefix
    expect(isValidPayoutRef(`109549-${uuid}x`, 109549n)).toBe(false); // non-NUL suffix
    expect(isValidPayoutRef(`109549-${uuid}   `, 109549n)).toBe(false); // len 46
    expect(isValidPayoutRef(`109549-${uuid}\u0000`, 109549n)).toBe(false); // len 44
    expect(isValidPayoutRef(`109549-${uuid}\u0000\u0000`, 109549n)).toBe(true); // len 45
    expect(isValidPayoutRef(`109549-${uuid}\u0000\u0000\u0000`, 109549n)).toBe(false); // len 46
    expect(isValidPayoutRef(`109549-${uuid.slice(0, 35)}\u0000`, 109549n)).toBe(false); // NUL in uuid
    expect(isValidPayoutRef(`123456789-${uuid}\u0000`, 123456789n)).toBe(false); // 9-digit prefix
    // the real on-chain ref is a string with real NUL bytes
    expect(
      isValidPayoutRef("690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000", 690333n),
    ).toBe(true);
    expect(isValidPayoutRef("690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000", 690333n)).toBe(
      false,
    ); // len 44
  });

  test("never throws on bad inputs", () => {
    expect(isValidPayoutRef(42 as never, 109549n)).toBe(false);
    expect(isValidPayoutRef(`109549-${uuid}`, 0n)).toBe(false);
    expect(isValidPayoutRef(`109549-${uuid}`, -1n)).toBe(false);
    expect(isValidPayoutRef(`109549-${uuid}`, "109549" as never)).toBe(false);
    expect(isValidPayoutRef(`109549-${uuid}`, 109549.5 as never)).toBe(false);
  });
});

describe("payoutCall", () => {
  test("PAYOUT_CURRENCIES is the frozen §6.1 pair", () => {
    expect(PAYOUT_CURRENCIES).toStrictEqual(["EUR24", "CHF24"]);
    expect(Object.isFrozen(PAYOUT_CURRENCIES)).toBe(true);
  });

  test("encodes clientPayout(amount, contactId)", () => {
    const call = payoutCall({ currency: "EUR24", amount: 5000n, contactId: "SP" });
    expect(call.to).toBe(arbitrum.tokens.EUR24.proxy);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: tokenAbi, data: call.data });
    expect(decoded.functionName).toBe("clientPayout");
    expect(decoded.args).toStrictEqual([5000n, "SP"]);
    expect(call.intent).toStrictEqual({
      kind: "payout",
      currency: "EUR24",
      amount: 5000n,
      contactId: "SP",
      payee: "off-chain",
    });
    expect(call.contracts).toStrictEqual(["EUR24", "account"]);
    expectFrozenCall(call);
  });

  test("non-payout currencies are unsupported-currency", () => {
    expect.hasAssertions();
    for (const currency of ["USD24", "CNH24"] as const) {
      expectError(
        () => payoutCall({ currency: currency as never, amount: 1n, contactId: "SP" }),
        "unsupported-currency",
      );
    }
    expectError(
      () => payoutCall({ currency: "DOGE" as never, amount: 1n, contactId: "SP" }),
      "unsupported-currency",
    );
  });

  test("invalid contactId is invalid-argument", () => {
    expect.hasAssertions();
    for (const contactId of ["sp", "A", "A-1", "ABCDEFGHI", "EA-12345678901234567"]) {
      expectError(
        () => payoutCall({ currency: "EUR24", amount: 1n, contactId }),
        "invalid-argument",
      );
    }
  });

  test("invalid amount rules apply", () => {
    expect.hasAssertions();
    expectError(
      () => payoutCall({ currency: "EUR24", amount: 0n, contactId: "SP" }),
      "invalid-amount",
    );
  });
});

describe("payoutRefCall", () => {
  const ref = "109549-854ee1ef-6fc3-4009-a10e-7c3be268e52c";

  test("encodes clientPayoutRef(amount, contactId, purposeId, ref)", () => {
    const call = payoutRefCall({
      currency: "EUR24",
      amount: 1000n,
      contactId: "SP",
      purposeId: 0n,
      ref,
      tokenId: 109549n,
    });
    expect(call.to).toBe(arbitrum.tokens.EUR24.proxy);
    const decoded = decodeFunctionData({ abi: tokenAbi, data: call.data });
    expect(decoded.functionName).toBe("clientPayoutRef");
    expect(decoded.args).toStrictEqual([1000n, "SP", 0n, ref]);
    expect(call.intent).toStrictEqual({
      kind: "payout",
      currency: "EUR24",
      amount: 1000n,
      contactId: "SP",
      purposeId: 0n,
      ref,
      payee: "off-chain",
    });
    expect(call.contracts).toStrictEqual(["EUR24", "account"]);
  });

  test("ref passes through verbatim, NULs included", () => {
    const nulRef = "690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000";
    const call = payoutRefCall({
      currency: "EUR24",
      amount: 4129n,
      contactId: "EA-00001156",
      purposeId: 8n,
      ref: nulRef,
      tokenId: 690333n,
    });
    const decoded = decodeFunctionData({ abi: tokenAbi, data: call.data });
    expect(decoded.args).toStrictEqual([4129n, "EA-00001156", 8n, nulRef]);
    expect(call.intent).toMatchObject({ ref: nulRef });
  });

  test("purposeId out of range is invalid-argument; 10^6 boundary accepted", () => {
    expect.hasAssertions();
    for (const purposeId of [1_000_001n, -1n, 2n ** 60n]) {
      expectError(
        () =>
          payoutRefCall({
            currency: "EUR24",
            amount: 1n,
            contactId: "SP",
            purposeId,
            ref,
            tokenId: 109549n,
          }),
        "invalid-argument",
      );
    }
    expect(
      payoutRefCall({
        currency: "EUR24",
        amount: 1n,
        contactId: "SP",
        purposeId: 1_000_000n,
        ref,
        tokenId: 109549n,
      }).data,
    ).toBeDefined();
  });

  test("invalid ref is invalid-argument; tokenId 0 is invalid-account-id", () => {
    expect.hasAssertions();
    expectError(
      () =>
        payoutRefCall({
          currency: "EUR24",
          amount: 1n,
          contactId: "SP",
          purposeId: 0n,
          ref: "854ee1ef-6fc3-4009-a10e-7c3be268e52c",
          tokenId: 109549n,
        }),
      "invalid-argument",
    );
    expectError(
      () =>
        payoutRefCall({
          currency: "EUR24",
          amount: 1n,
          contactId: "SP",
          purposeId: 0n,
          ref,
          tokenId: 0n,
        }),
      "invalid-account-id",
    );
  });
});
