import { createServer } from "node:http";
import type { Server } from "node:http";

import { describe, expect, test } from "vite-plus/test";

import { API_BASE_URL, createFiat24Api, sessionLabel } from "../../src/api/index.ts";
import type { Fiat24Error } from "../../src/core/index.ts";
import { isFiat24Error } from "../../src/core/index.ts";
import {
  caught,
  caughtCode,
  expectApiError,
  clock,
  fixtureBody,
  fixtureText,
  json,
  stubFetch,
  testSigner,
  timestampRoute,
} from "./stub.ts";

const TOKEN_ID = 690333n;
const SERVER_MS = 1_795_328_524_822;

const MIB = 1024 * 1024;
const CHUNK = 64 * 1024;

/** A pull-based stream of `total` zero bytes in 64 KiB chunks, reporting pulls and cancel(). */
function countingStream(total: number): {
  stream: ReadableStream<Uint8Array>;
  counter: { pulled: number; cancelled: boolean };
} {
  const counter = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(CHUNK).fill(48);
  let served = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (served < total) {
        served += CHUNK;
        counter.pulled += CHUNK;
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
    cancel() {
      counter.cancelled = true;
    },
  });
  return { stream, counter };
}

/** A pull-based stream serving `bytes` in `chunkSize` slices. */
function streamOf(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const slice = bytes.subarray(offset, offset + chunkSize);
      offset += slice.byteLength;
      controller.enqueue(slice);
    },
  });
}

function publicApi(routes: Record<string, ReturnType<typeof json>>) {
  const stub = stubFetch(routes);
  const api = createFiat24Api({ fetch: stub.fetch, now: clock(SERVER_MS).now });
  return { api, calls: stub.calls };
}

// A session plus the routes its grant mint needs (`/timestamp` only; each test adds the rest).
function sessionApi(routes: Record<string, ReturnType<typeof json>>) {
  const stub = stubFetch({ "/timestamp": timestampRoute(SERVER_MS), ...routes });
  const signer = testSigner();
  const clk = clock(SERVER_MS);
  const api = createFiat24Api({ fetch: stub.fetch, now: clk.now });
  const session = api.openSession({ tokenId: TOKEN_ID, signer });
  return { api, session, signer, clock: clk, calls: stub.calls };
}

function headersOf(calls: ReadonlyArray<{ url: string; init: RequestInit }>, index: number) {
  const init = calls[index]?.init;
  expect(init).toBeDefined();
  return (init?.headers ?? {}) as Record<string, string>;
}

describe("api transport", () => {
  test("no-store header on every request", async () => {
    const { session, calls } = sessionApi({
      "/br": json(fixtureBody("secured/br.json")),
      "/card": json(fixtureBody("secured/write-ok.json")),
    });
    await session.profile();
    await session.createCard();
    const pub = publicApi({ "/countries": json(fixtureBody("public/countries.json")) });
    await pub.api.countries();
    for (const call of [...calls, ...pub.calls]) {
      const headers = headersOf([call], 0);
      expect(headers["cache-control"]).toBe("no-store");
      expect(headers["network"]).toBe("42161");
      expect("cache" in call.init).toBe(false);
    }
  });

  test("secured headers carry the grant", async () => {
    const { session, calls } = sessionApi({
      "/br": json(fixtureBody("secured/br.json")),
    });
    await session.profile();
    const headers = headersOf(calls, 1); // calls[0] is the public /timestamp
    const deadline = BigInt(Math.trunc(SERVER_MS / 1000) + 600);
    expect(headers["tokenid"]).toBe("690333");
    expect(headers["deadline"]).toBe(deadline.toString());
    expect(headers["hash"]).toBe(sessionLabel({ chainId: 42161, tokenId: TOKEN_ID, deadline }));
    expect(headers["sign"]).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(headersOf(calls, 0)["tokenid"]).toBeUndefined();
  });

  test("content-type only on writes", async () => {
    const { session, calls } = sessionApi({
      "/br": json(fixtureBody("secured/br.json")),
      "/card": json(fixtureBody("secured/write-ok.json")),
      "/card-currency": json(fixtureBody("secured/write-ok.json")),
    });
    await session.profile();
    await session.createCard();
    await session.setCardCurrency({ externalId: "123456", currency: "EUR" });
    expect(headersOf(calls, 1)["content-type"]).toBeUndefined();
    expect(headersOf(calls, 2)["content-type"]).toBe("application/json");
    expect(headersOf(calls, 3)["content-type"]).toBe("application/json");
  });

  test("exact URLs for every endpoint", async () => {
    const { session, calls } = sessionApi({
      "/br": json(fixtureBody("secured/br.json")),
      "/cards": json(fixtureBody("secured/cards-ok.json")),
      "/transactions?currency=EUR": json(fixtureBody("secured/transactions.json")),
      "/card": json(fixtureBody("secured/write-ok.json")),
      "/card-status": json(fixtureBody("secured/write-ok.json")),
      "/card-currency": json(fixtureBody("secured/write-ok.json")),
      "/card-device-token": json(fixtureBody("secured/write-ok.json")),
    });
    const pub = publicApi({
      "/countries": json(fixtureBody("public/countries.json")),
      "/rates": json(fixtureBody("public/rates.json")),
      "/payment-purposes": json(fixtureBody("public/payment-purposes.json")),
      "/banks": json(fixtureBody("public/banks.json")),
      "/banks/iban/CH9300762011623852957": json(fixtureBody("secured/banks-iban-ok.json")),
      "/country-cities": json(fixtureBody("public/country-cities.json")),
      "/status-kyc?id=9102": json(fixtureBody("public/status-kyc-9102.json")),
    });
    await pub.api.countries();
    await pub.api.rates();
    await pub.api.paymentPurposes();
    await pub.api.banks();
    await pub.api.bankByIban("ch93 0076 2011 6238 52957");
    await pub.api.countryCities();
    await pub.api.kycStatus(9102n);
    await session.profile();
    await session.cards();
    await session.transactions({ currency: "EUR" });
    await session.createCard();
    await session.setCardStatus({ externalId: "123456", status: "block" });
    await session.setCardCurrency({ externalId: "123456", currency: "EUR" });
    await session.setDeviceToken({
      externalId: "123456",
      cardTokenId: "active_token_id",
      status: "deactivate",
    });
    const urls = [...pub.calls, ...calls].map((call) => call.url);
    expect(urls).toStrictEqual([
      `${API_BASE_URL}/countries`,
      `${API_BASE_URL}/rates`,
      `${API_BASE_URL}/payment-purposes`,
      `${API_BASE_URL}/banks`,
      `${API_BASE_URL}/banks/iban/CH9300762011623852957`,
      `${API_BASE_URL}/country-cities`,
      `${API_BASE_URL}/status-kyc?id=9102`,
      `${API_BASE_URL}/timestamp`,
      `${API_BASE_URL}/br`,
      `${API_BASE_URL}/cards`,
      `${API_BASE_URL}/transactions?currency=EUR`,
      `${API_BASE_URL}/card`,
      `${API_BASE_URL}/card-status`,
      `${API_BASE_URL}/card-currency`,
      `${API_BASE_URL}/card-device-token`,
    ]);
  });

  test("fetch throws => network-error", async () => {
    expect.hasAssertions();
    const stub = stubFetch({
      "/timestamp": () => {
        throw new Error("socket reset");
      },
    });
    const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
    await expectApiError(async () => api.timestamp(), "network-error", "GET /timestamp");
  });

  test("fetch missing => network-error", async () => {
    expect.hasAssertions();
    const saved: unknown = globalThis.fetch;
    try {
      // @ts-expect-error deliberate removal for the missing-fetch path
      delete globalThis.fetch;
      const api = createFiat24Api({ now: () => SERVER_MS });
      await expectApiError(async () => api.timestamp(), "network-error", "GET /timestamp");
    } finally {
      globalThis.fetch = saved as typeof fetch;
    }
  });

  test("call-time globalThis.fetch lookup", async () => {
    const api = createFiat24Api({ now: () => SERVER_MS });
    const stub = stubFetch({ "/timestamp": timestampRoute(SERVER_MS) });
    const saved: unknown = globalThis.fetch;
    try {
      globalThis.fetch = stub.fetch;
      await expect(api.timestamp()).resolves.toBe(BigInt(SERVER_MS));
      expect(stub.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = saved as typeof fetch;
    }
  });

  test("abort => network-error", async () => {
    expect.hasAssertions();
    const stub = stubFetch({
      "/timestamp": async () => Promise.reject(new DOMException("aborted", "AbortError")),
    });
    const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
    await expectApiError(async () => api.timestamp(), "network-error", "GET /timestamp");
  });

  test("text() throws => network-error", async () => {
    expect.hasAssertions();
    const stub = stubFetch({
      "/timestamp": () => {
        const response = new Response("{}", { status: 200 });
        // `body: null` routes the read through text() (the no-stream fallback).
        Object.defineProperty(response, "body", { value: null });
        Object.defineProperty(response, "text", {
          value: async () => Promise.reject(new Error("stream failed")),
        });
        return response;
      },
    });
    const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
    await expectApiError(async () => api.timestamp(), "network-error", "GET /timestamp");
  });

  test("a failing stream reader => network-error", async () => {
    expect.hasAssertions();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("stream failed");
      },
    });
    const fetchFn = (async (): Promise<Response> =>
      Promise.resolve(
        new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
      )) as typeof fetch;
    const api = createFiat24Api({ fetch: fetchFn, now: () => SERVER_MS });
    await expectApiError(async () => api.timestamp(), "network-error", "GET /timestamp");
  });

  test("401 => unauthorized", async () => {
    expect.hasAssertions();
    const { api } = publicApi({
      "/timestamp": json(fixtureText("public/br-noauth.txt"), 401),
    });
    await expectApiError(async () => api.timestamp(), "unauthorized", "GET /timestamp", 401);
  });

  test("429 => rate-limited", async () => {
    expect.hasAssertions();
    const { api } = publicApi({ "/timestamp": json("{}", 429) });
    await expectApiError(async () => api.timestamp(), "rate-limited", "GET /timestamp", 429);
  });

  test("public 500 => rate-limited, secured 500 => http-error", async () => {
    expect.hasAssertions();
    const { api } = publicApi({ "/timestamp": json("{}", 500) });
    await expectApiError(async () => api.timestamp(), "rate-limited", "GET /timestamp", 500);
    const { session } = sessionApi({ "/br": json("{}", 500) });
    await expectApiError(async () => session.profile(), "http-error", "GET /br", 500);
  });

  test("403 WAF and 404 => http-error", async () => {
    expect.hasAssertions();
    const { api } = publicApi({ "/timestamp": json("{}", 403) });
    await expectApiError(async () => api.timestamp(), "http-error", "GET /timestamp", 403);
    const other = publicApi({ "/timestamp": json("{}", 404) });
    await expectApiError(async () => other.api.timestamp(), "http-error", "GET /timestamp", 404);
  });

  test("{error} body => api-rejected", async () => {
    expect.hasAssertions();
    const { api } = publicApi({
      "/banks/iban/CH8183051000000010365": json(fixtureBody("public/banks-iban-bad.json")),
    });
    await expectApiError(
      async () => api.bankByIban("CH8183051000000010365"),
      "api-rejected",
      "GET /banks/iban/{iban}",
      200,
    );
  });

  test("{status:404,data} => api-rejected with body status", async () => {
    expect.hasAssertions();
    const { session } = sessionApi({ "/br": json('{"status":404,"data":"x"}') });
    await expectApiError(async () => session.profile(), "api-rejected", "GET /br", 404);
  });

  test("non-JSON and trailing garbage => invalid-response", async () => {
    expect.hasAssertions();
    const { api } = publicApi({ "/timestamp": json("Unauthorized") });
    await expectApiError(async () => api.timestamp(), "invalid-response", "GET /timestamp");
    const other = publicApi({ "/timestamp": json(fixtureBody("secured/trailing-garbage.json")) });
    await expectApiError(async () => other.api.timestamp(), "invalid-response", "GET /timestamp");
  });

  test("content-length over cap => invalid-response and the body is never read", async () => {
    let bodyRead = false;
    const stub = stubFetch({
      "/timestamp": () => {
        const response = new Response("{}", {
          status: 200,
          headers: { "content-length": "2097152" },
        });
        Object.defineProperty(response, "body", {
          value: {
            getReader: () => {
              bodyRead = true;
              throw new Error("read attempted");
            },
          },
        });
        Object.defineProperty(response, "text", {
          value: async () => {
            bodyRead = true;
            return Promise.resolve("{}");
          },
        });
        return response;
      },
    });
    const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
    await expectApiError(async () => api.timestamp(), "invalid-response", "GET /timestamp");
    expect(bodyRead).toBe(false);
  });

  test("2 MiB body => invalid-response", async () => {
    expect.hasAssertions();
    const { api } = publicApi({ "/timestamp": json(`{"x":"${"a".repeat(2 * 1024 * 1024)}"}`) });
    await expectApiError(async () => api.timestamp(), "invalid-response", "GET /timestamp");
  });

  test("400 000 three-byte characters exceed the byte cap", async () => {
    expect.hasAssertions();
    // 400 000 UTF-16 units but 1.2 MB UTF-8 — the cap counts bytes, not chars.
    const { api } = publicApi({ "/timestamp": json(`{"x":"${"€".repeat(400_000)}"}`) });
    await expectApiError(async () => api.timestamp(), "invalid-response", "GET /timestamp");
  });

  test("byte cap counts UTF-8 bytes, not UTF-16 units", async () => {
    expect.hasAssertions();
    // A valid body under the cap in UTF-16 units but over it in UTF-8 bytes must still be
    // refused before it is parsed.
    const body = `{"timestamp":${SERVER_MS},"x":"${"€".repeat(400_000)}"}`;
    const { api } = publicApi({ "/timestamp": json(body) });
    await expectApiError(async () => api.timestamp(), "invalid-response", "GET /timestamp");
  });

  test("/banks accepts a 2 MiB body and refuses 9 MiB", async () => {
    const entry = { name: "a".repeat(1000), bic: "ZKBKCHZZXXX", country: "CH", bankCode: "00700" };
    const entries = Array.from({ length: 2100 }, () => JSON.stringify(entry)).join(",");
    const big = `{"lastUpdateAt":1,"banks":{"CH":[${entries}]}}`;
    expect(new TextEncoder().encode(big).length).toBeGreaterThan(2 * 1024 * 1024);
    const { api } = publicApi({ "/banks": json(big) });
    await expect(api.banks()).resolves.toBeDefined();
    const huge = `{"lastUpdateAt":1,"banks":{"CH":[${Array.from({ length: 9500 }, () => JSON.stringify(entry)).join(",")}]}}`;
    expect(new TextEncoder().encode(huge).length).toBeGreaterThan(8 * 1024 * 1024);
    const other = publicApi({ "/banks": json(huge) });
    await expectApiError(async () => other.api.banks(), "invalid-response", "GET /banks");
  });

  test("unsafe integer in the body => invalid-response", async () => {
    expect.hasAssertions();
    const { api } = publicApi({ "/timestamp": json(fixtureBody("secured/unsafe-int.json")) });
    await expectApiError(async () => api.timestamp(), "invalid-response", "GET /timestamp");
  });

  test("every request is sent with redirect: error", async () => {
    const { session, calls } = sessionApi({
      "/br": json(fixtureBody("secured/br.json")),
      "/card": json(fixtureBody("secured/write-ok.json")),
      "/card-currency": json(fixtureBody("secured/write-ok.json")),
    });
    await session.profile();
    await session.createCard();
    await session.setCardCurrency({ externalId: "123456", currency: "EUR" });
    const pub = publicApi({ "/countries": json(fixtureBody("public/countries.json")) });
    await pub.api.countries();
    for (const call of [...calls, ...pub.calls]) {
      expect(call.init.redirect).toBe("error");
    }
  });

  // A spec fetch rejects on redirect (network-error); these cases cover an injected fetch that
  // ignores `redirect: "error"` — a 3xx status, a followed redirect (`redirected`), or a
  // resolved `url` other than the request's.
  test.each([
    {
      name: "302 status",
      make: () =>
        new Response("{}", { status: 302, headers: { location: "https://evil.example/" } }),
    },
    {
      name: "redirected: true",
      make: () => {
        const response = new Response("{}", { status: 200 });
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    },
    {
      name: "url differs from the request",
      make: () => {
        const response = new Response("{}", { status: 200 });
        Object.defineProperty(response, "url", { value: "https://evil.example/timestamp" });
        return response;
      },
    },
    {
      name: "url on a lookalike origin",
      make: () => {
        const response = new Response("{}", { status: 200 });
        Object.defineProperty(response, "url", {
          value: "https://api.fiat24.com.evil.example/timestamp",
        });
        return response;
      },
    },
  ])(
    "a redirect-shaped response ($name) is invalid-response and the body is never read",
    async ({ make }) => {
      let bodyRead = false;
      const stub = stubFetch({
        "/timestamp": () => {
          const response = make();
          // `body: null` routes the read through `text()` under either body strategy.
          Object.defineProperty(response, "body", { value: null });
          Object.defineProperty(response, "text", {
            value: async () => {
              bodyRead = true;
              return Promise.resolve("{}");
            },
          });
          return response;
        },
      });
      const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
      await expectApiError(async () => api.timestamp(), "invalid-response", "GET /timestamp");
      expect(bodyRead, "the body was read").toBe(false);
    },
  );

  test("a same-origin response.url rewritten by URL parsing is accepted", async () => {
    // An injected WHATWG fetch reports the resolved url after parsing, which percent-encodes
    // characters our request path keeps literal — `'` in /verify?sp= becomes %27 — without any
    // redirect having happened.
    const request = {
      account: "LI7830174502999200012",
      bankName: "D'Angelo SA",
      bic: "SAHHCHZ2",
      purpose: 2n,
      creditor: "BR" as const,
    };
    const path = `/verify?sp=${encodeURIComponent(
      JSON.stringify({
        account: request.account,
        bankName: request.bankName,
        bic: request.bic,
        purpose: 2,
        creditor: "BR",
      }),
    )}`;
    const stub = stubFetch({
      "/timestamp": timestampRoute(SERVER_MS),
      [path]: json(fixtureBody("secured/verify-sp.json")),
    });
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const response = await stub.fetch(input as never, init);
      Object.defineProperty(response, "url", { value: new URL(String(input)).href });
      return response;
    }) as typeof fetch;
    const api = createFiat24Api({ fetch: fetchFn, now: () => SERVER_MS });
    const session = api.openSession({ tokenId: TOKEN_ID, signer: testSigner() });
    const verified = await session.verifyBankPayment(request);
    expect(verified.contactId).toBe("EA-123456");
    // Premise: the resolved url really differed from the literal request string.
    const requested = String(stub.calls[1]?.url);
    expect(requested).toContain("'");
    expect(new URL(requested).href).not.toBe(requested);
  });

  test("error detail never carries the concrete path or query", async () => {
    const { api } = publicApi({ "/status-kyc?id=9102": json("{}", 500) });
    const error = await caught(async () => api.kycStatus(9102n));
    expect(isFiat24Error(error)).toBe(true);
    const fiat24Error = error as Fiat24Error;
    expect(fiat24Error.message).toBe("GET /status-kyc failed");
    expect(JSON.stringify(fiat24Error.detail)).not.toContain("9102");
    expect(JSON.stringify(fiat24Error.detail)).not.toContain("?id=");
  });
});

describe("redirected answers (R-02)", () => {
  async function listen(server: Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  }

  // Server A answers /timestamp then `code` for the write with Location at server B, which
  // records every request that reaches it. A spec fetch rejects with `redirect: "error"` (an
  // opaque TypeError the SDK cannot tell from any other rejection => network-error); a fetch
  // that resolves the 3xx hits the response-side check (=> invalid-response).
  async function redirectPair(code: number): Promise<{
    portA: number;
    receivedB: string[];
    close: () => Promise<void>;
  }> {
    const receivedB: string[] = [];
    const serverB = createServer((req, res) => {
      receivedB.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const portB = await listen(serverB);
    const serverA = createServer((req, res) => {
      if (req.url === "/timestamp") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ timestamp: SERVER_MS }));
        return;
      }
      res.writeHead(code, { location: `http://127.0.0.1:${portB}/card` });
      res.end();
    });
    const portA = await listen(serverA);
    const close = async (): Promise<void> => {
      await new Promise((resolve) => {
        serverA.close(resolve);
      });
      await new Promise((resolve) => {
        serverB.close(resolve);
      });
    };
    return { portA, receivedB, close };
  }

  test.each([307, 308])(
    "a POST answered %i forwards no grant headers to the redirect target",
    async (code) => {
      const pair = await redirectPair(code);
      try {
        // The real fetch with only the base URL rewritten; init is passed through unchanged.
        const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
          const url = String(input).replace(API_BASE_URL, `http://127.0.0.1:${pair.portA}`);
          return globalThis.fetch(url, init);
        }) as typeof fetch;
        const api = createFiat24Api({ fetch: fetchFn, now: () => SERVER_MS });
        const session = api.openSession({ tokenId: TOKEN_ID, signer: testSigner() });
        const outcome = await caughtCode(async () => session.createCard());
        expect(["network-error", "invalid-response"]).toContain(outcome);
        expect(pair.receivedB).toStrictEqual([]);
      } finally {
        await pair.close();
      }
    },
  );
});

describe("response body cap (R-03)", () => {
  test("a 16 MiB stream without content-length is cut at the 1 MiB cap while reading", async () => {
    const { stream, counter } = countingStream(16 * MIB);
    const fetchFn = (async (): Promise<Response> =>
      Promise.resolve(
        new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
      )) as typeof fetch;
    const api = createFiat24Api({ fetch: fetchFn, now: () => SERVER_MS });
    await expectApiError(async () => api.countries(), "invalid-response", "GET /countries");
    // At most the cap plus the in-flight pull is served; buffered-before-cap would pull all 16.
    expect(counter.pulled).toBeLessThanOrEqual(MIB + 2 * CHUNK);
    expect(counter.cancelled).toBe(true);
  });

  test("/banks is cut at the 8 MiB cap while reading", async () => {
    const { stream, counter } = countingStream(16 * MIB);
    const fetchFn = (async (): Promise<Response> =>
      Promise.resolve(
        new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
      )) as typeof fetch;
    const api = createFiat24Api({ fetch: fetchFn, now: () => SERVER_MS });
    await expectApiError(async () => api.banks(), "invalid-response", "GET /banks");
    expect(counter.pulled).toBeLessThanOrEqual(8 * MIB + 2 * CHUNK);
    expect(counter.cancelled).toBe(true);
  });

  test("a streamed body exactly at the cap succeeds", async () => {
    const prefix = `{"timestamp":${SERVER_MS},"pad":"`;
    const body = `${prefix}${"a".repeat(MIB - prefix.length - 2)}"}`;
    expect(body).toHaveLength(MIB);
    const bytes = new TextEncoder().encode(body);
    const fetchFn = (async (): Promise<Response> =>
      Promise.resolve(
        new Response(streamOf(bytes, CHUNK), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch;
    const api = createFiat24Api({ fetch: fetchFn, now: () => SERVER_MS });
    await expect(api.timestamp()).resolves.toBe(BigInt(SERVER_MS));
  });

  test("a response without a stream still applies the cap after text()", async () => {
    expect.hasAssertions();
    // The whatwg-fetch (React Native) shape: `body` is null and only text() exists — the body is
    // buffered by fetch and the cap applies to the decoded string.
    const stub = stubFetch({
      "/timestamp": () =>
        ({
          status: 200,
          type: "basic",
          redirected: false,
          url: "",
          headers: new Headers({ "content-type": "application/json" }),
          body: null,
          text: async () => Promise.resolve(`{"x":"${"a".repeat(2 * MIB)}"}`),
        }) as unknown as Response,
    });
    const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
    await expectApiError(async () => api.timestamp(), "invalid-response", "GET /timestamp");
  });
});
