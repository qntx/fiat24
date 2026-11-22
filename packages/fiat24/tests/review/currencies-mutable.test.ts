/**
 * R-06 — `CURRENCIES` is a plain mutable array: a host that reverses it corrupts the positional
 * `getBalances` result, which then reports each token's balance under the wrong currency label.
 * This test asserts the current defective behaviour; it is expected to fail once the finding is
 * fixed.
 */
import { describe, expect, test } from "vite-plus/test";

import { getBalances } from "../../src/chain/index.ts";
import { CURRENCIES } from "../../src/core/index.ts";
import type { Currency } from "../../src/core/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import type { CallEntry } from "../chain/stub.ts";
import { B, makeStub, OWNER } from "../chain/stub.ts";

describe("CURRENCIES is mutable and corrupts getBalances (R-06)", () => {
  test("reversed CURRENCIES relabels every balance", async () => {
    expect(Object.isFrozen(CURRENCIES)).toBe(false);
    const calls = new Map<string, CallEntry[]>();
    const amounts: Record<Currency, bigint> = { USD24: 1n, EUR24: 2n, CHF24: 3n, CNH24: 4n };
    for (const currency of CURRENCIES) {
      calls.set(`${C.tokens[currency].proxy.toLowerCase()}:balanceOf`, [
        { args: [OWNER], answer: { result: amounts[currency] } },
      ]);
    }
    const stub = makeStub({ blockNumber: B, calls });
    try {
      (CURRENCIES as Currency[]).reverse();
      const { balances } = await getBalances(stub.client, { owner: OWNER });
      // Positional destructure + fixed labels: USD24 reports CNH24's balance.
      expect(balances.USD24).toBe(4n);
      expect(balances.EUR24).toBe(3n);
      expect(balances.CHF24).toBe(2n);
      expect(balances.CNH24).toBe(1n);
    } finally {
      (CURRENCIES as Currency[]).reverse();
    }
    expect(CURRENCIES).toStrictEqual(["USD24", "EUR24", "CHF24", "CNH24"]);
  });
});
