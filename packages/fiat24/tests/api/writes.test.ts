import { describe, expect, test } from "vite-plus/test";

import { API_BASE_URL, createFiat24Api } from "../../src/api/index.ts";
import type { Fiat24Error } from "../../src/core/index.ts";
import { isFiat24Error } from "../../src/core/index.ts";
import { caught, expectCode, fixtureBody, json, stubFetch, testSigner } from "./stub.ts";
import type { Route } from "./stub.ts";

const TOKEN_ID = 690333n;
const SERVER_MS = 1_795_328_524_822;

function sessionApi(routes: Record<string, Route>, now = SERVER_MS) {
  const stub = stubFetch({
    "/timestamp": json(JSON.stringify({ timestamp: now })),
    ...routes,
  });
  const api = createFiat24Api({ fetch: stub.fetch, now: () => now });
  const signer = testSigner();
  const session = api.openSession({ tokenId: TOKEN_ID, signer });
  return { api, session, calls: stub.calls, signer };
}

const WRITES = [
  ["createCard", "POST", "/card", "{}", async (s: Session) => s.createCard()],
  [
    "setCardStatus",
    "POST",
    "/card-status",
    '{"statusChange":"block","externalId":"123456"}',
    async (s: Session) => s.setCardStatus({ externalId: "123456", status: "block" }),
  ],
  [
    "setCardCurrency",
    "PUT",
    "/card-currency",
    '{"currency":"EUR","externalId":"123456"}',
    async (s: Session) => s.setCardCurrency({ externalId: "123456", currency: "EUR" }),
  ],
  [
    "setDeviceToken",
    "POST",
    "/card-device-token",
    '{"statusChange":"deactivate","cardTokenId":"tok","externalId":"123456"}',
    async (s: Session) =>
      s.setDeviceToken({ externalId: "123456", cardTokenId: "tok", status: "deactivate" }),
  ],
] as const;

type Session = ReturnType<typeof sessionApi>["session"];

describe("writes", () => {
  test.each(WRITES)(
    "exact method, path and JSON body for %s",
    async (_name, method, path, body, run) => {
      const { session, calls } = sessionApi({ [path]: json(fixtureBody("secured/write-ok.json")) });
      await expect(run(session)).resolves.toBeUndefined();
      const [, call] = calls;
      expect(call?.url).toBe(`${API_BASE_URL}${path}`);
      expect(call?.init.method).toBe(method);
      expect(call?.init.body).toBe(body);
      const headers = call?.init.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("application/json");
      expect(calls).toHaveLength(2);
    },
  );

  test.each(WRITES)(
    "{status:404,data} => api-rejected for %s",
    async (_name, _method, path, _body, run) => {
      const { session, calls } = sessionApi({
        [path]: json(fixtureBody("secured/write-nok.json")),
      });
      const error = await caught(async () => run(session));
      expect(isFiat24Error(error)).toBe(true);
      const rejected = error as Fiat24Error;
      expect(rejected.code).toBe("api-rejected");
      expect((rejected.detail as Record<string, unknown>)["status"]).toBe(404);
      expect(calls).toHaveLength(2);
    },
  );

  test.each(WRITES)("{} => api-rejected for %s", async (_name, _method, path, _body, run) => {
    expect.hasAssertions();
    const { session } = sessionApi({ [path]: json(fixtureBody("secured/write-empty.json")) });
    await expectCode(async () => run(session), "api-rejected");
  });

  test.each(WRITES)(
    "fetch throws => network-error, one request, for %s",
    async (_name, _method, path, _body, run) => {
      const { session, calls } = sessionApi({
        [path]: () => {
          throw new Error("down");
        },
      });
      await expectCode(async () => run(session), "network-error");
      expect(calls.filter((c) => c.url.endsWith(path))).toHaveLength(1);
    },
  );

  test.each(WRITES)(
    "500 => http-error, one request, for %s",
    async (_name, _method, path, _body, run) => {
      const { session, calls } = sessionApi({ [path]: json("{}", 500) });
      await expectCode(async () => run(session), "http-error");
      expect(calls.filter((c) => c.url.endsWith(path))).toHaveLength(1);
    },
  );

  test.each(WRITES)(
    "401 => unauthorized, one request, one grant, for %s",
    async (_name, _method, path, _body, run) => {
      const { session, calls, signer } = sessionApi({ [path]: json("{}", 401) });
      await expectCode(async () => run(session), "unauthorized");
      expect(calls.filter((c) => c.url.endsWith(path))).toHaveLength(1);
      expect(signer.signCalls).toBe(1);
    },
  );

  test.each(WRITES)(
    "2xx non-ack stays a result error for %s",
    async (_name, _method, path, _body, run) => {
      expect.hasAssertions();
      const { session } = sessionApi({ [path]: json('{"status":201,"data":"queued"}') });
      await expectCode(async () => run(session), "api-rejected");
    },
  );

  test.each([
    [async (s: Session) => s.setCardStatus({ externalId: "123456", status: "freeze" as "block" })],
    [async (s: Session) => s.setCardStatus({ externalId: "", status: "block" })],
    [async (s: Session) => s.setCardCurrency({ externalId: "123456", currency: "GBP" as "EUR" })],
    [
      async (s: Session) =>
        s.setDeviceToken({ externalId: "123456", cardTokenId: "", status: "deactivate" }),
    ],
    [
      async (s: Session) =>
        s.setDeviceToken({ externalId: "123456", cardTokenId: "t", status: "drop" as "activate" }),
    ],
    [async (s: Session) => s.cardDisplayToken("x".repeat(1025))],
  ])("invalid input refused before I/O #%#", async (run) => {
    const { session, calls } = sessionApi({});
    await expectCode(async () => run(session), "invalid-argument");
    expect(calls).toHaveLength(0);
  });
});
