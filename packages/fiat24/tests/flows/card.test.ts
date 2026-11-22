import { encodeFunctionData, getAddress } from "viem";
import type { Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import { apiError } from "../../src/api/http.ts";
import type { Card as ApiCard, Fiat24Session } from "../../src/api/types.ts";
import { Fiat24Error } from "../../src/core/errors.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceCard, startCardOperation, startCardSetup } from "../../src/flows/index.ts";
import type { CardState } from "../../src/flows/index.ts";
import type { CallEntry } from "../chain/stub.ts";
import { expectErrorAsync } from "../chain/stub.ts";
import { throwsCode } from "../helpers.ts";
import {
  accountEntries,
  availabilityEntries,
  B,
  flowDeps,
  guardCalls,
  honestStorage,
  makeFlowStub,
  makeSigner,
  mergeCalls,
  OWNER,
  proxyAdminEntry,
  receiptPayload,
  txPayload,
  TXID_1,
  wordWithAddress,
} from "./stub.ts";

const EUR24 = C.tokens.EUR24.proxy;
const USD24 = C.tokens.USD24.proxy;
const CARD = C.card.proxy;
const OWNER_CS = getAddress(OWNER);

const TOKEN_ID = 690333n;
const CAP_AMOUNT = 100n;
const SUPPLY = 10_000_000n;
const EXT_ID = "123456";
const CARD_TOKEN_ID = "active_token_id";

const SETUP: CardState = {
  flow: "card",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "ready",
  tokenId: TOKEN_ID,
  operation: { kind: "create" },
  cap: { currency: "EUR24", amount: CAP_AMOUNT },
};

const SET_CAP: CardState = {
  flow: "card",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "ready",
  tokenId: TOKEN_ID,
  operation: { kind: "set-cap", currency: "EUR24", amount: CAP_AMOUNT },
};

const BLOCK: CardState = {
  flow: "card",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "ready",
  tokenId: TOKEN_ID,
  operation: { kind: "block", externalId: EXT_ID },
};

const SET_CURRENCY: CardState = {
  ...BLOCK,
  operation: { kind: "set-currency", externalId: EXT_ID, currency: "USD" },
};

const ACTIVATE: CardState = {
  ...BLOCK,
  operation: {
    kind: "device-token",
    externalId: EXT_ID,
    cardTokenId: CARD_TOKEN_ID,
    status: "activate",
  },
};

const CREATE: CardState = {
  flow: "card",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "ready",
  tokenId: TOKEN_ID,
  operation: { kind: "create" },
};

const MAIN_SENDING: CardState = {
  ...BLOCK,
  step: "tx",
  txs: [{ purpose: "main", phase: "sending" }],
};

const MAIN_UNKNOWN: CardState = {
  ...BLOCK,
  step: "tx",
  txs: [{ purpose: "main", phase: "unknown", error: "unknown-outcome" }],
};

function apiCard(overrides: Partial<ApiCard> = {}): ApiCard {
  return {
    externalId: EXT_ID,
    status: "active",
    currency: "EUR24",
    currencies: ["EUR", "CHF", "USD", "CNH"],
    last4: "4455",
    activeTokens: [],
    inactiveTokens: [],
    ...overrides,
  };
}

function cardSession(
  opts: {
    readonly tokenId?: bigint;
    readonly eligible?: boolean;
    readonly cards?: ReadonlyArray<ApiCard> | (() => ReadonlyArray<ApiCard>);
    readonly cardsError?: Error;
    readonly writeError?: Error;
  } = {},
): { session: Fiat24Session; writes: string[]; cardReads: { count: number } } {
  const writes: string[] = [];
  const cardReads = { count: 0 };
  const write = async (name: string): Promise<void> => {
    writes.push(name);
    if (opts.writeError !== undefined) {
      return Promise.reject(opts.writeError);
    }
    return Promise.resolve();
  };
  return {
    writes,
    cardReads,
    session: {
      tokenId: opts.tokenId ?? TOKEN_ID,
      profile: async () => Promise.resolve({ isCardEligible: opts.eligible ?? true }),
      cards: async () => {
        cardReads.count += 1;
        if (opts.cardsError !== undefined) {
          return Promise.reject(opts.cardsError);
        }
        return Promise.resolve(
          typeof opts.cards === "function" ? opts.cards() : (opts.cards ?? []),
        );
      },
      createCard: async () => write("POST /card"),
      setCardStatus: async () => write("POST /card-status"),
      setCardCurrency: async () => write("PUT /card-currency"),
      setDeviceToken: async () => write("POST /card-device-token"),
    } as unknown as Fiat24Session,
  };
}

/** A `cards()` body picker: serves `bodies[i]` for the i-th call, clamped to the last. */
function cardQueue(bodies: ReadonlyArray<ReadonlyArray<ApiCard>>): () => ReadonlyArray<ApiCard> {
  let index = 0;
  return () => {
    const body = bodies[Math.min(index, bodies.length - 1)] ?? [];
    index += 1;
    return body;
  };
}

type TableOpts = {
  readonly currency?: "EUR24" | "USD24";
  readonly allowance?: bigint;
  readonly totalSupply?: bigint;
  readonly amount?: bigint;
  readonly paused?: Readonly<Record<string, boolean>>;
};

/** The reads a card ready-plan + approve guard + simulate consume for one round. */
function cardTable(opts: TableOpts = {}): Map<string, CallEntry[]> {
  const token = (opts.currency === "USD24" ? USD24 : EUR24).toLowerCase();
  const amount = opts.amount ?? CAP_AMOUNT;
  return mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false }),
    accountEntries(OWNER, { historic: TOKEN_ID }),
    new Map<string, CallEntry[]>([
      [`${token}:allowance`, [{ args: [OWNER, CARD], answer: { result: opts.allowance ?? 0n } }]],
      [`${token}:totalSupply`, [{ answer: { result: opts.totalSupply ?? SUPPLY } }]],
      [`${token}:approve`, [{ args: [CARD, amount], answer: { result: true } }]],
    ]),
  );
}

describe("startCardSetup / startCardOperation", () => {
  test("startCardSetup validates the cap and returns a setup state", () => {
    const state = startCardSetup({
      owner: OWNER,
      tokenId: TOKEN_ID,
      cap: { currency: "EUR24", amount: CAP_AMOUNT },
    });
    expect(state).toStrictEqual(SETUP);
  });

  test("startCardSetup refuses cap.amount < 1 and unknown assets", () => {
    const attempts: ReadonlyArray<readonly [() => unknown, ReadonlySet<string>]> = [
      [
        () =>
          startCardSetup({
            owner: OWNER,
            tokenId: TOKEN_ID,
            cap: { currency: "EUR24", amount: 0n },
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () =>
          startCardSetup({
            owner: OWNER,
            tokenId: TOKEN_ID,
            cap: { currency: "USDC" as never, amount: CAP_AMOUNT },
          }),
        new Set(["invalid-argument"]),
      ],
    ];
    const results = attempts.map(([attempt, codes]) => throwsCode(attempt, codes));
    expect(results.every(Boolean)).toBe(true);
  });

  test("startCardOperation validates each operation shape", () => {
    const state = startCardOperation({
      owner: OWNER,
      tokenId: TOKEN_ID,
      operation: { kind: "set-cap", currency: "EUR24", amount: 0n },
    });
    expect(state.step).toBe("ready");
    const attempts: ReadonlyArray<readonly [() => unknown, ReadonlySet<string>]> = [
      [
        () =>
          startCardOperation({
            owner: OWNER,
            tokenId: TOKEN_ID,
            operation: { kind: "block", externalId: "" },
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () =>
          startCardOperation({
            owner: OWNER,
            tokenId: TOKEN_ID,
            operation: { kind: "set-currency", externalId: EXT_ID, currency: "GBP" as never },
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () =>
          startCardOperation({
            owner: OWNER,
            tokenId: TOKEN_ID,
            operation: {
              kind: "device-token",
              externalId: EXT_ID,
              cardTokenId: "",
              status: "activate",
            },
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () =>
          startCardOperation({
            owner: OWNER,
            tokenId: TOKEN_ID,
            operation: { kind: "explode" } as never,
          }),
        new Set(["invalid-argument"]),
      ],
    ];
    const results = attempts.map(([attempt, codes]) => throwsCode(attempt, codes));
    expect(results.every(Boolean)).toBe(true);
  });
});

describe("advanceCard chain part", () => {
  test("setup: allowance < cap ⇒ approve exactly cap.amount", async () => {
    const stub = makeFlowStub({
      calls: cardTable({ allowance: 50n }),
      storage: honestStorage(),
      count: { pending: 3 },
    });
    const { deps } = flowDeps(stub.client);
    const next = await advanceCard(deps, SETUP);
    const record = next.txs.at(-1);
    expect(next.step).toBe("tx");
    expect(record).toStrictEqual({
      purpose: "approve",
      phase: "submitted",
      fromBlock: B,
      nonce: 3,
      hash: TXID_1,
    });
    expect(stub.requests.some((request) => request.method === "eth_call")).toBe(true);
  });

  test("set-cap: allowance above cap ⇒ approve exactly cap.amount (down)", async () => {
    const stub = makeFlowStub({
      calls: cardTable({ allowance: 2n ** 256n - 1n }),
      storage: honestStorage(),
      count: { pending: 3 },
    });
    const { signer, requests } = makeSigner(OWNER);
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advanceCard(deps, SET_CAP);
    expect(next.step).toBe("tx");
    const request = requests.at(-1);
    expect(request?.data).toBe(
      encodeFunctionData({
        abi: tokenAbi,
        functionName: "approve",
        args: [CARD, CAP_AMOUNT],
      }),
    );
    expect(request?.to).toBe(getAddress(EUR24));
  });

  test("cap above total supply ⇒ unlimited-approval, signer not called", async () => {
    const stub = makeFlowStub({
      calls: cardTable({ allowance: 0n, totalSupply: CAP_AMOUNT - 1n }),
      storage: honestStorage(),
    });
    const { signer, requests } = makeSigner(OWNER);
    const { deps } = flowDeps(stub.client, { signer });
    await expectErrorAsync(async () => advanceCard(deps, SET_CAP), "unlimited-approval");
    expect(requests).toStrictEqual([]);
  });

  test("set-cap already matching ⇒ confirmed with no transaction", async () => {
    const stub = makeFlowStub({
      calls: cardTable({ allowance: CAP_AMOUNT }),
      storage: honestStorage(),
    });
    const { signer, requests } = makeSigner(OWNER);
    const { deps, persisted } = flowDeps(stub.client, { signer });
    const next = await advanceCard(deps, SET_CAP);
    expect(next.step).toBe("confirmed");
    expect(next.txs).toStrictEqual([]);
    expect(requests).toStrictEqual([]);
    expect(persisted).toStrictEqual([next]);
  });

  test("approve confirmed ⇒ main{ready} appended, write not issued", async () => {
    const state: CardState = {
      ...SETUP,
      step: "tx",
      txs: [{ purpose: "approve", phase: "submitted", fromBlock: B, nonce: 3, hash: TXID_1 }],
    };
    const stub = makeFlowStub({
      calls: cardTable(),
      storage: honestStorage(),
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: EUR24,
          input: encodeFunctionData({
            abi: tokenAbi,
            functionName: "approve",
            args: [CARD, CAP_AMOUNT],
          }),
          value: 0n,
          nonce: 3,
          blockNumber: B + 1n,
        }),
      },
    });
    const { session, writes } = cardSession();
    const { deps } = flowDeps(stub.client);
    const next = await advanceCard({ ...deps, session }, state);
    expect(next.step).toBe("tx");
    expect(next.txs).toStrictEqual([
      {
        purpose: "approve",
        phase: "confirmed",
        fromBlock: B,
        nonce: 3,
        hash: TXID_1,
        blockNumber: B + 1n,
      },
      { purpose: "main", phase: "ready" },
    ]);
    expect(writes).toStrictEqual([]);
  });
});

describe("advanceCard API write", () => {
  test("create: eligible + no cards ⇒ sending then confirmed", async () => {
    const { session, writes, cardReads } = cardSession({ cards: [] });
    const stub = makeFlowStub({ storage: honestStorage() });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advanceCard({ ...deps, session }, CREATE);
    expect(next.step).toBe("confirmed");
    expect(next.txs).toStrictEqual([{ purpose: "main", phase: "confirmed" }]);
    expect(writes).toStrictEqual(["POST /card"]);
    expect(cardReads.count).toBe(1);
    expect(persisted).toHaveLength(2);
  });

  test("setup with matching allowance skips the approve and writes", async () => {
    const { session, writes } = cardSession({ cards: [] });
    const stub = makeFlowStub({
      calls: cardTable({ allowance: CAP_AMOUNT }),
      storage: honestStorage(),
    });
    const { deps } = flowDeps(stub.client);
    const next = await advanceCard({ ...deps, session }, SETUP);
    expect(next.step).toBe("confirmed");
    expect(writes).toStrictEqual(["POST /card"]);
  });

  test("isCardEligible false ⇒ api-rejected on GET /br", async () => {
    const { session, writes } = cardSession({ eligible: false, cards: [] });
    const stub = makeFlowStub({ storage: honestStorage() });
    const { deps, persisted } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceCard({ ...deps, session }, CREATE),
      "api-rejected",
    );
    expect(error.detail.endpoint).toBe("GET /br");
    expect(writes).toStrictEqual([]);
    expect(persisted).toStrictEqual([]);
  });

  test("target already observed ⇒ confirmed, no write", async () => {
    const { session, writes } = cardSession({ cards: [apiCard({ status: "blocked" })] });
    const stub = makeFlowStub({ storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const next = await advanceCard({ ...deps, session }, BLOCK);
    expect(next.step).toBe("confirmed");
    expect(writes).toStrictEqual([]);
  });

  test("set-currency: card already on the target currency ⇒ confirmed, no write", async () => {
    const { session, writes } = cardSession({ cards: [apiCard({ currency: "USD24" })] });
    const stub = makeFlowStub({ storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const next = await advanceCard({ ...deps, session }, SET_CURRENCY);
    expect(next.step).toBe("confirmed");
    expect(next.txs).toStrictEqual([{ purpose: "main", phase: "confirmed" }]);
    expect(writes).toStrictEqual([]);
  });

  test("non-create op on a missing card ⇒ api-rejected on GET /cards", async () => {
    const { session, writes } = cardSession({ cards: [] });
    const stub = makeFlowStub({ storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceCard({ ...deps, session }, BLOCK),
      "api-rejected",
    );
    expect(error.detail.endpoint).toBe("GET /cards");
    expect(writes).toStrictEqual([]);
  });

  test("each op's write lands and the observed target confirms", async () => {
    const cases: ReadonlyArray<{
      readonly state: CardState;
      readonly preCards: ReadonlyArray<ApiCard>;
      readonly postCards: ReadonlyArray<ApiCard>;
      readonly write: string;
    }> = [
      {
        state: BLOCK,
        preCards: [apiCard()],
        postCards: [apiCard({ status: "blocked" })],
        write: "POST /card-status",
      },
      {
        state: { ...BLOCK, operation: { kind: "unblock", externalId: EXT_ID } },
        preCards: [apiCard({ status: "blocked" })],
        postCards: [apiCard({ status: "active" })],
        write: "POST /card-status",
      },
      {
        state: SET_CURRENCY,
        preCards: [apiCard()],
        postCards: [apiCard({ currency: "USD24" })],
        write: "PUT /card-currency",
      },
      {
        state: ACTIVATE,
        preCards: [apiCard()],
        postCards: [apiCard({ activeTokens: [{ id: CARD_TOKEN_ID, type: "t", createdAt: 1n }] })],
        write: "POST /card-device-token",
      },
      {
        state: {
          ...BLOCK,
          operation: {
            kind: "device-token",
            externalId: EXT_ID,
            cardTokenId: "inactive_token_id",
            status: "deactivate",
          },
        },
        preCards: [
          apiCard({ activeTokens: [{ id: "inactive_token_id", type: "t", createdAt: 1n }] }),
        ],
        postCards: [
          apiCard({ inactiveTokens: [{ id: "inactive_token_id", type: "t", createdAt: 1n }] }),
        ],
        write: "POST /card-device-token",
      },
    ];
    await Promise.all(
      cases.map(async ({ state, preCards, postCards, write }) => {
        const { session, writes } = cardSession({ cards: cardQueue([preCards, postCards]) });
        const stub = makeFlowStub({ storage: honestStorage() });
        const { deps } = flowDeps(stub.client);
        const next = await advanceCard({ ...deps, session }, state);
        expect(next.step).toBe("confirmed");
        expect(writes).toStrictEqual([write]);
      }),
    );
  });

  test("network error on POST /card", async () => {
    // Ambiguous write: exactly one GET /cards decides. Present ⇒ confirmed.
    const { session, writes, cardReads } = cardSession({
      cards: cardQueue([[], [apiCard()]]),
      writeError: apiError("network-error", "POST /card"),
    });
    const stub = makeFlowStub({ storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const next = await advanceCard({ ...deps, session }, CREATE);
    expect(next.step).toBe("confirmed");
    expect(writes).toStrictEqual(["POST /card"]); // never a second POST
    expect(cardReads.count).toBe(2); // pre-read + the single observe read

    // Absent ⇒ unknown{unknown-outcome}.
    const empty = cardSession({
      cards: [],
      writeError: apiError("network-error", "POST /card"),
    });
    const stub2 = makeFlowStub({ storage: honestStorage() });
    const { deps: deps2 } = flowDeps(stub2.client);
    const next2 = await advanceCard({ ...deps2, session: empty.session }, CREATE);
    expect(next2.step).toBe("tx");
    expect(next2.txs.at(-1)).toStrictEqual({
      purpose: "main",
      phase: "unknown",
      error: "unknown-outcome",
    });
    expect(empty.writes).toStrictEqual(["POST /card"]);
  });

  test("5xx and invalid-response on the write ⇒ ambiguous; api-rejected ⇒ failed", async () => {
    const ambiguous = cardSession({
      cards: [],
      writeError: apiError("http-error", "POST /card", 503),
    });
    const stub = makeFlowStub({ storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const five = await advanceCard({ ...deps, session: ambiguous.session }, CREATE);
    expect(five.txs.at(-1)?.phase).toBe("unknown");

    const invalid = cardSession({
      cards: [],
      writeError: apiError("invalid-response", "POST /card"),
    });
    const stub2 = makeFlowStub({ storage: honestStorage() });
    const { deps: deps2 } = flowDeps(stub2.client);
    const inv = await advanceCard({ ...deps2, session: invalid.session }, CREATE);
    expect(inv.txs.at(-1)?.phase).toBe("unknown");

    const rejected = cardSession({
      cards: [],
      writeError: apiError("api-rejected", "POST /card"),
    });
    const stub3 = makeFlowStub({ storage: honestStorage() });
    const { deps: deps3 } = flowDeps(stub3.client);
    const fail = await advanceCard({ ...deps3, session: rejected.session }, CREATE);
    expect(fail.step).toBe("failed");
    expect(fail.txs.at(-1)).toStrictEqual({
      purpose: "main",
      phase: "failed",
      error: "api-rejected",
    });
  });

  test("401 / 429 / http-error < 500 / off-endpoint errors ⇒ ready{error}", async () => {
    const cases: ReadonlyArray<{ readonly error: Fiat24Error; readonly code: string }> = [
      { error: apiError("unauthorized", "POST /card", 401), code: "unauthorized" },
      { error: apiError("rate-limited", "POST /card", 429), code: "rate-limited" },
      { error: apiError("http-error", "POST /card", 400), code: "http-error" },
      { error: apiError("network-error", "GET /timestamp"), code: "network-error" },
    ];
    await Promise.all(
      cases.map(async ({ error, code }) => {
        const { session } = cardSession({ cards: [], writeError: error });
        const stub = makeFlowStub({ storage: honestStorage() });
        const { deps } = flowDeps(stub.client);
        const next = await advanceCard({ ...deps, session }, CREATE);
        expect(next.step).toBe("tx");
        expect(next.txs.at(-1)).toStrictEqual({ purpose: "main", phase: "ready", error: code });
      }),
    );
  });

  test("sending resume reads once and never writes; read failure ⇒ unknown", async () => {
    // Observed ⇒ confirmed with no write.
    const { session, writes, cardReads } = cardSession({ cards: [apiCard({ status: "blocked" })] });
    const stub = makeFlowStub({ storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const confirmed = await advanceCard({ ...deps, session }, MAIN_SENDING);
    expect(confirmed.step).toBe("confirmed");
    expect(writes).toStrictEqual([]);
    expect(cardReads.count).toBe(1);

    // Not observed ⇒ unknown{unknown-outcome}; never writes.
    const empty = cardSession({ cards: [apiCard({ status: "active" })] });
    const stub2 = makeFlowStub({ storage: honestStorage() });
    const { deps: deps2 } = flowDeps(stub2.client);
    const unknown = await advanceCard({ ...deps2, session: empty.session }, MAIN_SENDING);
    expect(unknown.txs.at(-1)).toStrictEqual({
      purpose: "main",
      phase: "unknown",
      error: "unknown-outcome",
    });
    expect(empty.writes).toStrictEqual([]);

    // The read itself throws ⇒ unknown{unknown-outcome}.
    const failing = cardSession({ cardsError: new Error("boom") });
    const stub3 = makeFlowStub({ storage: honestStorage() });
    const { deps: deps3 } = flowDeps(stub3.client);
    const failed = await advanceCard({ ...deps3, session: failing.session }, MAIN_SENDING);
    expect(failed.txs.at(-1)).toStrictEqual({
      purpose: "main",
      phase: "unknown",
      error: "unknown-outcome",
    });

    // unknown resume: still one read, never a write.
    const again = cardSession({ cards: [apiCard({ status: "active" })] });
    const stub4 = makeFlowStub({ storage: honestStorage() });
    const { deps: deps4 } = flowDeps(stub4.client);
    const stay = await advanceCard({ ...deps4, session: again.session }, MAIN_UNKNOWN);
    expect(stay.txs.at(-1)?.phase).toBe("unknown");
    expect(again.writes).toStrictEqual([]);
  });

  test("session missing ⇒ session-required; wrong tokenId ⇒ invalid-argument", async () => {
    const stub = makeFlowStub({ storage: honestStorage() });
    const { deps } = flowDeps(stub.client);
    const missing = await expectErrorAsync(
      async () => advanceCard(deps, CREATE),
      "session-required",
    );
    expect(missing).toBeInstanceOf(Fiat24Error);
    const { session } = cardSession({ tokenId: 42n });
    const mismatch = await expectErrorAsync(
      async () => advanceCard({ ...deps, session }, CREATE),
      "invalid-argument",
    );
    expect(mismatch).toBeInstanceOf(Fiat24Error);
  });

  test("terminal steps ⇒ invalid-state with no I/O", async () => {
    const stub = makeFlowStub({});
    const { deps } = flowDeps(stub.client);
    const confirmed: CardState = {
      ...SET_CAP,
      step: "confirmed",
      txs: [
        {
          purpose: "approve",
          phase: "confirmed",
          fromBlock: B,
          nonce: 1,
          hash: TXID_1,
          blockNumber: B + 1n,
        },
      ],
    };
    const error = await expectErrorAsync(async () => advanceCard(deps, confirmed), "invalid-state");
    expect(error).toBeInstanceOf(Fiat24Error);
  });
});

describe("advanceCard drift before guard reads", () => {
  test("chain leg ⇒ contract-changed before any guard read", async () => {
    const storage = honestStorage();
    const impl = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
    storage.set(`${CARD.toLowerCase()}:${impl}`, wordWithAddress(OWNER));
    const stub = makeFlowStub({ calls: proxyAdminEntry(), storage });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(async () => advanceCard(deps, SETUP), "contract-changed");
    expect(error.detail).toMatchObject({ contract: "card", field: "implementation" });
    expect(guardCalls(stub)).toStrictEqual([]);
  });
});
