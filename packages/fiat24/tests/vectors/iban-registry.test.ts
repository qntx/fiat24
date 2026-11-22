/**
 * Vectors/core/iban-registry.json — the SWIFT IBAN Registry Release 103 electronic example for
 * every country in the local length table, plus a broken-check-digits and a truncated copy of each,
 * with schwifty 2025.6.0 as the independent oracle.
 */
import { describe, expect, test } from "vite-plus/test";

import { isValidIban } from "../../src/core/index.ts";
import { loadVector, named } from "../helpers.ts";
import type { VectorCase } from "../helpers.ts";

const vector = loadVector("vectors/core/iban-registry.json", "core.iban-registry");
const { cases } = vector;

// The expected result: schwifty's verdict, or the documented docCheck where the docs' check
// (alnum + length + mod-97) deliberately differs from schwifty's registry grammar.
function expected(c: VectorCase): boolean {
  return (c["docCheck"] ?? c["output"]) === true;
}

describe("vectors/core/iban-registry.json", () => {
  test("envelope", () => {
    expect(vector.schema).toBe(1);
    expect(vector.capability).toBe("core.iban-registry");
    expect(vector.source["kind"]).toBe("official");
    expect(vector.source["name"]).toBe("SWIFT IBAN Registry");
    expect(vector.source["version"]).toBe("Release 103 (Sep 2026)");
    expect(cases.length).toBeGreaterThan(0);
  });

  test.each(named(cases, "isValidIban"))("isValidIban %s", (_title, c) => {
    expect(isValidIban(String(c["input"]))).toBe(expected(c));
  });
});
