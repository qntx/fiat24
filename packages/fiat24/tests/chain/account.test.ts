import { getAddress, zeroAddress } from "viem";
import type { Address } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { getAccount } from "../../src/chain/index.ts";
import { ibanOf } from "../../src/core/iban.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { B, B_HEX, expectErrorAsync, makeStub, OWNER, RECIPIENT, TOKEN_ID } from "./stub.ts";
import type { CallEntry, CallTable } from "./stub.ts";

const ACCOUNT = C.account.proxy;

type RoundOpts = {
  statusIndex?: number;
  usedLimit?: bigint;
  clientLimit?: bigint;
  startLimitDate?: bigint;
  limitTourist?: bigint;
  walletProvider?: bigint;
  owner?: Address;
  approved?: Address;
  exists?: boolean;
  tokenId?: bigint;
};

/** Call-table entries for the post-resolution round of `getAccount`/`resolveAccount`. */
function accountRound(opts: RoundOpts): CallTable {
  const id = opts.tokenId ?? TOKEN_ID;
  const exists = opts.exists ?? true;
  const entries: Array<readonly [string, CallEntry]> = [
    [`${ACCOUNT.toLowerCase()}:exists`, { args: [id], answer: { result: exists } }],
    [`${ACCOUNT.toLowerCase()}:status`, { args: [id], answer: { result: opts.statusIndex ?? 5 } }],
    [
      `${ACCOUNT.toLowerCase()}:limit`,
      {
        args: [id],
        answer: {
          result: [opts.usedLimit ?? 0n, opts.clientLimit ?? 10_000n, opts.startLimitDate ?? 0n],
        },
      },
    ],
    [`${ACCOUNT.toLowerCase()}:limitTourist`, { answer: { result: opts.limitTourist ?? 400n } }],
    [
      `${ACCOUNT.toLowerCase()}:walletProvider`,
      { args: [id], answer: { result: opts.walletProvider ?? 8026n } },
    ],
  ];
  if (exists) {
    entries.push(
      [`${ACCOUNT.toLowerCase()}:ownerOf`, { args: [id], answer: { result: opts.owner ?? OWNER } }],
      [
        `${ACCOUNT.toLowerCase()}:getApproved`,
        { args: [id], answer: { result: opts.approved ?? zeroAddress } },
      ],
    );
  }
  return new Map(entries);
}

function ownerResolution(historic: bigint, balance: bigint, indexId?: bigint): CallTable {
  const entries: Array<readonly [string, CallEntry]> = [
    [`${ACCOUNT.toLowerCase()}:historicOwnership`, { args: [OWNER], answer: { result: historic } }],
    [`${ACCOUNT.toLowerCase()}:balanceOf`, { args: [OWNER], answer: { result: balance } }],
  ];
  if (indexId !== undefined) {
    entries.push([
      `${ACCOUNT.toLowerCase()}:tokenOfOwnerByIndex`,
      { args: [OWNER, 0n], answer: { result: indexId } },
    ]);
  }
  return new Map(entries);
}

function merge(...tables: CallTable[]): CallTable {
  const out = new Map();
  for (const t of tables) {
    for (const [k, v] of t) {
      out.set(k, v);
    }
  }
  return out;
}

describe("getAccount({owner})", () => {
  test("historicOwnership hit resolves the id and reads the full round at B", async () => {
    const stub = makeStub({
      blockNumber: B,
      timestamp: 1_700_000_000n,
      calls: merge(
        ownerResolution(TOKEN_ID, 1n),
        accountRound({ statusIndex: 5, walletProvider: 8026n }),
      ),
    });
    const account = await getAccount(stub.client, { owner: OWNER, blockNumber: B });
    expect(account?.tokenId).toBe(TOKEN_ID);
    expect(account?.status).toBe("live");
    expect(account?.ownsToken).toBe(true);
    expect(account?.owner).toBe(getAddress(OWNER));
    expect(account?.walletProvider).toBe(8026n);
    expect(account?.approved).toBeUndefined();
    expect(account?.iban).toBe(ibanOf(TOKEN_ID));
    expect(account?.blockNumber).toBe(B);
    for (const call of stub.calls) {
      expect(call.blockTag).toBe(B_HEX);
    }
    const methods = stub.requests.map((r) => r.method);
    expect(methods).toContain("eth_getBlockByNumber");
  });

  test("balance-only walk-in resolves via tokenOfOwnerByIndex with status tourist", async () => {
    const stub = makeStub({
      blockNumber: B,
      timestamp: 1_700_000_000n,
      calls: merge(
        ownerResolution(0n, 1n, TOKEN_ID),
        // The stored status is Live (5), but the resolved status must be the
        // walk-in "tourist" (Fiat24Token.sol:172-180).
        accountRound({ statusIndex: 5 }),
      ),
    });
    const account = await getAccount(stub.client, { owner: OWNER, blockNumber: B });
    expect(account?.tokenId).toBe(TOKEN_ID);
    expect(account?.status).toBe("tourist");
    // limit.max uses the STORED status (Live ⇒ clientLimit, not limitTourist).
    expect(account?.limit.max).toBe(10_000n);
  });

  test("stored Tourist status picks limitTourist even on the historic path", async () => {
    const stub = makeStub({
      blockNumber: B,
      timestamp: 1_700_000_000n,
      calls: merge(
        ownerResolution(TOKEN_ID, 1n),
        accountRound({ statusIndex: 2, clientLimit: 10_000n, limitTourist: 400n }),
      ),
    });
    const account = await getAccount(stub.client, { owner: OWNER, blockNumber: B });
    expect(account?.status).toBe("tourist");
    expect(account?.limit.max).toBe(400n);
  });

  test("no tokens at all resolves undefined", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: ownerResolution(0n, 0n),
    });
    await expect(
      getAccount(stub.client, { owner: OWNER, blockNumber: B }),
    ).resolves.toBeUndefined();
  });

  test("exists(id) false keeps the account with ownsToken=false and skips ownerOf/getApproved", async () => {
    const stub = makeStub({
      blockNumber: B,
      timestamp: 1_700_000_000n,
      calls: merge(ownerResolution(TOKEN_ID, 1n), accountRound({ exists: false })),
    });
    const account = await getAccount(stub.client, { owner: OWNER, blockNumber: B });
    expect(account?.ownsToken).toBe(false);
    expect(account?.owner).toBe(zeroAddress);
    expect(account?.approved).toBeUndefined();
    const names = stub.calls.map((c) => c.functionName);
    expect(names).not.toContain("ownerOf");
    expect(names).not.toContain("getApproved");
  });

  test("ownsToken is false when ownerOf answers a different address", async () => {
    const stub = makeStub({
      blockNumber: B,
      timestamp: 1_700_000_000n,
      calls: merge(ownerResolution(TOKEN_ID, 1n), accountRound({ owner: RECIPIENT })),
    });
    const account = await getAccount(stub.client, { owner: OWNER, blockNumber: B });
    expect(account?.ownsToken).toBe(false);
    expect(account?.owner).toBe(getAddress(RECIPIENT));
  });

  test("a non-zero getApproved surfaces checksummed", async () => {
    const stub = makeStub({
      blockNumber: B,
      timestamp: 1_700_000_000n,
      calls: merge(ownerResolution(TOKEN_ID, 1n), accountRound({ approved: RECIPIENT })),
    });
    const account = await getAccount(stub.client, { owner: OWNER, blockNumber: B });
    expect(account?.approved).toBe(getAddress(RECIPIENT));
  });

  test("used zeroes only after the full 30-day period (strict <)", async () => {
    const start = 100n;
    const within = makeStub({
      blockNumber: B,
      timestamp: start + 2_592_000n, // periodEnd == timestamp ⇒ used kept
      calls: merge(
        ownerResolution(TOKEN_ID, 1n),
        accountRound({ usedLimit: 42n, startLimitDate: start }),
      ),
    });
    const a1 = await getAccount(within.client, { owner: OWNER, blockNumber: B });
    expect(a1?.limit.used).toBe(42n);
    expect(a1?.limit.periodStart).toBe(start);
    expect(a1?.limit.periodEnd).toBe(start + 2_592_000n);

    const after = makeStub({
      blockNumber: B,
      timestamp: start + 2_592_001n, // periodEnd < timestamp ⇒ used = 0
      calls: merge(
        ownerResolution(TOKEN_ID, 1n),
        accountRound({ usedLimit: 42n, startLimitDate: start }),
      ),
    });
    const a2 = await getAccount(after.client, { owner: OWNER, blockNumber: B });
    expect(a2?.limit.used).toBe(0n);
  });

  test("iban is undefined for tokenId >= 10^11", async () => {
    const big = 10n ** 11n;
    const stub = makeStub({
      blockNumber: B,
      timestamp: 1_700_000_000n,
      calls: merge(ownerResolution(big, 1n), accountRound({ tokenId: big })),
    });
    const account = await getAccount(stub.client, { owner: OWNER, blockNumber: B });
    expect(account?.tokenId).toBe(big);
    expect(account?.iban).toBeUndefined();
  });

  test("an out-of-range status index maps to invalid-rpc-response", async () => {
    expect.hasAssertions();
    const stub = makeStub({
      blockNumber: B,
      timestamp: 1_700_000_000n,
      calls: merge(ownerResolution(TOKEN_ID, 1n), accountRound({ statusIndex: 6 })),
    });
    await expectErrorAsync(
      async () => getAccount(stub.client, { owner: OWNER, blockNumber: B }),
      "invalid-rpc-response",
    );
  });
});

describe("getAccount({tokenId})", () => {
  test("exists false resolves undefined", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: accountRound({ exists: false }),
    });
    await expect(
      getAccount(stub.client, { tokenId: TOKEN_ID, blockNumber: B }),
    ).resolves.toBeUndefined();
    const names = stub.calls.map((c) => c.functionName);
    expect(names).toStrictEqual(["exists"]);
  });

  test("exists true resolves ownsToken=true with ownerOf", async () => {
    const stub = makeStub({
      blockNumber: B,
      timestamp: 1_700_000_000n,
      calls: accountRound({ owner: RECIPIENT }),
    });
    const account = await getAccount(stub.client, { tokenId: TOKEN_ID, blockNumber: B });
    expect(account?.ownsToken).toBe(true);
    expect(account?.owner).toBe(getAddress(RECIPIENT));
    expect(account?.status).toBe("live");
  });

  test("an invalid tokenId rejects before any I/O", async () => {
    const stub = makeStub({ blockNumber: B, calls: accountRound({}) });
    await expectErrorAsync(
      async () => getAccount(stub.client, { tokenId: 0n, blockNumber: B }),
      "invalid-account-id",
    );
    expect(stub.requests).toStrictEqual([]);
  });
});

const nullBlock = (method: string): unknown =>
  method === "eth_getBlockByNumber" ? null : undefined;

describe("getAccount hostile input", () => {
  test("a non-address owner is invalid-address", async () => {
    expect.hasAssertions();
    const stub = makeStub({ blockNumber: B, calls: accountRound({}) });
    await expectErrorAsync(
      async () => getAccount(stub.client, { owner: "0x1234", blockNumber: B }),
      "invalid-address",
    );
  });

  test("a non-bigint tokenId is invalid-account-id", async () => {
    expect.hasAssertions();
    const stub = makeStub({ blockNumber: B, calls: accountRound({}) });
    await expectErrorAsync(
      async () => getAccount(stub.client, { tokenId: "402001" as never, blockNumber: B }),
      "invalid-account-id",
    );
  });

  test("a null eth_getBlockByNumber result maps through viem to rpc-error", async () => {
    expect.hasAssertions();
    const stub = makeStub({
      blockNumber: B,
      timestamp: 1_700_000_000n,
      calls: merge(ownerResolution(TOKEN_ID, 1n), accountRound({})),
      onRequest: nullBlock,
    });
    await expectErrorAsync(
      async () => getAccount(stub.client, { owner: OWNER, blockNumber: B }),
      "rpc-error",
    );
  });
});
