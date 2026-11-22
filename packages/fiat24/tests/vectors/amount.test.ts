import { describe, expect, test } from "vite-plus/test";

import { fiat24ErrorCodes, formatAmount, parseAmount } from "../../src/core/index.ts";
import type { Asset } from "../../src/core/index.ts";
import { errorCodeStrings, expectError, loadVector, named } from "../helpers.ts";

const vector = loadVector("vectors/core/amount.json", "core.amount");
const { cases } = vector;

describe("vectors/core/amount.json", () => {
  test("envelope", () => {
    expect(vector.schema).toBe(1);
    expect(vector.capability).toBe("core.amount");
    expect(vector.source["kind"]).toBe("spec");
    expect(cases.length).toBeGreaterThan(0);
  });

  test("every failure code is a Fiat24ErrorCode", () => {
    expect(errorCodeStrings(cases).every((code) => fiat24ErrorCodes.some((c) => c === code))).toBe(
      true,
    );
  });

  test.each(named(cases, "parse", "ok"))("parses %s", (_title, c) => {
    expect(parseAmount(c["asset"] as Asset, String(c["input"])).toString()).toBe(c["output"]);
  });

  test.each(named(cases, "parse", "err"))("rejects %s", (_title, c) => {
    expect.hasAssertions();
    expectError(() => parseAmount(c["asset"] as Asset, String(c["input"])), c["error"]);
  });

  test.each(named(cases, "format", "ok"))("formats %s", (_title, c) => {
    expect(formatAmount(c["asset"] as Asset, BigInt(String(c["input"])))).toBe(c["output"]);
  });
});
