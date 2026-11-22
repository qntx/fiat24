import { recoverMessageAddress } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vite-plus/test";

import { createFiat24Api, sessionLabel, sessionMessage } from "../../src/api/index.ts";
import { Fiat24Error } from "../../src/core/index.ts";
import type { Fiat24SessionGrant, Fiat24SessionSigner } from "../../src/core/index.ts";
import {
  ANVIL_KEY,
  clock,
  DOC_QR,
  expectApiError,
  expectCode,
  fixtureBody,
  json,
  stubFetch,
  testSigner,
} from "./stub.ts";
import type { Route } from "./stub.ts";

const TOKEN_ID = 690333n;
const SERVER_MS = 1_795_328_524_822;
const ANVIL_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const BANK_REQUEST = {
  account: "LI7830174502999200012",
  bankName: "SR Saphirstein AG",
  bic: "SAHHCHZ2",
  purpose: 2n,
  creditor: "BR" as const,
};

function sessionApi(
  routes: Record<string, Route>,
  options: { now?: () => number; tokenId?: bigint; signer: Fiat24SessionSigner },
) {
  const stub = stubFetch(routes);
  const api = createFiat24Api({ fetch: stub.fetch, now: options.now ?? (() => SERVER_MS) });
  const session = api.openSession({ tokenId: options.tokenId ?? TOKEN_ID, signer: options.signer });
  return { api, session, calls: stub.calls };
}

const BR_OK = { "/br": json(fixtureBody("secured/br.json")) };
const TIMESTAMP = () => json(JSON.stringify({ timestamp: SERVER_MS }));

describe("session grant lifecycle", () => {
  test("reuse", async () => {
    const signer = testSigner();
    const { session, calls } = sessionApi(
      { "/timestamp": TIMESTAMP(), "/cards": json(fixtureBody("secured/cards-ok.json")), ...BR_OK },
      { signer },
    );
    await session.profile();
    await session.cards();
    // One mint: /timestamp once, one signature, the cached grant covers the second read.
    expect(signer.signCalls).toBe(1);
    expect(calls.map((c) => c.url)).toStrictEqual([
      "https://api.fiat24.com/timestamp",
      "https://api.fiat24.com/br",
      "https://api.fiat24.com/cards",
    ]);
  });

  test("margin", async () => {
    let serverMs = SERVER_MS;
    let now = SERVER_MS;
    const signer = testSigner();
    const { session, calls } = sessionApi(
      {
        "/timestamp": () => Response.json({ timestamp: serverMs }),
        ...BR_OK,
      },
      { now: () => now, signer },
    );
    await session.profile();
    expect(signer.signCalls).toBe(1);
    // Reuse window ends at deadline*1000 - 60000 = floor(T0/1000)*1000 + 540000.
    const boundary = Math.trunc(SERVER_MS / 1000) * 1000 + 540_000;
    now = boundary - 1;
    await session.profile();
    expect(signer.signCalls).toBe(1);
    now = boundary;
    serverMs = now;
    await session.profile();
    expect(signer.signCalls).toBe(2);
    expect(calls.filter((c) => c.url.endsWith("/timestamp"))).toHaveLength(2);
  });

  test("grant contents", async () => {
    const signer = testSigner();
    const { session, calls } = sessionApi({ "/timestamp": TIMESTAMP(), ...BR_OK }, { signer });
    await session.profile();
    const headers = calls[1]?.init.headers as Record<string, string>;
    const deadline = BigInt(Math.trunc(SERVER_MS / 1000) + 600);
    expect(headers["deadline"]).toBe(deadline.toString());
    const args = { chainId: 42161 as const, tokenId: TOKEN_ID, deadline };
    expect(headers["hash"]).toBe(sessionLabel(args));
    expect(headers["tokenid"]).toBe("690333");
    const recovered = await recoverMessageAddress({
      message: sessionMessage(args),
      signature: headers["sign"] as Hex,
    });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  test.each([300_001, -300_001])("clock skew %d => invalid-response", async (offset) => {
    const signer = testSigner();
    const { session, calls } = sessionApi(
      { "/timestamp": TIMESTAMP(), ...BR_OK },
      { now: () => SERVER_MS - offset, signer },
    );
    await expectApiError(async () => session.profile(), "invalid-response", "GET /timestamp");
    expect(signer.signCalls).toBe(0);
    expect(calls).toHaveLength(1); // only /timestamp; no secured request
  });

  test.each([300_000, -300_000])("clock skew %d is accepted", async (offset) => {
    const signer = testSigner();
    const { session } = sessionApi(
      { "/timestamp": TIMESTAMP(), ...BR_OK },
      { now: () => SERVER_MS - offset, signer },
    );
    await session.profile();
    expect(signer.signCalls).toBe(1);
  });

  test("re-grant once per session", async () => {
    const signer = testSigner();
    const { session, calls } = sessionApi(
      { "/timestamp": TIMESTAMP(), "/br": json("{}", 401) },
      { signer },
    );
    await expectCode(async () => session.profile(), "unauthorized");
    // mint + 401 + re-mint + 401 => the second 401 propagates.
    expect(signer.signCalls).toBe(2);
    expect(calls).toHaveLength(4);
  });

  test("hostile 401 loop prompts once", async () => {
    const signer = testSigner();
    const { session } = sessionApi(
      { "/timestamp": TIMESTAMP(), "/br": json("{}", 401) },
      { signer },
    );
    await expectCode(async () => session.profile(), "unauthorized");
    await expectCode(async () => session.profile(), "unauthorized");
    await expectCode(async () => session.profile(), "unauthorized");
    await expectCode(async () => session.profile(), "unauthorized");
    await expectCode(async () => session.profile(), "unauthorized");
    expect(signer.signCalls).toBe(2);
  });

  test("write 401", async () => {
    const signer = testSigner();
    const { session, calls } = sessionApi(
      {
        "/timestamp": TIMESTAMP(),
        "/card": json("{}", 401),
        ...BR_OK,
      },
      { signer },
    );
    await expectCode(async () => session.createCard(), "unauthorized");
    // One write request, no retry, no re-grant for the failed write itself.
    expect(calls.map((c) => c.url)).toStrictEqual([
      "https://api.fiat24.com/timestamp",
      "https://api.fiat24.com/card",
    ]);
    // The dropped grant means the next call mints anew.
    await session.profile();
    expect(signer.signCalls).toBe(2);
  });

  test("end()", async () => {
    const signer = testSigner();
    const { session, calls } = sessionApi({ "/timestamp": TIMESTAMP(), ...BR_OK }, { signer });
    await session.profile();
    session.end();
    await expectCode(async () => session.profile(), "session-required");
    await expectCode(async () => session.cards(), "session-required");
    await expectCode(async () => session.cardDisplayToken("123456"), "session-required");
    await expectCode(async () => session.transactions({ currency: "EUR" }), "session-required");
    await expectCode(async () => session.verifyBankPayment(BANK_REQUEST), "session-required");
    await expectCode(async () => session.verifySwissQr(DOC_QR), "session-required");
    await expectCode(async () => session.createCard(), "session-required");
    await expectCode(
      async () => session.setCardStatus({ externalId: "123456", status: "block" }),
      "session-required",
    );
    await expectCode(
      async () => session.setCardCurrency({ externalId: "123456", currency: "EUR" }),
      "session-required",
    );
    await expectCode(
      async () =>
        session.setDeviceToken({ externalId: "123456", cardTokenId: "t", status: "deactivate" }),
      "session-required",
    );
    expect(calls).toHaveLength(2); // timestamp + the first /br only
  });

  test("grant resolving after end()", async () => {
    let resolveSign: ((sig: Hex) => void) | undefined;
    let captured: Fiat24SessionGrant | undefined;
    const account = privateKeyToAccount(ANVIL_KEY);
    const signer = {
      address: account.address,
      signSessionGrant: async (grant: Fiat24SessionGrant) => {
        captured = grant;
        return new Promise<Hex>((resolve) => {
          resolveSign = resolve;
        });
      },
    };
    const { session, calls } = sessionApi({ "/timestamp": TIMESTAMP(), ...BR_OK }, { signer });
    const pending = session.profile();
    pending.catch(() => {});
    // The mint's /timestamp fetch is microtasks; one timer tick drains them to the signer call.
    await new Promise((resolve) => setTimeout(resolve));
    expect(resolveSign).toBeDefined();
    expect(captured).toBeDefined();
    session.end();
    // A valid signature of the captured grant message proves end() discards the minted grant,
    // not a signature check.
    const signature = await account.signMessage({
      message: (captured as Fiat24SessionGrant).message,
    });
    resolveSign?.(signature);
    await expectCode(async () => pending, "session-required");
    // The discarded grant is not stored: no secured request, a new call refuses early.
    expect(calls).toHaveLength(1);
    await expectCode(async () => session.profile(), "session-required");
    expect(calls).toHaveLength(1);
  });

  test("grant resolving after end() with a malformed signature", async () => {
    let resolveSign: ((sig: Hex) => void) | undefined;
    const account = testSigner();
    const signer = {
      address: account.address,
      signSessionGrant: async (_grant: Fiat24SessionGrant) =>
        new Promise<Hex>((resolve) => {
          resolveSign = resolve;
        }),
    };
    const { session } = sessionApi({ "/timestamp": TIMESTAMP(), ...BR_OK }, { signer });
    const pending = session.profile();
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve));
    expect(resolveSign).toBeDefined();
    session.end();
    // The end() check precedes signature validation: session-required, not invalid-response.
    resolveSign?.("0xdead");
    await expectCode(async () => pending, "session-required");
  });

  test("timestamp resolving after end()", async () => {
    let resolveTimestamp: ((response: Response) => void) | undefined;
    const signer = testSigner();
    const { session, calls } = sessionApi(
      {
        "/timestamp": async () =>
          new Promise<Response>((resolve) => {
            resolveTimestamp = resolve;
          }),
        ...BR_OK,
      },
      { signer },
    );
    const pending = session.profile();
    pending.catch(() => {});
    // The fetch is issued synchronously; its deferred response is resolved after end().
    expect(calls).toHaveLength(1);
    session.end();
    resolveTimestamp?.(await json(JSON.stringify({ timestamp: SERVER_MS }))());
    // end() before the server answers means the signer is never prompted.
    await expectCode(async () => pending, "session-required");
    expect(signer.signCalls).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("read resolving after end()", async () => {
    let resolveBr: ((response: Response) => void) | undefined;
    const signer = testSigner();
    const { session, calls } = sessionApi(
      {
        "/timestamp": TIMESTAMP(),
        "/br": async () =>
          new Promise<Response>((resolve) => {
            resolveBr = resolve;
          }),
      },
      { signer },
    );
    const pending = session.profile();
    pending.catch(() => {});
    // One timer tick drains the mint's microtasks to the deferred /br request.
    await new Promise((resolve) => setTimeout(resolve));
    expect(calls).toHaveLength(2);
    session.end();
    resolveBr?.(await json(fixtureBody("secured/br.json"))());
    // The response body is discarded; the call rejects rather than resolving after end().
    await expectCode(async () => pending, "session-required");
  });

  test("grant reuse applies the clock offset", async () => {
    // Server clock 200 s ahead of local (inside the 300 s skew bound).
    const local = clock(SERVER_MS - 200_000);
    const signer = testSigner();
    const { session, calls } = sessionApi(
      {
        "/timestamp": async () => json(JSON.stringify({ timestamp: local.now() + 200_000 }))(),
        ...BR_OK,
      },
      { now: local.now, signer },
    );
    await session.profile();
    // 340 s later the server clock is inside the reuse margin (deadline - 60 s) even though the
    // local clock is not; a reuse check ignoring the offset would wrongly keep the grant.
    local.set(SERVER_MS + 340_000);
    await session.profile();
    expect(signer.signCalls).toBe(2);
    expect(calls.filter((c) => c.url.endsWith("/timestamp"))).toHaveLength(2);
  });

  test("concurrent calls share one in-flight grant", async () => {
    const signer = testSigner();
    const { session, calls } = sessionApi(
      { "/timestamp": TIMESTAMP(), "/cards": json(fixtureBody("secured/cards-ok.json")), ...BR_OK },
      { signer },
    );
    const [profile, cards] = await Promise.all([session.profile(), session.cards()]);
    expect(profile.tokenId).toBe(TOKEN_ID);
    expect(cards).toHaveLength(1);
    expect(signer.signCalls).toBe(1);
    expect(calls.filter((c) => c.url.endsWith("/timestamp"))).toHaveLength(1);
  });

  test("recover-address check", async () => {
    // The grant signature must recover to signer.address: a signature minted by a
    // different key under a declared address is refused before any secured call.
    const foreign = testSigner(ANVIL_KEY_1);
    const declared = testSigner();
    const { session, calls } = sessionApi(
      { "/timestamp": TIMESTAMP(), ...BR_OK },
      {
        signer: {
          address: declared.address,
          signSessionGrant: async (grant) => foreign.signSessionGrant(grant),
        },
      },
    );
    await expectCode(async () => session.profile(), "invalid-response");
    expect(calls).toHaveLength(1); // /timestamp only — no secured request

    const malformed = sessionApi(
      { "/timestamp": TIMESTAMP(), ...BR_OK },
      {
        signer: {
          address: declared.address,
          signSessionGrant: async () => Promise.resolve("0x12"),
        },
      },
    );
    await expectCode(async () => malformed.session.profile(), "invalid-response");
    expect(malformed.calls).toHaveLength(1);
  });

  test.each([
    ["Fiat24Error", new Fiat24Error("signer-rejected", "user refused")],
    ["EIP-1193 4001", Object.assign(new Error("denied"), { code: 4001 })],
    ["plain Error", new Error("boom")],
  ])("signer throws %s => signer-rejected", async (_name, thrown) => {
    expect.hasAssertions();
    const { session } = sessionApi(
      { "/timestamp": TIMESTAMP(), ...BR_OK },
      {
        signer: {
          address: testSigner().address,
          signSessionGrant: async () => Promise.reject(thrown),
        },
      },
    );
    await expectCode(async () => session.profile(), "signer-rejected");
  });

  test("openSession validates without I/O", () => {
    const stub = stubFetch({});
    const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
    const signer = testSigner();
    expect(() => api.openSession({ tokenId: 0n, signer })).toThrow(Fiat24Error);
    expect(() =>
      api.openSession({
        tokenId: TOKEN_ID,
        signer: {
          address: "not-an-address" as `0x${string}`,
          signSessionGrant: signer.signSessionGrant,
        },
      }),
    ).toThrow(Fiat24Error);
    expect(() =>
      api.openSession({
        tokenId: TOKEN_ID,
        signer: { address: signer.address } as unknown as Fiat24SessionSigner,
      }),
    ).toThrow(Fiat24Error);
    const session = api.openSession({ tokenId: TOKEN_ID, signer });
    expect(session.tokenId).toBe(TOKEN_ID);
    expect(stub.calls).toHaveLength(0);
    expect(signer.signCalls).toBe(0);
  });
});
