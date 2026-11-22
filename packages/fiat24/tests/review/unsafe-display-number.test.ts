/**
 * R-04 — display-only decimal fields accept JSON numbers: a number above 2^53 is re-serialized
 * through the (already lossy) double, so `transactions`/`profile` return a silently changed amount
 * instead of `invalid-response`. This test asserts the current defective behaviour; it is expected
 * to fail once the finding is fixed.
 */
import { describe, expect, test } from "vite-plus/test";

import { createFiat24Api } from "../../src/api/index.ts";
import type { Fiat24Session } from "../../src/api/types.ts";
import { fixtureBody, json, stubFetch, testSigner } from "../api/stub.ts";
import type { Route } from "../api/stub.ts";

const TOKEN_ID = 690333n;
const SERVER_MS = 1_795_328_524_822;

function sessionApi(routes: Record<string, Route>): {
  session: Fiat24Session;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const stub = stubFetch({
    "/timestamp": json(JSON.stringify({ timestamp: SERVER_MS })),
    ...routes,
  });
  const api = createFiat24Api({ fetch: stub.fetch, now: () => SERVER_MS });
  return {
    session: api.openSession({ tokenId: TOKEN_ID, signer: testSigner() }),
    calls: stub.calls,
  };
}

describe("unsafe JSON numbers in display-only fields (R-04)", () => {
  test("/transactions amount 2^53+1 comes back one less, no invalid-response", async () => {
    const body =
      '{"count":1,"transactions":[{"title":"x","subtitle":"y","amount":9007199254740993,"timestamp":1683221111000}]}';
    const { session } = sessionApi({ "/transactions?currency=EUR": json(body) });
    const page = await session.transactions({ currency: "EUR" });
    expect(page.transactions[0]?.amount).toBe("9007199254740992");
  });

  test("/br cardActivation.amount 1.2e19 comes back rounded", async () => {
    const raw = fixtureBody("secured/br.json").replace(
      '"cardActivation":{"amount":10,"currency":"EUR"}',
      '"cardActivation":{"amount":12345678901234567890,"currency":"EUR"}',
    );
    const { session } = sessionApi({ "/br": json(raw) });
    const profile = await session.profile();
    expect(profile.cardActivation?.amount).toBe("12345678901234567000");
  });
});
