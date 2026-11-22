import { describe, expect, test } from "vite-plus/test";

import { Fiat24Error, fiat24ErrorCodes } from "../src/core/index.ts";

describe("Fiat24Error", () => {
  test("is an Error carrying name, code and message", () => {
    const error = new Fiat24Error("invalid-argument", "bad input");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(Fiat24Error);
    expect(error.name).toBe("Fiat24Error");
    expect(error.code).toBe("invalid-argument");
    expect(error.message).toBe("bad input");
  });

  test("propagates the cause", () => {
    const cause = new Error("root");
    const error = new Fiat24Error("unknown-outcome", "undetermined", { cause });
    expect(error.cause).toBe(cause);
  });

  test("constructs with no options", () => {
    const error = new Fiat24Error("contract-changed", "drift");
    expect(error.code).toBe("contract-changed");
    expect(error.cause).toBeUndefined();
  });

  test("fiat24ErrorCodes is exactly the closed code tuple", () => {
    expect(fiat24ErrorCodes).toStrictEqual([
      "invalid-argument",
      "contract-changed",
      "unknown-outcome",
    ]);
  });
});
