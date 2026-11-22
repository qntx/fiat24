import { encodeAbiParameters, numberToHex, pad, toEventSelector } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import { getPayoutMinimum, getPayoutSettlement } from "../../src/chain/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { B, B_HEX, expectErrorAsync, makeStub, OWNER } from "./stub.ts";

const TOKEN = C.tokens.EUR24.proxy;
const TOKEN_ID = 350273n;

const cashPayoutEvent = tokenAbi.find(
  (e): e is Extract<(typeof tokenAbi)[number], { type: "event" }> =>
    e.type === "event" && e.name === "CashPayout",
);
if (cashPayoutEvent === undefined) {
  throw new Error("CashPayout not in tokenAbi");
}
const TOPIC0 = toEventSelector(cashPayoutEvent);

type RawFilter = {
  address?: string | string[];
  topics?: unknown[];
  fromBlock?: string;
  toBlock?: string;
};

function payoutLog(opts: {
  readonly tokenId?: bigint;
  readonly sender?: Address;
  readonly payoutAccount?: bigint;
  readonly bankId?: string;
  readonly trxId?: string;
  readonly blockNumber?: bigint;
  readonly txHash?: Hex;
  readonly logIndex?: string;
}) {
  const topics: Hex[] = [
    TOPIC0,
    numberToHex(opts.tokenId ?? TOKEN_ID, { size: 32 }),
    pad(opts.sender ?? OWNER, { size: 32 }).toLowerCase() as Hex,
  ];
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "string" }, { type: "string" }],
    [opts.payoutAccount ?? 9104n, opts.bankId ?? "CH", opts.trxId ?? "trx-1"],
  );
  return {
    address: TOKEN,
    topics,
    data,
    blockNumber: `0x${(opts.blockNumber ?? B - 5n).toString(16)}`,
    transactionHash: opts.txHash ?? `0x${"11".repeat(32)}`,
    logIndex: opts.logIndex ?? "0x0",
  };
}

function settlementStub(logsByFilter: (f: RawFilter) => unknown) {
  return makeStub({
    blockNumber: B,
    logs: (f) => logsByFilter(f),
  });
}

const SETTLE_ARGS = {
  currency: "EUR24" as const,
  tokenId: TOKEN_ID,
  contactId: "CH",
  txid: "trx-1",
  fromBlock: B - 10n,
  blockNumber: B,
};

describe("getPayoutMinimum", () => {
  test("reads minimalPayoutAmount on the payout token at B", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [`${TOKEN.toLowerCase()}:minimalPayoutAmount`, { answer: { result: 500n } }],
      ]),
    });
    await expect(
      getPayoutMinimum(stub.client, { currency: "EUR24", blockNumber: B }),
    ).resolves.toBe(500n);
    expect(stub.calls[0]?.to).toBe(TOKEN);
    expect(stub.calls[0]?.blockTag).toBe(B_HEX);
  });

  test("CHF24 resolves to the CHF24 token", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [`${C.tokens.CHF24.proxy.toLowerCase()}:minimalPayoutAmount`, { answer: { result: 600n } }],
      ]),
    });
    await expect(
      getPayoutMinimum(stub.client, { currency: "CHF24", blockNumber: B }),
    ).resolves.toBe(600n);
    expect(stub.calls[0]?.to).toBe(C.tokens.CHF24.proxy);
  });

  test("a non-payout currency is unsupported-currency before I/O", async () => {
    const stub = makeStub({ blockNumber: B });
    await expectErrorAsync(
      async () =>
        getPayoutMinimum(stub.client, {
          currency: "USD24" as never,
          blockNumber: B,
        }),
      "unsupported-currency",
    );
    expect(stub.calls).toStrictEqual([]);
  });
});

describe("getPayoutSettlement", () => {
  test("the filter is [CashPayout, tokenId] on the token over [fromBlock, B]", async () => {
    const seen: RawFilter[] = [];
    const stub = settlementStub((f) => {
      seen.push(f);
      return [];
    });
    const result = await getPayoutSettlement(stub.client, SETTLE_ARGS);
    expect(result).toStrictEqual({ status: "pending", blockNumber: B });
    expect(seen).toStrictEqual([
      {
        address: TOKEN,
        topics: [TOPIC0, numberToHex(TOKEN_ID, { size: 32 })],
        fromBlock: `0x${(B - 10n).toString(16)}`,
        toBlock: B_HEX,
      },
    ]);
  });

  test("a matching settled event settles", async () => {
    const stub = settlementStub(() => [payoutLog({})]);
    const result = await getPayoutSettlement(stub.client, SETTLE_ARGS);
    expect(result.status).toBe("settled");
    expect(result.blockNumber).toBe(B);
    const { event } = result;
    expect(event).toMatchObject({
      kind: "cash-payout",
      settlement: "settled",
      bankId: "CH",
      trxId: "trx-1",
      tokenId: TOKEN_ID,
    });
  });

  test("payoutAccount 9103 ⇒ rejected", async () => {
    const stub = settlementStub(() => [payoutLog({ payoutAccount: 9103n })]);
    const result = await getPayoutSettlement(stub.client, SETTLE_ARGS);
    expect(result.status).toBe("rejected");
  });

  test("a payoutAccount outside 9103/9104 is invalid-rpc-response", async () => {
    expect.hasAssertions();
    const stub = settlementStub(() => [payoutLog({ payoutAccount: 1n })]);
    await expectErrorAsync(
      async () => getPayoutSettlement(stub.client, SETTLE_ARGS),
      "invalid-rpc-response",
    );
  });

  test("the same log repeated across filters deduplicates to one match", async () => {
    const log = payoutLog({});
    const stub = settlementStub(() => [log, { ...log }]);
    const result = await getPayoutSettlement(stub.client, SETTLE_ARGS);
    expect(result.status).toBe("settled");
  });

  test("two distinct matching logs mean the RPC lied", async () => {
    expect.hasAssertions();
    const stub = settlementStub(() => [
      payoutLog({ txHash: `0x${"11".repeat(32)}` }),
      payoutLog({ txHash: `0x${"22".repeat(32)}` }),
    ]);
    await expectErrorAsync(
      async () => getPayoutSettlement(stub.client, SETTLE_ARGS),
      "invalid-rpc-response",
    );
  });

  test("non-matching logs (other trxId/bankId/tokenId) stay pending", async () => {
    const stub = settlementStub(() => [
      payoutLog({ trxId: "other" }),
      payoutLog({ bankId: "DE" }),
      payoutLog({ tokenId: 999_999n }),
    ]);
    const result = await getPayoutSettlement(stub.client, SETTLE_ARGS);
    expect(result.status).toBe("pending");
  });

  test("chunkSize splits the range into sequential windows", async () => {
    const seen: string[] = [];
    const stub = settlementStub((f) => {
      seen.push(`${f.fromBlock}..${f.toBlock}`);
      return [];
    });
    await getPayoutSettlement(stub.client, {
      ...SETTLE_ARGS,
      fromBlock: B - 250n,
      chunkSize: 100n,
    });
    expect(seen).toStrictEqual([
      `0x${(B - 250n).toString(16)}..0x${(B - 151n).toString(16)}`,
      `0x${(B - 150n).toString(16)}..0x${(B - 51n).toString(16)}`,
      `0x${(B - 50n).toString(16)}..${B_HEX}`,
    ]);
  });

  test("a malformed log payload is invalid-rpc-response", async () => {
    expect.hasAssertions();
    const stub = settlementStub(() => [{ notALog: true }]);
    await expectErrorAsync(
      async () => getPayoutSettlement(stub.client, SETTLE_ARGS),
      "invalid-rpc-response",
    );
  });

  test("a transport failure inside a window is rpc-error naming the bounds", async () => {
    const stub = settlementStub(() => {
      throw Object.assign(new Error("timeout"), { code: -32000 });
    });
    const error = await expectErrorAsync(
      async () => getPayoutSettlement(stub.client, SETTLE_ARGS),
      "rpc-error",
    );
    expect(error.message).toContain(`${(B - 10n).toString()}-${B.toString()}`);
  });

  test("argument validation happens before I/O", async () => {
    expect.hasAssertions();
    const stub = settlementStub(() => []);
    await expectErrorAsync(
      async () => getPayoutSettlement(stub.client, { ...SETTLE_ARGS, contactId: "bad!" }),
      "invalid-argument",
    );
    await expectErrorAsync(
      async () => getPayoutSettlement(stub.client, { ...SETTLE_ARGS, txid: "" }),
      "invalid-argument",
    );
    await expectErrorAsync(
      async () => getPayoutSettlement(stub.client, { ...SETTLE_ARGS, fromBlock: B + 1n }),
      "invalid-argument",
    );
    await expectErrorAsync(
      async () =>
        getPayoutSettlement(stub.client, {
          ...SETTLE_ARGS,
          currency: "USD24" as never,
        }),
      "unsupported-currency",
    );
    await expectErrorAsync(
      async () => getPayoutSettlement(stub.client, { ...SETTLE_ARGS, tokenId: 0n }),
      "invalid-account-id",
    );
    await expectErrorAsync(
      async () => getPayoutSettlement(stub.client, { ...SETTLE_ARGS, tokenId: "350273" as never }),
      "invalid-account-id",
    );
  });
});
