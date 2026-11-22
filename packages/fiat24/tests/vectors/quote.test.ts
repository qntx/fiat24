import { describe, expect, test } from "vite-plus/test";

import { mintPriceWei, quoteExchange, quoteTopUp } from "../../src/chain/index.ts";
import { loadVector, named } from "../helpers.ts";

const vector = loadVector("vectors/chain/quote.json", "chain/quote");
const { cases } = vector;

function field(c: Readonly<Record<string, unknown>>, name: string): unknown {
  const { input } = c;
  if (typeof input !== "object" || input === null || !(name in input)) {
    throw new Error(`vector case missing input.${name}`);
  }
  return (input as Record<string, unknown>)[name];
}

function bigintField(c: Readonly<Record<string, unknown>>, name: string): bigint {
  return BigInt(String(field(c, name)));
}

function sideOf(c: Readonly<Record<string, unknown>>): "exact-in" | "exact-out" {
  return field(c, "side") === "exact-out" ? "exact-out" : "exact-in";
}

describe("vectors/chain/quote.json", () => {
  test("envelope", () => {
    expect(vector.schema).toBe(1);
    expect(vector.capability).toBe("chain/quote");
    expect(vector.source["kind"]).toBe("recorded");
    expect(cases.length).toBeGreaterThan(0);
  });

  test.each(named(cases, "exchange"))("quoteExchange matches the recorded eth_call %s", (_t, c) => {
    const output = quoteExchange({
      side: sideOf(c),
      amount: bigintField(c, "amount"),
      rate: bigintField(c, "rate"),
      spread: bigintField(c, "spread"),
    });
    expect(output.toString()).toBe(c["output"]);
  });

  test.each(named(cases, "top-up"))("quoteTopUp matches the recorded eth_call %s", (_t, c) => {
    const output = quoteTopUp({
      usdcAmount: bigintField(c, "usdcAmount"),
      fee: bigintField(c, "fee"),
      usdcRate: bigintField(c, "usdcRate"),
      rate: bigintField(c, "rate"),
      spread: bigintField(c, "spread"),
    });
    expect(output.toString()).toBe(c["output"]);
  });

  test.each(named(cases, "mint"))("mintPriceWei matches the recorded msg.value %s", (_t, c) => {
    const output = mintPriceWei({
      priceF24: bigintField(c, "priceF24"),
      quotePerEther: bigintField(c, "quotePerEther"),
    });
    expect(output.toString()).toBe(c["output"]);
  });
});
