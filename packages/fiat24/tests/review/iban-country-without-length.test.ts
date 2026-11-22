/**
 * R-07 — the doc's IBAN-country list (IBAN_COUNTRIES, used to gate `verifyBankPayment`) contains
 * DZ, LK, LY and TG, but `isValidIban`'s length table does not — so every input from those
 * countries fails validation and a valid DZ IBAN is refused `invalid-argument` before any I/O. This
 * test asserts the current defective behaviour; it is expected to fail once the finding is fixed.
 */
import { describe, expect, test } from "vite-plus/test";

import { createFiat24Api } from "../../src/api/index.ts";
import { isValidIban } from "../../src/core/index.ts";
import { expectCode, json, stubFetch, testSigner } from "../api/stub.ts";

const SERVER_MS = 1_795_328_524_822;

describe("IBAN countries missing from the length table (R-07)", () => {
  test("isValidIban rejects every DZ/LK/LY/TG input", () => {
    // Shape-valid inputs whose ISO 7064 mod-97 check holds: refused only because the country has
    // no entry in the length table.
    expect(isValidIban("DZ3500400174401001000136")).toBe(false);
    expect(isValidIban("LK3600001234567890123456")).toBe(false);
    expect(isValidIban("LY84002048000000001234567")).toBe(false);
    expect(isValidIban("TG7300001234567890123456")).toBe(false);
  });

  test("verifyBankPayment refuses a valid DZ IBAN before any fetch", async () => {
    const stub = stubFetch({
      "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
    });
    const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
    const session = api.openSession({ tokenId: 690333n, signer: testSigner() });
    await expectCode(
      async () =>
        session.verifyBankPayment({
          account: "DZ3500400174401001000136",
          bankName: "Banque Nationale d'Algerie",
          bic: "BNALDZALXXX",
          purpose: 0n,
          creditor: "BR",
        }),
      "invalid-argument",
    );
    expect(stub.calls).toHaveLength(0);
  });
});
