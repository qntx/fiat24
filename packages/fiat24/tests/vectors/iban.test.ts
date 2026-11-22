import { describe, expect, test } from "vite-plus/test";

import { fiat24ErrorCodes, ibanOf, isValidIban } from "../../src/core/index.ts";
import { errorCodeStrings, expectError, loadVector, named } from "../helpers.ts";

const vector = loadVector("vectors/core/iban.json", "core.iban");
const { cases } = vector;

describe("vectors/core/iban.json", () => {
  test("envelope", () => {
    expect(vector.schema).toBe(1);
    expect(vector.capability).toBe("core.iban");
    expect(vector.source["kind"]).toBe("recorded");
    expect(cases.length).toBeGreaterThan(0);
  });

  test("every failure code is a Fiat24ErrorCode", () => {
    expect(errorCodeStrings(cases).every((code) => fiat24ErrorCodes.some((c) => c === code))).toBe(
      true,
    );
  });

  test.each(named(cases, "ibanOf", "ok"))("ibanOf %s", (_title, c) => {
    expect(ibanOf(BigInt(String(c["id"])))).toBe(c["output"]);
  });

  test.each(named(cases, "ibanOf", "err"))("ibanOf %s refuses", (_title, c) => {
    expect.hasAssertions();
    expect(c["recorded"]).toBeTypeOf("string");
    expectError(() => ibanOf(BigInt(String(c["id"]))), c["error"]);
  });

  test.each(named(cases, "isValidIban"))("isValidIban %s", (_title, c) => {
    expect(isValidIban(String(c["input"]))).toBe(c["output"]);
  });
});
