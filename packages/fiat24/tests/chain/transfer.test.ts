import { encodeErrorResult, getAddress, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { checkTransfer } from "../../src/chain/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { B, B_HEX, expectErrorAsync, makeStub, OWNER, RECIPIENT, THIRD } from "./stub.ts";
import type { CallEntry } from "./stub.ts";

const ACCOUNT = C.account.proxy;
const TOKEN = C.tokens.EUR24.proxy;
const SENDER_ID = 350273n;
const RECEIVER_ID = 402001n;

function errorString(text: string): Hex {
  return encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }] as const,
    errorName: "Error",
    args: [text],
  });
}

type PartyOpts = {
  readonly historic?: bigint;
  readonly balance?: bigint;
  readonly indexId?: bigint;
  readonly exists?: boolean;
  readonly statusIndex?: number;
  readonly owner?: Address;
};

function push(table: Map<string, CallEntry[]>, key: string, entry: CallEntry): void {
  const prev = table.get(key);
  if (prev === undefined) {
    table.set(key, [entry]);
  } else {
    prev.push(entry);
  }
}

/**
 * Entries for `resolveAccount(client, deployment, B, who)` in issue order:
 * historicOwnership+balanceOf concurrently, [tokenOfOwnerByIndex], exists, then the round
 * (status/limit/limitTourist/walletProvider + ownerOf/getApproved when exists). Per-token reads are
 * keyed on the id the resolution resolves to.
 */
function partyEntries(who: Address, opts: PartyOpts): Map<string, CallEntry[]> {
  const entries = new Map<string, CallEntry[]>();
  const key = (fn: string) => `${ACCOUNT.toLowerCase()}:${fn}`;
  const historic = opts.historic ?? 0n;
  const balance = opts.balance ?? 1n;
  const readId = historic === 0n ? (opts.indexId ?? 0n) : historic;
  const exists = opts.exists ?? true;

  push(entries, key("historicOwnership"), { args: [who], answer: { result: historic } });
  push(entries, key("balanceOf"), { args: [who], answer: { result: balance } });
  // No resolution ⇒ resolveAccount returns before reading anything else; queuing
  // entries here would misorder the other party's same-key reads.
  if (historic === 0n && balance === 0n) {
    return entries;
  }
  if (historic === 0n) {
    push(entries, key("tokenOfOwnerByIndex"), {
      args: [who, 0n],
      answer: { result: readId },
    });
  }
  push(entries, key("exists"), { args: [readId], answer: { result: exists } });
  push(entries, key("status"), {
    args: [readId],
    answer: { result: opts.statusIndex ?? 5 },
  });
  push(entries, key("limit"), {
    args: [readId],
    answer: { result: [0n, 10_000n, 0n] },
  });
  push(entries, key("limitTourist"), { answer: { result: 400n } });
  push(entries, key("walletProvider"), { args: [readId], answer: { result: 0n } });
  if (exists) {
    push(entries, key("ownerOf"), {
      args: [readId],
      answer: { result: opts.owner ?? who },
    });
    push(entries, key("getApproved"), { args: [readId], answer: { result: zeroAddress } });
  }
  return entries;
}

function merge(...tables: Array<Map<string, CallEntry[]>>): Map<string, CallEntry[]> {
  const out = new Map<string, CallEntry[]>();
  for (const table of tables) {
    for (const [k, v] of table) {
      const prev = out.get(k);
      if (prev === undefined) {
        out.set(k, [...v]);
      } else {
        prev.push(...v);
      }
    }
  }
  return out;
}

function transferStub(opts: {
  readonly sender?: PartyOpts;
  readonly receiver?: PartyOpts;
  readonly balance?: bigint;
  readonly allowed?: boolean;
  readonly chf?: bigint;
  readonly withinLimit?: boolean;
  readonly allowedAnswer?: CallEntry["answer"];
  readonly receiverResolution?: Map<string, CallEntry[]>;
}) {
  const amount = 100n;
  const calls = merge(
    opts.receiverResolution ?? new Map(),
    partyEntries(OWNER, opts.sender ?? { historic: SENDER_ID }),
    partyEntries(RECIPIENT, opts.receiver ?? { historic: RECEIVER_ID }),
  );
  calls.set(`${TOKEN.toLowerCase()}:balanceOf`, [
    { args: [OWNER], answer: { result: opts.balance ?? 1000n } },
  ]);
  calls.set(`${TOKEN.toLowerCase()}:tokenTransferAllowed`, [
    {
      args: [OWNER, RECIPIENT, amount],
      answer: opts.allowedAnswer ?? { result: opts.allowed ?? true },
    },
  ]);
  calls.set(`${TOKEN.toLowerCase()}:convertToChf`, [
    { args: [amount], answer: { result: opts.chf ?? 100n } },
  ]);
  calls.set(`${ACCOUNT.toLowerCase()}:checkLimit`, [
    { args: [SENDER_ID, opts.chf ?? 100n], answer: { result: opts.withinLimit ?? true } },
  ]);
  return makeStub({ blockNumber: B, timestamp: 1_700_000_000n, calls });
}

const ARGS = {
  from: OWNER,
  to: { address: RECIPIENT },
  currency: "EUR24" as const,
  amount: 100n,
  blockNumber: B,
};

describe("checkTransfer", () => {
  test("the happy path returns the resolved recipient and block", async () => {
    const stub = transferStub({});
    const check = await checkTransfer(stub.client, ARGS);
    expect(check).toStrictEqual({
      recipient: getAddress(RECIPIENT),
      recipientTokenId: RECEIVER_ID,
      blockNumber: B,
    });
    for (const call of stub.calls) {
      expect(call.blockTag).toBe(B_HEX);
    }
    const transferAllowed = stub.calls.find((c) => c.functionName === "tokenTransferAllowed");
    expect(transferAllowed?.to).toBe(TOKEN);
    expect(transferAllowed?.args).toStrictEqual([getAddress(OWNER), getAddress(RECIPIENT), 100n]);
  });

  test("{tokenId} resolves through exists + ownerOf before the rounds", async () => {
    const stub = transferStub({
      receiverResolution: new Map([
        [`${ACCOUNT.toLowerCase()}:exists`, [{ args: [RECEIVER_ID], answer: { result: true } }]],
        [
          `${ACCOUNT.toLowerCase()}:ownerOf`,
          [{ args: [RECEIVER_ID], answer: { result: RECIPIENT } }],
        ],
      ]),
    });
    const check = await checkTransfer(stub.client, {
      ...ARGS,
      to: { tokenId: RECEIVER_ID },
    });
    expect(check.recipient).toBe(getAddress(RECIPIENT));
    expect(check.recipientTokenId).toBe(RECEIVER_ID);
    const firstExists = stub.calls.findIndex((c) => c.functionName === "exists");
    const firstHistoric = stub.calls.findIndex((c) => c.functionName === "historicOwnership");
    expect(firstExists).toBeGreaterThanOrEqual(0);
    expect(firstExists).toBeLessThan(firstHistoric);
  });

  test("{tokenId} with exists=false is no-account", async () => {
    expect.hasAssertions();
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [`${ACCOUNT.toLowerCase()}:exists`, [{ args: [RECEIVER_ID], answer: { result: false } }]],
      ]),
    });
    await expectErrorAsync(
      async () => checkTransfer(stub.client, { ...ARGS, to: { tokenId: RECEIVER_ID } }),
      "no-account",
    );
  });

  // step 0 — the builders' own local refusals.
  test("zero and deployment recipient addresses are invalid-address before I/O", async () => {
    const stub = transferStub({});
    await expectErrorAsync(
      async () => checkTransfer(stub.client, { ...ARGS, to: { address: zeroAddress } }),
      "invalid-address",
    );
    await expectErrorAsync(
      async () => checkTransfer(stub.client, { ...ARGS, to: { address: C.account.proxy } }),
      "invalid-address",
    );
    expect(stub.requests).toStrictEqual([]);
  });

  test("an internal-account tokenId is refused by the builder", async () => {
    const stub = transferStub({});
    await expectErrorAsync(
      async () => checkTransfer(stub.client, { ...ARGS, to: { tokenId: 9103n } }),
      "internal-account",
    );
    expect(stub.requests).toStrictEqual([]);
  });

  test("a malformed sender address is invalid-address", async () => {
    expect.hasAssertions();
    const stub = transferStub({});
    await expectErrorAsync(
      async () => checkTransfer(stub.client, { ...ARGS, from: "0x1234" }),
      "invalid-address",
    );
    expect(stub.requests).toStrictEqual([]);
  });

  test("a malformed to shape is invalid-argument, never a TypeError", async () => {
    expect.hasAssertions();
    const stub = transferStub({});
    const bad = [
      5,
      null,
      "0x1234",
      {},
      { address: RECIPIENT, tokenId: RECEIVER_ID },
      { tokenId: "402001" },
    ];
    await Promise.all(
      bad.map(async (to) =>
        expectErrorAsync(
          async () => checkTransfer(stub.client, { ...ARGS, to: to as never }),
          "invalid-argument",
        ),
      ),
    );
    expect(stub.requests).toStrictEqual([]);
  });

  // steps 2+3
  test("a sender without an account is no-account", async () => {
    expect.hasAssertions();
    const stub = transferStub({ sender: { historic: 0n, balance: 0n } });
    await expectErrorAsync(async () => checkTransfer(stub.client, ARGS), "no-account");
  });

  test("a non-live sender is not-live", async () => {
    expect.hasAssertions();
    const stub = transferStub({ sender: { historic: SENDER_ID, statusIndex: 3 } });
    await expectErrorAsync(async () => checkTransfer(stub.client, ARGS), "not-live");
  });

  test("a recipient without an account is recipient-not-live", async () => {
    expect.hasAssertions();
    const stub = transferStub({ receiver: { historic: 0n, balance: 0n } });
    await expectErrorAsync(async () => checkTransfer(stub.client, ARGS), "recipient-not-live");
  });

  test("a recipient resolving to an internal desk is internal-account", async () => {
    expect.hasAssertions();
    const stub = transferStub({ receiver: { historic: 9103n } });
    await expectErrorAsync(async () => checkTransfer(stub.client, ARGS), "internal-account");
  });

  test("a stale historic recipient (ownsToken false via historic) is stale-recipient", async () => {
    expect.hasAssertions();
    const stub = transferStub({ receiver: { historic: RECEIVER_ID, owner: THIRD } });
    await expectErrorAsync(async () => checkTransfer(stub.client, ARGS), "stale-recipient");
  });

  test("a non-live recipient is recipient-not-live; soft-blocked passes", async () => {
    const blocked = transferStub({
      receiver: { historic: RECEIVER_ID, statusIndex: 3 },
    });
    await expectErrorAsync(async () => checkTransfer(blocked.client, ARGS), "recipient-not-live");
    const softBlocked = transferStub({
      receiver: { historic: RECEIVER_ID, statusIndex: 1 },
    });
    const check = await checkTransfer(softBlocked.client, ARGS);
    expect(check.recipient).toBe(getAddress(RECIPIENT));
  });

  // step 4
  test("balance below amount is insufficient-balance", async () => {
    expect.hasAssertions();
    const stub = transferStub({ balance: 99n });
    await expectErrorAsync(async () => checkTransfer(stub.client, ARGS), "insufficient-balance");
  });

  // step 5
  test("tokenTransferAllowed=false + checkLimit false ⇒ limit-exceeded", async () => {
    const stub = transferStub({ allowed: false, withinLimit: false });
    await expectErrorAsync(async () => checkTransfer(stub.client, ARGS), "limit-exceeded");
    const chfCall = stub.calls.find((c) => c.functionName === "convertToChf");
    expect(chfCall?.args).toStrictEqual([100n]);
    const limitCall = stub.calls.find((c) => c.functionName === "checkLimit");
    expect(limitCall?.args).toStrictEqual([SENDER_ID, 100n]);
  });

  test("tokenTransferAllowed=false + checkLimit true ⇒ transfer-not-allowed", async () => {
    expect.hasAssertions();
    const stub = transferStub({ allowed: false, withinLimit: true });
    await expectErrorAsync(async () => checkTransfer(stub.client, ARGS), "transfer-not-allowed");
  });

  test("an Error(string) pause revert maps through §6.3 to unavailable/account-paused", async () => {
    const stub = transferStub({
      allowedAnswer: {
        revert: errorString("Fiat24Token: all account transfers are paused"),
      },
    });
    const error = await expectErrorAsync(
      async () => checkTransfer(stub.client, ARGS),
      "unavailable",
    );
    expect(error.detail.reason).toBe("account-paused");
  });

  test("a custom-error revert maps through §6.3 (deposit paused ⇒ deposit-paused)", async () => {
    const data = encodeErrorResult({
      abi: [{ type: "error", name: "Fiat24CryptoDeposit__Paused", inputs: [] }] as const,
      errorName: "Fiat24CryptoDeposit__Paused",
    });
    const stub = transferStub({ allowedAnswer: { revert: data } });
    const error = await expectErrorAsync(
      async () => checkTransfer(stub.client, ARGS),
      "unavailable",
    );
    expect(error.detail.reason).toBe("deposit-paused");
  });

  test("a non-revert failure at tokenTransferAllowed stays rpc-error", async () => {
    expect.hasAssertions();
    const stub = transferStub({
      allowedAnswer: { thrown: { code: -32000, message: "boom" } },
    });
    await expectErrorAsync(async () => checkTransfer(stub.client, ARGS), "rpc-error");
  });
});
