import { describe, expect, it } from "vite-plus/test";

import { API_BASE_URL } from "../../packages/fiat24/src/api/http.ts";
import { createSecured } from "../../packages/fiat24/src/api/secured.ts";
import type { SessionCore, SessionHeaders } from "../../packages/fiat24/src/api/session.ts";
import { Fiat24Error } from "../../packages/fiat24/src/core/errors.ts";
import { DOC_QR } from "../../packages/fiat24/tests/api/stub.ts";
import { guardFetch } from "./guard.ts";

const SESSION: SessionHeaders = {
  tokenid: "690333",
  hash: "fiat24-session-v1:42161:690333:1795328524;",
  deadline: "1795328524",
  sign: `0x${"ab".repeat(65)}`,
};

const SECURED_HEADERS = { network: "42161", "cache-control": "no-store", ...SESSION };

const PUBLIC_INIT: RequestInit = {
  method: "GET",
  headers: { network: "42161", "cache-control": "no-store" },
  redirect: "error",
};

const SECURED_INIT: RequestInit = {
  method: "GET",
  headers: SECURED_HEADERS,
  redirect: "error",
};

const url = (path: string): string => `${API_BASE_URL}${path}`;

function spy(): { inner: typeof fetch; calls: number[] } {
  const calls: number[] = [];
  const inner = (async () => {
    calls.push(1);
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  return { inner, calls };
}

const refused = async (
  guarded: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<string> => {
  try {
    await guarded(input, init);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
};

describe("guardFetch", () => {
  it("passes the four allowed GETs through", async () => {
    const { inner, calls } = spy();
    const guarded = guardFetch(inner);
    await guarded(url("/timestamp"), PUBLIC_INIT);
    await guarded(url("/br"), SECURED_INIT);
    await guarded(url("/cards"), SECURED_INIT);
    await guarded(url("/transactions?currency=ALL&recordscount=100"), SECURED_INIT);
    expect(calls).toHaveLength(4);
  });

  const refusalCases: ReadonlyArray<
    [string, Parameters<typeof fetch>[0], RequestInit | undefined]
  > = [
    ["POST /card", url("/card"), { ...SECURED_INIT, method: "POST", body: "{}" }],
    ["POST /card-status", url("/card-status"), { ...SECURED_INIT, method: "POST", body: "{}" }],
    ["PUT /card-currency", url("/card-currency"), { ...SECURED_INIT, method: "PUT", body: "{}" }],
    [
      "POST /card-device-token",
      url("/card-device-token"),
      { ...SECURED_INIT, method: "POST", body: "{}" },
    ],
    ["PUT /email", url("/email"), { ...SECURED_INIT, method: "PUT", body: "{}" }],
    ["GET /verify?sp=…", url("/verify?sp=%7B%7D"), SECURED_INIT],
    ["GET /verify?qr=…", url("/verify?qr=SPC"), SECURED_INIT],
    ["GET /status-kyc?id=1", url("/status-kyc?id=1"), PUBLIC_INIT],
    ["GET /br with body", url("/br"), { ...SECURED_INIT, body: "{}" }],
    ["lowercase get", url("/br"), { ...SECURED_INIT, method: "get" }],
    ["missing method", url("/br"), { headers: SECURED_HEADERS, redirect: "error" }],
    ["missing init", url("/br"), undefined],
    ["lookalike origin", "https://api.fiat24.com.evil.io/br", SECURED_INIT],
    ["plain http", "http://api.fiat24.com/br", SECURED_INIT],
    ["userinfo", "https://user:pass@api.fiat24.com/br", SECURED_INIT],
    ["query on /br", url("/br?x=1"), SECURED_INIT],
    ["dot segments", url("/br/../verify"), SECURED_INIT],
    ["recordscount=5000", url("/transactions?currency=ALL&recordscount=5000"), SECURED_INIT],
    ["extra query param", url("/transactions?currency=ALL&recordscount=100&x=1"), SECURED_INIT],
    ["missing recordscount", url("/transactions?currency=ALL"), SECURED_INIT],
    [
      "session headers on /timestamp",
      url("/timestamp"),
      {
        method: "GET",
        headers: { network: "42161", "cache-control": "no-store", ...SESSION },
        redirect: "error",
      },
    ],
    [
      "missing session header on /br",
      url("/br"),
      {
        method: "GET",
        headers: { network: "42161", "cache-control": "no-store", tokenid: "690333" },
        redirect: "error",
      },
    ],
    [
      "extra header",
      url("/br"),
      {
        method: "GET",
        headers: { ...SECURED_HEADERS, authorization: "x" },
        redirect: "error",
      },
    ],
    ["redirect follow", url("/br"), { ...SECURED_INIT, redirect: "follow" }],
    ["missing redirect", url("/br"), { method: "GET", headers: SECURED_HEADERS }],
    ["Request object", new Request(url("/br"), SECURED_INIT), undefined],
    ["URL object", new URL(url("/br")), SECURED_INIT],
  ];

  it.each(refusalCases)("refuses %s without calling inner", async (_name, input, init) => {
    const { inner, calls } = spy();
    const message = await refused(guardFetch(inner), input, init);
    expect(message).toContain("live-verify transport guard");
    expect(calls).toHaveLength(0);
    expect(message).not.toContain("/br");
    expect(message).not.toContain("/verify");
    expect(message).not.toContain("/card");
    expect(message).not.toContain("evil.io");
    expect(message).not.toContain("recordscount");
    expect(message).not.toContain("tokenid");
  });

  it("invokes onRefuse with the violation class", async () => {
    const { inner } = spy();
    const reasons: string[] = [];
    const guarded = guardFetch(inner, (reason) => {
      reasons.push(reason);
    });
    const message = await refused(guarded, url("/card"), {
      ...SECURED_INIT,
      method: "POST",
      body: "{}",
    });
    expect(message).toContain("live-verify transport guard");
    expect(reasons).toStrictEqual(["path outside the allow-list"]);
  });

  it("rejects every SDK write and /verify path while reads stay allowed", async () => {
    const { inner, calls } = spy();
    const reasons: string[] = [];
    const guarded = guardFetch(inner, (reason) => {
      reasons.push(reason);
    });
    const passThrough: SessionCore = {
      read: async (run) => run(SESSION),
      write: async (run) => run(SESSION),
      end: () => {},
    };
    const session = createSecured({ fetch: guarded, tokenId: 690333n, session: passThrough });
    const attempts: ReadonlyArray<() => Promise<unknown>> = [
      async () => session.createCard(),
      async () => session.setCardStatus({ externalId: "x", status: "block" }),
      async () => session.setCardCurrency({ externalId: "x", currency: "EUR" }),
      async () => session.setDeviceToken({ externalId: "x", cardTokenId: "y", status: "activate" }),
      async () =>
        session.verifyBankPayment({
          account: "12345",
          bankName: "x",
          bic: "TESTUS33",
          purpose: 1n,
          creditor: "BR",
        }),
      async () => session.verifySwissQr(DOC_QR),
    ];
    for (const attempt of attempts) {
      let error: unknown;
      try {
        await attempt();
      } catch (error_) {
        error = error_;
      }
      expect(error).toBeInstanceOf(Fiat24Error);
      expect((error as Fiat24Error).code).toBe("network-error");
    }
    expect(calls).toHaveLength(0);
    expect(reasons).toHaveLength(attempts.length);
    const joined = reasons.join(" ");
    expect(joined).not.toContain("/card");
    expect(joined).not.toContain("/verify");
    expect(joined).not.toContain("sp=");
    expect(joined).not.toContain("qr=");
  });
});
