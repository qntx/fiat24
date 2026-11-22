import { encodeErrorResult } from "viem";
import type { Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import type { Availability } from "../../src/chain/availability.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import type { Deployment } from "../../src/deployments/index.ts";
import {
  assertUnpaused,
  checkedSigner,
  deskOwner,
  legAllowed,
  senderLive,
  supplyBound,
} from "../../src/flows/guards.ts";
import type { VerifiedBlock } from "../../src/flows/guards.ts";
import type { CallEntry } from "../chain/stub.ts";
import { expectErrorAsync } from "../chain/stub.ts";
import { throwsCode } from "../helpers.ts";
import {
  accountEntries,
  AMOUNT,
  B,
  B_HEX,
  makeFlowStub,
  makeSigner,
  OWNER,
  RECIPIENT,
  SENDER_ID,
} from "./stub.ts";

const DEPLOYMENT: Deployment = C;
const AT = { blockNumber: B } as VerifiedBlock;
const ACCOUNT = C.account.proxy;
const TOKEN = C.tokens.EUR24.proxy;
const TXID = `0x${"aa".repeat(32)}` as const;

function errorString(text: string): Hex {
  return encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }] as const,
    errorName: "Error",
    args: [text],
  });
}

const AVAILABILITY: Availability = {
  account: { paused: false, f24Active: true, maxDigitForSale: 6 },
  tokens: {
    USD24: { paused: false },
    EUR24: { paused: false },
    CHF24: { paused: false },
    CNH24: { paused: false },
  },
  deposit: { paused: false, marketClosed: false },
  card: { paused: false },
  f24Sales: { paused: false },
  blockNumber: B,
};

describe("checkedSigner", () => {
  test("refuses a missing or malformed signer before any I/O", () => {
    const refusals: ReadonlyArray<() => unknown> = [
      () => checkedSigner(undefined, OWNER),
      () => checkedSigner({ address: OWNER } as never, OWNER),
      () => checkedSigner(makeSigner(RECIPIENT).signer, OWNER),
      () =>
        checkedSigner(
          { address: "0x1234", sendTransaction: async () => Promise.resolve(TXID) } as never,
          OWNER,
        ),
    ];
    const results = refusals.map((refusal) => throwsCode(refusal, new Set(["invalid-argument"])));
    expect(results.every(Boolean)).toBe(true);
  });

  test("returns the signer when address matches the owner", () => {
    const { signer } = makeSigner(OWNER);
    expect(checkedSigner(signer, OWNER)).toBe(signer);
  });
});

describe("assertUnpaused", () => {
  test("skips the account flag for approve-only paths", () => {
    const availability: Availability = {
      ...AVAILABILITY,
      account: { ...AVAILABILITY.account, paused: true },
    };
    expect(() => assertUnpaused(availability, ["EUR24"], { account: false })).not.toThrow();
    expect(
      throwsCode(() => assertUnpaused(availability, ["EUR24"]), new Set(["unavailable"])),
    ).toBe(true);
  });

  test("throws unavailable with the paused token's name", () => {
    const availability: Availability = {
      ...AVAILABILITY,
      tokens: { ...AVAILABILITY.tokens, CHF24: { paused: true } },
    };
    let detail: unknown;
    try {
      assertUnpaused(availability, ["EUR24", "CHF24"]);
    } catch (error) {
      ({ detail } = error as { readonly detail?: unknown });
    }
    expect(detail).toStrictEqual({ contract: "CHF24", reason: "token-paused" });
  });
});

describe("senderLive", () => {
  const args = { deployment: DEPLOYMENT, owner: OWNER, at: AT };

  test("returns the live account", async () => {
    const stub = makeFlowStub({ calls: accountEntries(OWNER, {}) });
    const account = await senderLive(stub.client, args);
    expect(account.tokenId).toBe(SENDER_ID);
    expect(account.status).toBe("live");
  });

  test("no-account and not-live map to their codes", async () => {
    const missing = makeFlowStub({ calls: accountEntries(OWNER, { historic: 0n, balance: 0n }) });
    const missingErr = await expectErrorAsync(
      async () => senderLive(missing.client, args),
      "no-account",
    );
    const blocked = makeFlowStub({ calls: accountEntries(OWNER, { statusIndex: 3 }) });
    const blockedErr = await expectErrorAsync(
      async () => senderLive(blocked.client, args),
      "not-live",
    );
    expect([missingErr.code, blockedErr.code]).toStrictEqual(["no-account", "not-live"]);
  });
});

describe("legAllowed", () => {
  const args = {
    deployment: DEPLOYMENT,
    at: AT,
    token: "EUR24" as const,
    from: OWNER,
    to: RECIPIENT,
    amount: AMOUNT,
    limitOf: SENDER_ID,
  };

  function table(verdict: CallEntry["answer"], limit?: boolean): Map<string, CallEntry[]> {
    return new Map<string, CallEntry[]>([
      [
        `${TOKEN.toLowerCase()}:tokenTransferAllowed`,
        [{ args: [OWNER, RECIPIENT, AMOUNT], answer: verdict }],
      ],
      [`${TOKEN.toLowerCase()}:convertToChf`, [{ args: [AMOUNT], answer: { result: AMOUNT } }]],
      [
        `${ACCOUNT.toLowerCase()}:checkLimit`,
        [{ args: [SENDER_ID, AMOUNT], answer: { result: limit ?? true } }],
      ],
    ]);
  }

  test("true verdict passes", async () => {
    const stub = makeFlowStub({ calls: table({ result: true }) });
    await legAllowed(stub.client, args);
    const allowedCalls = stub.calls.filter((c) => c.functionName === "tokenTransferAllowed");
    expect(allowedCalls).toHaveLength(1);
  });

  test("false + within limit ⇒ transfer-not-allowed", async () => {
    const stub = makeFlowStub({ calls: table({ result: false }, true) });
    const error = await expectErrorAsync(
      async () => legAllowed(stub.client, args),
      "transfer-not-allowed",
    );
    expect(error.code).toBe("transfer-not-allowed");
  });

  test("false + limit exceeded ⇒ limit-exceeded", async () => {
    const stub = makeFlowStub({ calls: table({ result: false }, false) });
    const error = await expectErrorAsync(
      async () => legAllowed(stub.client, args),
      "limit-exceeded",
    );
    expect(error.code).toBe("limit-exceeded");
  });

  test("false without limitOf ⇒ transfer-not-allowed without the limit read", async () => {
    const stub = makeFlowStub({ calls: table({ result: false }) });
    const error = await expectErrorAsync(
      async () =>
        legAllowed(stub.client, {
          deployment: args.deployment,
          at: args.at,
          token: args.token,
          from: args.from,
          to: args.to,
          amount: args.amount,
        }),
      "transfer-not-allowed",
    );
    expect(error.code).toBe("transfer-not-allowed");
    expect(stub.calls.some((c) => c.functionName === "checkLimit")).toBe(false);
  });

  test("contract revert maps through the protocol table", async () => {
    const stub = makeFlowStub({
      calls: table({ revert: errorString("Fiat24Token: all account transfers are paused") }),
    });
    const error = await expectErrorAsync(async () => legAllowed(stub.client, args), "unavailable");
    expect(error.detail.reason).toBe("account-paused");
  });
});

describe("deskOwner", () => {
  test("reads ownerOf at the block", async () => {
    const stub = makeFlowStub({
      calls: new Map([
        [`${ACCOUNT.toLowerCase()}:ownerOf`, [{ args: [9102n], answer: { result: RECIPIENT } }]],
      ]),
    });
    const owner = await deskOwner(stub.client, {
      deployment: DEPLOYMENT,
      at: AT,
      tokenId: 9102n,
    });
    expect(owner).toBe(RECIPIENT);
    const read = stub.calls.find((c) => c.functionName === "ownerOf");
    expect(read?.blockTag).toBe(B_HEX);
  });
});

describe("supplyBound", () => {
  test("amount above total supply ⇒ unlimited-approval", async () => {
    const cases: ReadonlyArray<{
      readonly asset: "EUR24" | "USDC" | "F24";
      readonly address: string;
    }> = [
      { asset: "EUR24", address: TOKEN.toLowerCase() },
      { asset: "USDC", address: C.usdc.toLowerCase() },
      { asset: "F24", address: C.f24.address.toLowerCase() },
    ];
    await Promise.all(
      cases.map(async ({ asset, address }) => {
        const stub = makeFlowStub({
          calls: new Map([[`${address}:totalSupply`, [{ answer: { result: AMOUNT - 1n } }]]]),
        });
        const error = await expectErrorAsync(
          async () =>
            supplyBound(stub.client, {
              deployment: DEPLOYMENT,
              at: AT,
              asset,
              amount: AMOUNT,
            }),
          "unlimited-approval",
        );
        expect(error.code).toBe("unlimited-approval");
      }),
    );
  });

  test("amount within total supply passes", async () => {
    const stub = makeFlowStub({
      calls: new Map([[`${TOKEN.toLowerCase()}:totalSupply`, [{ answer: { result: AMOUNT } }]]]),
    });
    await supplyBound(stub.client, {
      deployment: DEPLOYMENT,
      at: AT,
      asset: "EUR24",
      amount: AMOUNT,
    });
    expect(stub.calls).toHaveLength(1);
  });
});
