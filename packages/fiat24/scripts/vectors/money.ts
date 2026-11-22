import type { VectorSource } from "./lib.ts";

// SPEC §5.1 amount vectors, transcribed verbatim from the oracle rows
// produced by an independent Python `decimal` oracle — never recomputed with
// SDK code. `parse` input is the raw text; `format` input is units; every
// integer is a decimal string.
export function build(): {
  capability: string;
  source: Omit<VectorSource, "generator">;
  cases: unknown[];
} {
  return {
    capability: "core.amount",
    source: {
      kind: "spec",
      name: "SPEC §5.1 (expected values from a Python decimal oracle)",
    },
    cases: [
      { op: "parse", asset: "EUR24", input: "12.3", output: "1230" },
      { op: "parse", asset: "EUR24", input: "0.05", output: "5" },
      { op: "parse", asset: "EUR24", input: "10", output: "1000" },
      { op: "parse", asset: "EUR24", input: "01.50", output: "150" },
      { op: "parse", asset: "EUR24", input: "1.234", error: "too-many-decimals" },
      { op: "parse", asset: "EUR24", input: "1.230", error: "too-many-decimals" },
      { op: "parse", asset: "EUR24", input: "1e3", error: "invalid-amount" },
      { op: "parse", asset: "EUR24", input: "-1", error: "invalid-amount" },
      { op: "parse", asset: "EUR24", input: "", error: "invalid-amount" },
      { op: "parse", asset: "EUR24", input: " 1", error: "invalid-amount" },
      { op: "parse", asset: "EUR24", input: "1.", error: "invalid-amount" },
      { op: "parse", asset: "EUR24", input: ".5", error: "invalid-amount" },
      { op: "parse", asset: "EUR24", input: "1,5", error: "invalid-amount" },
      { op: "parse", asset: "EUR24", input: "١٢", error: "invalid-amount" },
      { op: "parse", asset: "EUR24", input: "9999999999999999.99", output: "999999999999999999" },
      { op: "parse", asset: "EUR24", input: "10000000000000000", error: "amount-out-of-range" },
      { op: "parse", asset: "USDC", input: "5", output: "5000000" },
      { op: "parse", asset: "USDC", input: "0.000001", output: "1" },
      { op: "parse", asset: "USDC", input: "1.0000001", error: "too-many-decimals" },
      { op: "parse", asset: "F24", input: "1", output: "100" },
      { op: "format", asset: "EUR24", input: "0", output: "0.00" },
      { op: "format", asset: "EUR24", input: "5", output: "0.05" },
      { op: "format", asset: "EUR24", input: "1230", output: "12.30" },
      { op: "format", asset: "USDC", input: "1", output: "0.000001" },
      { op: "format", asset: "USDC", input: "5000000", output: "5.000000" },
      { op: "format", asset: "F24", input: "100", output: "1.00" },
      { op: "format", asset: "EUR24", input: "999999999999999999", output: "9999999999999999.99" },
    ],
  };
}
