/**
 * R-08 — the card `create` observation is `cards.length > 0`: an already-existing card in any
 * status (e.g. Expired) is taken as "created", so `advanceCard` resolves `confirmed` without ever
 * issuing `POST /card`. This test asserts the current defective behaviour; it is expected to fail
 * once the finding is fixed.
 */
import { describe, expect, test } from "vite-plus/test";

import type { Card as ApiCard, Fiat24Session } from "../../src/api/types.ts";
import { advanceCard, startCardOperation } from "../../src/flows/index.ts";
import type { CardState } from "../../src/flows/index.ts";
import { flowDeps, makeFlowStub, OWNER } from "../flows/stub.ts";

const TOKEN_ID = 690333n;

const CREATE: CardState = startCardOperation({
  owner: OWNER,
  tokenId: TOKEN_ID,
  operation: { kind: "create" },
});

function sessionWith(cards: ReadonlyArray<ApiCard>, writes: string[]): Fiat24Session {
  const write = async (name: string): Promise<void> => {
    writes.push(name);
    return Promise.resolve();
  };
  return {
    tokenId: TOKEN_ID,
    profile: async () => Promise.resolve({ isCardEligible: true }),
    cards: async () => Promise.resolve(cards),
    createCard: async () => write("POST /card"),
    setCardStatus: async () => write("POST /card-status"),
    setCardCurrency: async () => write("PUT /card-currency"),
    setDeviceToken: async () => write("POST /card-device-token"),
  } as unknown as Fiat24Session;
}

describe("card create with an existing Expired card (R-08)", () => {
  test("confirmed without POST /card although only an Expired card exists", async () => {
    const expired: ApiCard = {
      externalId: "654321",
      status: "expired",
      currency: "EUR24",
      currencies: ["EUR", "CHF", "USD", "CNH"],
      last4: "4455",
      activeTokens: [],
      inactiveTokens: [],
    };
    const writes: string[] = [];
    const session = sessionWith([expired], writes);
    const stub = makeFlowStub({});
    const { deps } = flowDeps(stub.client);
    const next = await advanceCard({ ...deps, session }, CREATE);
    expect(next.step).toBe("confirmed");
    expect(next.txs).toStrictEqual([{ purpose: "main", phase: "confirmed" }]);
    expect(writes).toStrictEqual([]);
  });
});
