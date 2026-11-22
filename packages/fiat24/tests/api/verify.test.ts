import { describe, expect, test } from "vite-plus/test";

import { API_BASE_URL, createFiat24Api } from "../../src/api/index.ts";
import { DOC_QR, expectCode, fixtureBody, json, stubFetch, testSigner } from "./stub.ts";
import type { Route } from "./stub.ts";

const hostileBody = (fixture: string | undefined, inline: unknown): string =>
  fixture === undefined ? JSON.stringify(inline) : fixtureBody(fixture);

const TOKEN_ID = 690333n;
const SERVER_MS = 1_795_328_524_822;

const BANK_REQUEST = {
  account: "LI7830174502999200012",
  bankName: "SR Saphirstein AG",
  bic: "SAHHCHZ2",
  purpose: 2n,
  creditor: "BR" as const,
};

function sessionApi(routes: Record<string, Route>) {
  const stub = stubFetch({
    "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
    ...routes,
  });
  const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
  const session = api.openSession({ tokenId: TOKEN_ID, signer: testSigner() });
  return { api, session, calls: stub.calls };
}

// The exact /verify?sp= path the client produces for BANK_REQUEST (key order per §9.4).
function spPath(request: {
  account: string;
  bankName: string;
  bic: string;
  purpose: number;
  reference?: string;
  creditor: unknown;
}): string {
  const body: Record<string, unknown> = {
    account: request.account,
    bankName: request.bankName,
    bic: request.bic,
    purpose: request.purpose,
  };
  if (request.reference !== undefined) {
    body["reference"] = request.reference;
  }
  body["creditor"] = request.creditor;
  return `/verify?sp=${encodeURIComponent(JSON.stringify(body))}`;
}

const SP_PATH = spPath({ ...BANK_REQUEST, purpose: 2 });

describe("verifyBankPayment", () => {
  test("exact sp= URL encoding and bound result", async () => {
    const request = {
      ...BANK_REQUEST,
      reference: "21 00000 00003 13947 14300 09017",
      creditor: "BR" as const,
    };
    const path = `/verify?sp=${encodeURIComponent(
      JSON.stringify({
        account: request.account,
        bankName: request.bankName,
        bic: request.bic,
        purpose: 2,
        reference: request.reference,
        creditor: "BR",
      }),
    )}`;
    const { session, calls } = sessionApi({ [path]: json(fixtureBody("secured/verify-sp.json")) });
    const verified = await session.verifyBankPayment(request);
    expect(calls[1]?.url).toBe(`${API_BASE_URL}${path}`);
    // The 45-char NUL-padded ref comes back verbatim, padding intact.
    expect(verified).toStrictEqual({
      contactId: "EA-123456",
      purposeId: 2n,
      ref: "690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000",
    });
    expect(verified.ref).toHaveLength(45);
  });

  test("request without reference omits the key", async () => {
    const path = `/verify?sp=${encodeURIComponent(
      JSON.stringify({
        account: BANK_REQUEST.account,
        bankName: BANK_REQUEST.bankName,
        bic: BANK_REQUEST.bic,
        purpose: 2,
        creditor: "BR",
      }),
    )}`;
    const { session, calls } = sessionApi({ [path]: json(fixtureBody("secured/verify-sp.json")) });
    await session.verifyBankPayment(BANK_REQUEST);
    expect(calls[1]?.url).toBe(`${API_BASE_URL}${path}`);
    expect(calls[1]?.url).not.toContain("reference");
  });

  describe("hostile verify responses", () => {
    test.each([
      ["purposeId mismatch", "secured/verify-sp-wrong-purpose.json", undefined],
      ["contactId not a grammar", "secured/verify-sp-bad-contact.json", undefined],
      ["ref uuidv4", "secured/verify-sp-bad-ref.json", undefined],
      [
        "ref foreign prefix",
        undefined,
        {
          contactId: "EA-123456",
          purposeId: 2,
          ref: "999999-50fb0941-4f59-4a89-8735-dd78ba7d53a3",
        },
      ],
      [
        "ref NUL count",
        undefined,
        {
          contactId: "EA-123456",
          purposeId: 2,
          ref: "690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000",
        },
      ],
    ])("hostile response %s => api-mismatch", async (_name, fixture, inline) => {
      expect.hasAssertions();
      const body = hostileBody(fixture, inline);
      const { session } = sessionApi({ [SP_PATH]: json(body) });
      await expectCode(async () => session.verifyBankPayment(BANK_REQUEST), "api-mismatch");
    });
  });

  test("{error} => api-rejected, unsafe purposeId => invalid-response", async () => {
    expect.hasAssertions();
    const { session } = sessionApi({
      [SP_PATH]: json(JSON.stringify({ error: "PII-SENTINEL-90" })),
    });
    await expectCode(async () => session.verifyBankPayment(BANK_REQUEST), "api-rejected");

    const unsafe = sessionApi({
      [SP_PATH]: json('{"contactId":"EA-123456","purposeId":9007199254740993,"ref":"x"}'),
    });
    await expectCode(
      async () => unsafe.session.verifyBankPayment(BANK_REQUEST),
      "invalid-response",
    );
  });

  test.each([
    [
      "IBAN-country BIC with invalid IBAN",
      { ...BANK_REQUEST, bic: "SAHHCHZ2", account: "CH000000000000000000" },
    ],
    ["bad BIC", { ...BANK_REQUEST, bic: "sahhchz2" }],
    ["bad BIC shape", { ...BANK_REQUEST, bic: "SAHHCHZ" }],
    ["purpose over the cap", { ...BANK_REQUEST, purpose: 1_000_001n }],
    ["empty bankName", { ...BANK_REQUEST, bankName: "" }],
    ["1025-char bankName", { ...BANK_REQUEST, bankName: "a".repeat(1025) }],
  ])("invalid request %s refused before I/O", async (_name, request) => {
    const { session, calls } = sessionApi({});
    await expectCode(async () => session.verifyBankPayment(request), "invalid-argument");
    expect(calls).toHaveLength(0);
  });

  test("non-IBAN-country BIC accepts a non-IBAN account", async () => {
    const request = { ...BANK_REQUEST, bic: "CHASUS33XXX", account: "123456789" };
    const path = `/verify?sp=${encodeURIComponent(
      JSON.stringify({
        account: "123456789",
        bankName: request.bankName,
        bic: "CHASUS33XXX",
        purpose: 2,
        creditor: "BR",
      }),
    )}`;
    const { session, calls } = sessionApi({ [path]: json(fixtureBody("secured/verify-sp.json")) });
    await expect(session.verifyBankPayment(request)).resolves.toBeDefined();
    expect(calls[1]?.url).toBe(`${API_BASE_URL}${path}`);
  });
});

describe("verifySwissQr", () => {
  test("doc case 1 binds to the VerifiedQrPayout", async () => {
    const path = `/verify?qr=${encodeURIComponent(DOC_QR)}`;
    const { session, calls } = sessionApi({ [path]: json(fixtureBody("secured/verify-qr.json")) });
    const verified = await session.verifySwissQr(DOC_QR);
    expect(calls[1]?.url).toBe(`${API_BASE_URL}${path}`);
    expect(verified).toStrictEqual({
      contactId: "QRCH",
      purposeId: 101n,
      ref: "690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000",
      currency: "CHF24",
      amount: 194975n,
      account: "LI7830174502999200012",
      creditor: { name: "PII-SENTINEL-60" },
      reference: "21 00000 00003 13947 14300 09017",
    });
  });

  describe("hostile verify responses", () => {
    test.each([
      ["currency EUR24 for a CHF QR", "secured/verify-qr-wrong-currency.json"],
      ["amount 194976", "secured/verify-qr-wrong-amount.json"],
      ["contactId QRSEPA", "secured/verify-qr-wrong-contact.json"],
      ["type QRSEPA", "secured/verify-qr-wrong-type.json"],
      ["wrong ref prefix", "secured/verify-qr-wrong-ref.json"],
      ["different valid account", "secured/verify-qr-wrong-account.json"],
    ])("hostile response %s => api-mismatch", async (_name, fixture) => {
      expect.hasAssertions();
      const path = `/verify?qr=${encodeURIComponent(DOC_QR)}`;
      const { session } = sessionApi({ [path]: json(fixtureBody(fixture)) });
      await expectCode(async () => session.verifySwissQr(DOC_QR), "api-mismatch");
    });
  });

  test("fractional amount => invalid-response", async () => {
    expect.hasAssertions();
    // clientPayoutRefParams.amount must be a safe integer (§9.4); a fractional number is a
    // schema violation, not an api-mismatch.
    const body = JSON.parse(fixtureBody("secured/verify-qr.json")) as Record<string, unknown>;
    (body["clientPayoutRefParams"] as Record<string, unknown>)["amount"] = 194975.5;
    const path = `/verify?qr=${encodeURIComponent(DOC_QR)}`;
    const { session } = sessionApi({ [path]: json(JSON.stringify(body)) });
    await expectCode(async () => session.verifySwissQr(DOC_QR), "invalid-response");
  });

  test("spaced lowercase account form binds", async () => {
    const body = JSON.parse(fixtureBody("secured/verify-qr.json")) as Record<string, unknown>;
    body["account"] = "li78 3017 4502 9992 0001 2";
    const path = `/verify?qr=${encodeURIComponent(DOC_QR)}`;
    const { session } = sessionApi({ [path]: json(JSON.stringify(body)) });
    const verified = await session.verifySwissQr(DOC_QR);
    expect(verified.account).toBe("LI7830174502999200012");
  });

  test("invalid QR refused before I/O", async () => {
    const { session, calls } = sessionApi({});
    await expectCode(async () => session.verifySwissQr("SPC\r\n0100\r\n"), "invalid-argument");
    await expectCode(
      async () => session.verifySwissQr(123 as unknown as string),
      "invalid-argument",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("IBAN-country gating (R-07)", () => {
  // LY gained a registered format in SWIFT IBAN Registry Release 103; DZ, LK and TG are listed by
  // the docs but absent from the registry, so their accounts go to /verify for Fiat24 to decide.
  test("an LY BIC with the registry IBAN is accepted locally", async () => {
    const request = {
      account: "LY83002048000020100120361",
      bankName: "x",
      bic: "XXXXLYXX",
      purpose: 2n,
      creditor: "BR" as const,
    };
    const { session, calls } = sessionApi({
      [spPath({ ...request, purpose: 2 })]: json(fixtureBody("secured/verify-sp.json")),
    });
    const verified = await session.verifyBankPayment(request);
    expect(verified.purposeId).toBe(2n);
    expect(calls[1]?.url).toContain("/verify?sp=");
  });

  test.each(["DZ", "LK", "TG"])(
    "a %s BIC with a non-IBAN account reaches /verify",
    async (country) => {
      const request = {
        account: "00720012001345",
        bankName: "x",
        bic: `XXXX${country}XX`,
        purpose: 2n,
        creditor: "BR" as const,
      };
      const { session, calls } = sessionApi({
        [spPath({ ...request, purpose: 2 })]: json(fixtureBody("secured/verify-sp.json")),
      });
      await session.verifyBankPayment(request);
      expect(calls[1]?.url).toContain("/verify?sp=");
    },
  );
});
