import { encodeAbiParameters, getAddress, numberToHex, pad, toEventSelector } from "viem";
import type { AbiEvent, Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { accountAbi, cardAbi, depositAbi, tokenAbi } from "../../src/abi/index.ts";
import { getHistory } from "../../src/chain/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { B, expectErrorAsync, makeStub, OWNER, THIRD } from "./stub.ts";

const TOKEN_ADDRS = [
  C.tokens.USD24.proxy,
  C.tokens.EUR24.proxy,
  C.tokens.CHF24.proxy,
  C.tokens.CNH24.proxy,
];

function eventTopic(abi: ReadonlyArray<{ type: string; name?: string }>, name: string): Hex {
  const event = abi.find((e) => e.type === "event" && e.name === name);
  if (event === undefined) {
    throw new Error(`${name} missing`);
  }
  return toEventSelector(event as AbiEvent);
}

const ownerTopic = pad(OWNER, { size: 32 }).toLowerCase() as Hex;
const T_ID = 350273n;
const idTopic = numberToHex(T_ID, { size: 32 });

const transferT0 = eventTopic(tokenAbi, "Transfer");
const clientPayoutT0 = eventTopic(tokenAbi, "ClientPayout");
const clientPayoutRefT0 = eventTopic(tokenAbi, "ClientPayoutRef");
const cashPayoutT0 = eventTopic(tokenAbi, "CashPayout");
const cashDepositT0 = eventTopic(tokenAbi, "CashDeposit");
const cashDepositNokT0 = eventTopic(tokenAbi, "CashDepositNOK");

const exchangedInT0 = eventTopic(depositAbi, "MoneyExchangedExactIn");
const exchangedOutT0 = eventTopic(depositAbi, "MoneyExchangedExactOut");
const depositedUsdT0 = eventTopic(depositAbi, "DepositedTokenViaUsd");
const depositedEthT0 = eventTopic(depositAbi, "DepositedEth");
const depositedViaEthT0 = eventTopic(depositAbi, "DepositedTokenViaEth");
const depositedByWalletT0 = eventTopic(depositAbi, "DepositedByWallet");
const accountTransferT0 = eventTopic(accountAbi, "Transfer");
const cardT0s = ["Authorized", "Incremented", "Adviced", "Reversed"].map((n) =>
  eventTopic(cardAbi, n),
);

type RawFilter = {
  address?: string | string[];
  topics?: unknown[];
  fromBlock?: string;
  toBlock?: string;
};

/** H2 (inbound transfers) answers two events out of order plus an exact duplicate. */
function inboundTransfers(f: Record<string, unknown>): unknown[] {
  const { topics } = f;
  const isInbound = Array.isArray(topics) && topics[0] === transferT0 && topics[1] === null;
  return isInbound
    ? [
        transferLog({ blockNumber: B - 20n, txHash: `0x${"bb".repeat(32)}` }),
        transferLog({ blockNumber: B - 30n, txHash: `0x${"cc".repeat(32)}`, logIndex: "0x5" }),
        // identical txHash:logIndex — deduplicates against the entry above.
        transferLog({ blockNumber: B - 30n, txHash: `0x${"cc".repeat(32)}`, logIndex: "0x5" }),
        transferLog({ blockNumber: B - 30n, txHash: `0x${"cc".repeat(32)}`, logIndex: "0x2" }),
      ]
    : [];
}

function collect(): { stub: ReturnType<typeof makeStub>; seen: RawFilter[] } {
  const seen: RawFilter[] = [];
  const stub = makeStub({
    blockNumber: B,
    logs: (f) => {
      seen.push(f);
      return [];
    },
  });
  return { stub, seen };
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

function transferLog(opts: {
  readonly token?: Address;
  readonly from?: Address;
  readonly to?: Address;
  readonly amount?: bigint;
  readonly blockNumber?: bigint;
  readonly txHash?: Hex;
  readonly logIndex?: string;
}) {
  return {
    address: opts.token ?? C.tokens.EUR24.proxy,
    topics: [
      transferT0,
      pad(opts.from ?? THIRD, { size: 32 }).toLowerCase() as Hex,
      pad(opts.to ?? OWNER, { size: 32 }).toLowerCase() as Hex,
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [opts.amount ?? 42n]),
    blockNumber: hex(opts.blockNumber ?? B - 10n),
    transactionHash: opts.txHash ?? `0x${"aa".repeat(32)}`,
    logIndex: opts.logIndex ?? "0x0",
  };
}

describe("getHistory", () => {
  test("owner-only issues the five H1-H5 filters in one window at [from, to]", async () => {
    const { stub, seen } = collect();
    const events = await getHistory(stub.client, {
      owner: OWNER,
      fromBlock: B - 50n,
      toBlock: B - 10n,
      blockNumber: B,
    });
    expect(events).toStrictEqual([]);
    expect(seen).toStrictEqual([
      {
        address: TOKEN_ADDRS,
        topics: [transferT0, ownerTopic],
        fromBlock: hex(B - 50n),
        toBlock: hex(B - 10n),
      },
      {
        address: TOKEN_ADDRS,
        topics: [transferT0, null, ownerTopic],
        fromBlock: hex(B - 50n),
        toBlock: hex(B - 10n),
      },
      {
        address: TOKEN_ADDRS,
        topics: [[clientPayoutT0, clientPayoutRefT0, cashPayoutT0], null, ownerTopic],
        fromBlock: hex(B - 50n),
        toBlock: hex(B - 10n),
      },
      {
        address: TOKEN_ADDRS,
        topics: [cashDepositT0, null, ownerTopic],
        fromBlock: hex(B - 50n),
        toBlock: hex(B - 10n),
      },
      {
        address: C.deposit.proxy,
        topics: [
          [exchangedInT0, exchangedOutT0, depositedUsdT0, depositedEthT0, depositedViaEthT0],
          ownerTopic,
        ],
        fromBlock: hex(B - 50n),
        toBlock: hex(B - 10n),
      },
    ]);
  });

  test("tokenId adds the four H6-H9 filters", async () => {
    const { stub, seen } = collect();
    await getHistory(stub.client, {
      owner: OWNER,
      tokenId: T_ID,
      fromBlock: B - 50n,
      toBlock: B - 10n,
      blockNumber: B,
    });
    expect(seen.slice(5)).toStrictEqual([
      {
        address: C.card.proxy,
        topics: [cardT0s, idTopic],
        fromBlock: hex(B - 50n),
        toBlock: hex(B - 10n),
      },
      {
        address: C.account.proxy,
        topics: [accountTransferT0, null, null, idTopic],
        fromBlock: hex(B - 50n),
        toBlock: hex(B - 10n),
      },
      {
        address: C.deposit.proxy,
        topics: [depositedByWalletT0, idTopic],
        fromBlock: hex(B - 50n),
        toBlock: hex(B - 10n),
      },
      {
        address: TOKEN_ADDRS,
        topics: [cashDepositNokT0, idTopic],
        fromBlock: hex(B - 50n),
        toBlock: hex(B - 10n),
      },
    ]);
  });

  test("chunkSize splits windows sequentially, all filters per window", async () => {
    const { stub, seen } = collect();
    await getHistory(stub.client, {
      owner: OWNER,
      fromBlock: B - 300n,
      toBlock: B - 1n,
      chunkSize: 100n,
      blockNumber: B,
    });
    // 3 windows × 5 filters; window boundaries sequential.
    expect(seen).toHaveLength(15);
    const bounds = new Set(seen.map((f) => `${f.fromBlock}..${f.toBlock}`));
    expect([...bounds].toSorted()).toStrictEqual(
      [
        `${hex(B - 300n)}..${hex(B - 201n)}`,
        `${hex(B - 200n)}..${hex(B - 101n)}`,
        `${hex(B - 100n)}..${hex(B - 1n)}`,
      ].toSorted(),
    );
  });

  test("default chunkSize is 100_000", async () => {
    const { stub, seen } = collect();
    await getHistory(stub.client, {
      owner: OWNER,
      fromBlock: B - 200_000n,
      toBlock: B,
      blockNumber: B,
    });
    const bounds = new Set(seen.map((f) => `${f.fromBlock}..${f.toBlock}`));
    expect(bounds.size).toBe(3);
    expect(bounds.has(`${hex(B - 200_000n)}..${hex(B - 100_001n)}`)).toBe(true);
    expect(bounds.has(`${hex(B - 100_000n)}..${hex(B - 1n)}`)).toBe(true);
    expect(bounds.has(`${hex(B)}..${hex(B)}`)).toBe(true);
  });

  test("logs decode, deduplicate by txHash:logIndex, and sort by block then index", async () => {
    const stub = makeStub({
      blockNumber: B,
      logs: inboundTransfers,
    });
    const events = await getHistory(stub.client, {
      owner: OWNER,
      fromBlock: B - 50n,
      toBlock: B - 1n,
      blockNumber: B,
    });
    expect(events).toHaveLength(3);
    expect(events[0]?.blockNumber).toBe(B - 30n);
    expect(events[0]?.logIndex).toBe(2);
    expect(events[1]?.blockNumber).toBe(B - 30n);
    expect(events[1]?.logIndex).toBe(5);
    expect(events[2]?.blockNumber).toBe(B - 20n);
    const [first] = events;
    expect(first).toMatchObject({
      kind: "transfer",
      currency: "EUR24",
      from: getAddress(THIRD),
      to: getAddress(OWNER),
      amount: 42n,
    });
  });

  test("validation: bad owner, range, tokenId and chunkSize", async () => {
    expect.hasAssertions();
    const { stub } = collect();
    await expectErrorAsync(
      async () =>
        getHistory(stub.client, {
          owner: "0x1234",
          fromBlock: 0n,
          toBlock: B,
          blockNumber: B,
        }),
      "invalid-address",
    );
    await expectErrorAsync(
      async () =>
        getHistory(stub.client, {
          owner: OWNER,
          fromBlock: 10n,
          toBlock: 9n,
          blockNumber: B,
        }),
      "invalid-argument",
    );
    await expectErrorAsync(
      async () =>
        getHistory(stub.client, {
          owner: OWNER,
          fromBlock: 0n,
          toBlock: B + 1n,
          blockNumber: B,
        }),
      "invalid-argument",
    );
    await expectErrorAsync(
      async () =>
        getHistory(stub.client, {
          owner: OWNER,
          tokenId: 0n,
          fromBlock: 0n,
          toBlock: B,
          blockNumber: B,
        }),
      "invalid-account-id",
    );
    await expectErrorAsync(
      async () =>
        getHistory(stub.client, {
          owner: OWNER,
          fromBlock: 0n,
          toBlock: B,
          chunkSize: 0n,
          blockNumber: B,
        }),
      "invalid-argument",
    );
    await expectErrorAsync(
      async () =>
        getHistory(stub.client, {
          owner: OWNER,
          fromBlock: 0n,
          toBlock: B,
          chunkSize: 10_000_001n,
          blockNumber: B,
        }),
      "invalid-argument",
    );
  });

  test("a non-bigint tokenId is invalid-account-id", async () => {
    expect.hasAssertions();
    const { stub } = collect();
    await expectErrorAsync(
      async () =>
        getHistory(stub.client, {
          owner: OWNER,
          tokenId: "350273" as never,
          fromBlock: 0n,
          toBlock: 1n,
          blockNumber: B,
        }),
      "invalid-account-id",
    );
  });
});

describe("hostile eth_getLogs payloads", () => {
  const BASE_LOG = {
    address: C.tokens.EUR24.proxy,
    topics: [transferT0, ownerTopic, ownerTopic],
    data: `0x${"0".repeat(63)}1`,
    blockNumber: "0x1",
    transactionHash: `0x${"aa".repeat(32)}`,
    logIndex: "0x0",
  };

  const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
    ["a non-object entry", "garbage"],
    ["a non-word topic", { ...BASE_LOG, topics: ["0x12"] }],
    ["non-hex data", { ...BASE_LOG, data: 42 }],
    ["a bad blockNumber", { ...BASE_LOG, blockNumber: "0xzz" }],
    ["a bad logIndex", { ...BASE_LOG, logIndex: "junk" }],
    ["an unsafe logIndex", { ...BASE_LOG, logIndex: `0x${"f".repeat(16)}` }],
    ["a bad transactionHash", { ...BASE_LOG, transactionHash: "0x12" }],
  ];

  test.each(MALFORMED)("a log with %s is invalid-rpc-response", async (_name, log) => {
    expect.hasAssertions();
    const stub = makeStub({ blockNumber: B, logs: () => [log] });
    await expectErrorAsync(
      async () =>
        getHistory(stub.client, { owner: OWNER, fromBlock: 0n, toBlock: 1n, blockNumber: B }),
      "invalid-rpc-response",
    );
  });

  test("a pending log with null position fields is malformed-log", async () => {
    expect.hasAssertions();
    const stub = makeStub({
      blockNumber: B,
      logs: () => [{ ...BASE_LOG, blockNumber: null, transactionHash: null, logIndex: null }],
    });
    await expectErrorAsync(
      async () =>
        getHistory(stub.client, { owner: OWNER, fromBlock: 0n, toBlock: 1n, blockNumber: B }),
      "malformed-log",
    );
  });

  test("a log with an unknown topic0 is ignored", async () => {
    const stub = makeStub({
      blockNumber: B,
      logs: () => [{ ...BASE_LOG, topics: [`0x${"de".repeat(32)}`] }],
    });
    const events = await getHistory(stub.client, {
      owner: OWNER,
      fromBlock: 0n,
      toBlock: 1n,
      blockNumber: B,
    });
    expect(events).toStrictEqual([]);
  });
});
