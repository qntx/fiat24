import type { Address, Hex } from "viem";
import { numberToHex, pad, toEventSelector } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { transferCall } from "../../src/calls/index.ts";
import { getHistory, getPayoutSettlement } from "../../src/chain/index.ts";
import { CURRENCIES } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { decodeFiat24Logs } from "../../src/events/index.ts";
import type { Fiat24Event, RawLog } from "../../src/events/index.ts";
import { required } from "../helpers.ts";
import {
  FORK_BLOCK,
  FORK_ENABLED,
  LIVE_1,
  LIVE_2,
  expectSuccess,
  ownerOf,
  runCast,
  sendCall,
  startFork,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

type RawLogJson = {
  readonly address: string;
  readonly topics: string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: string;
};

/** `cast rpc eth_getLogs <filter-json>` — the independent oracle (Foundry, not viem). */
async function castGetLogs(fork: Fork, filter: Record<string, unknown>): Promise<RawLogJson[]> {
  const stdout = await runCast([
    "rpc",
    "--rpc-url",
    fork.url,
    "eth_getLogs",
    JSON.stringify(filter),
  ]);
  const parsed: unknown = JSON.parse(stdout);
  return Array.isArray(parsed) ? (parsed as RawLogJson[]) : [];
}

const TOKENS = CURRENCIES.map((currency) => arbitrum.tokens[currency].proxy);
// §7.1 event signatures transcribed from the verified ABIs (data/abis/*.json) — the oracle never
// imports the SDK's ABI table.
const tokenTransfer = toEventSelector("Transfer(address,address,uint256)");
const clientPayout = toEventSelector("ClientPayout(uint256,address,uint256,uint256,string,string)");
const clientPayoutRef = toEventSelector(
  "ClientPayoutRef(uint256,address,uint256,uint256,string,string,uint256,string)",
);
const cashPayout = toEventSelector("CashPayout(uint256,address,uint256,string,string)");
const cashDeposit = toEventSelector("CashDeposit(uint256,address,uint256,string,string,string)");
const cashDepositNok = toEventSelector("CashDepositNOK(uint256,uint256,string,string,string)");
const exchangedIn = toEventSelector(
  "MoneyExchangedExactIn(address,address,address,uint256,uint256)",
);
const exchangedOut = toEventSelector(
  "MoneyExchangedExactOut(address,address,address,uint256,uint256)",
);
const depositedUsd = toEventSelector(
  "DepositedTokenViaUsd(address,address,address,uint256,uint256)",
);
const depositedEth = toEventSelector("DepositedEth(address,address,address,uint256,uint256)");
const depositedViaEth = toEventSelector(
  "DepositedTokenViaEth(address,address,address,uint256,uint256)",
);
const depositedByWallet = toEventSelector(
  "DepositedByWallet(uint256,address,uint256,address,address,uint256)",
);
const accountTransfer = toEventSelector("Transfer(address,address,uint256)");
const cardEvents = [
  "Authorized(string,uint256,address,string,address,uint256)",
  "Incremented(string,uint256,address,string,address,uint256)",
  "Adviced(string,string,uint256,address,string,address,uint256)",
  "Reversed(string,string,uint256,address,string,address,uint256)",
].map((signature) => toEventSelector(signature));

/** The SDK's §7.2 filter set, transcribed for the cast oracle. */
function historyFilters(
  ownerTopic: string,
  idTopic: string | undefined,
): Array<Record<string, unknown>> {
  return [
    { address: TOKENS, topics: [tokenTransfer, ownerTopic] },
    { address: TOKENS, topics: [tokenTransfer, null, ownerTopic] },
    {
      address: TOKENS,
      topics: [[clientPayout, clientPayoutRef, cashPayout], null, ownerTopic],
    },
    { address: TOKENS, topics: [cashDeposit, null, ownerTopic] },
    {
      address: arbitrum.deposit.proxy,
      topics: [
        [exchangedIn, exchangedOut, depositedUsd, depositedEth, depositedViaEth],
        ownerTopic,
      ],
    },
    ...(idTopic === undefined
      ? []
      : [
          { address: arbitrum.card.proxy, topics: [cardEvents, idTopic] },
          { address: arbitrum.account.proxy, topics: [accountTransfer, null, null, idTopic] },
          { address: arbitrum.deposit.proxy, topics: [depositedByWallet, idTopic] },
          { address: TOKENS, topics: [cashDepositNok, idTopic] },
        ]),
  ];
}

// §7.1 topic0s the history filters can surface + the contracts allowed to emit them.
const SECTION_71_TOPICS = new Set(
  [
    tokenTransfer,
    clientPayout,
    clientPayoutRef,
    cashPayout,
    cashDeposit,
    cashDepositNok,
    exchangedIn,
    exchangedOut,
    depositedUsd,
    depositedEth,
    depositedViaEth,
    depositedByWallet,
    accountTransfer,
    ...cardEvents,
  ].map((t) => t.toLowerCase()),
);
const PINNED = new Set(
  [...TOKENS, arbitrum.deposit.proxy, arbitrum.card.proxy, arbitrum.account.proxy].map((a) =>
    a.toLowerCase(),
  ),
);

type OracleLog = { txHash: string; logIndex: number; blockNumber: bigint; log: RawLogJson };

async function oracle(
  fork: Fork,
  ownerTopic: string,
  idTopic: string | undefined,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<OracleLog[]> {
  const seen = new Map<string, OracleLog>();
  const batches = await Promise.all(
    historyFilters(ownerTopic, idTopic).map(async (filter) =>
      castGetLogs(fork, {
        ...filter,
        fromBlock: numberToHex(fromBlock),
        toBlock: numberToHex(toBlock),
      }),
    ),
  );
  for (const logs of batches) {
    for (const log of logs) {
      const topic0 = log.topics[0]?.toLowerCase();
      if (!PINNED.has(log.address.toLowerCase()) || topic0 === undefined) {
        continue;
      }
      if (!SECTION_71_TOPICS.has(topic0)) {
        continue;
      }
      const key = `${log.transactionHash.toLowerCase()}:${log.logIndex.toLowerCase()}`;
      seen.set(key, {
        txHash: log.transactionHash,
        logIndex: Number.parseInt(log.logIndex, 16),
        blockNumber: BigInt(log.blockNumber),
        log,
      });
    }
  }
  return [...seen.values()].toSorted(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  );
}

function isTransferInTx(e: Fiat24Event, txHash: string): boolean {
  return e.kind === "transfer" && e.transactionHash === txHash;
}

function keys(events: ReadonlyArray<Fiat24Event>): string[] {
  return events.map((e) => `${e.transactionHash?.toLowerCase() ?? "null"}:${e.logIndex}`);
}

describe.skipIf(!FORK_ENABLED)("fork: history", () => {
  let fork: Fork;
  let snapshot: Hex;
  let owner1: Address;
  let owner2: Address;

  const FROM = FORK_BLOCK - 300_000n;

  beforeAll(async () => {
    fork = await startFork();
    owner1 = await ownerOf(fork, LIVE_1);
    owner2 = await ownerOf(fork, LIVE_2);
  }, 120_000);

  beforeEach(async () => {
    snapshot = await fork.testClient.snapshot();
  });

  afterEach(async () => {
    await fork.testClient.revert({ id: snapshot });
  });

  afterAll(() => {
    fork.stop();
  });

  test("getHistory matches cast logs over [B-300000, B] chunk 100000", async () => {
    const events = await getHistory(fork.publicClient, {
      owner: owner1,
      tokenId: LIVE_1,
      fromBlock: FROM,
      toBlock: FORK_BLOCK,
      chunkSize: 100_000n,
    });
    const ownerTopic = `0x${pad(owner1, { size: 32 }).slice(2).toLowerCase()}`;
    const idTopic = numberToHex(LIVE_1, { size: 32 });
    const expected = await oracle(fork, ownerTopic, idTopic, FROM, FORK_BLOCK);

    expect(events).toHaveLength(expected.length);
    expect(keys(events)).toStrictEqual(
      expected.map((l) => `${l.txHash.toLowerCase()}:${l.logIndex}`),
    );

    // Decoded kinds match the oracle's logs decoded through the same §7.1 table.
    const rawLogs: RawLog[] = expected.map((l) => ({
      address: l.log.address as Hex,
      topics: l.log.topics as Hex[],
      data: l.log.data as Hex,
      blockNumber: l.blockNumber,
      transactionHash: l.txHash as Hex,
      logIndex: l.logIndex,
    }));
    const oracleEvents = decodeFiat24Logs(rawLogs, arbitrum);
    expect(events.map((e) => e.kind)).toStrictEqual(oracleEvents.map((e) => e.kind));
  });

  test("chunkSize 37000 yields an identical result", async () => {
    const [a, b] = await Promise.all([
      getHistory(fork.publicClient, {
        owner: owner1,
        tokenId: LIVE_1,
        fromBlock: FROM,
        toBlock: FORK_BLOCK,
        chunkSize: 100_000n,
      }),
      getHistory(fork.publicClient, {
        owner: owner1,
        tokenId: LIVE_1,
        fromBlock: FROM,
        toBlock: FORK_BLOCK,
        chunkSize: 37_000n,
      }),
    ]);
    expect(keys(b)).toStrictEqual(keys(a));
  });

  test("a transfer sent on the fork appears when toBlock covers the local block", async () => {
    const receipt = await sendCall(
      fork,
      owner1,
      transferCall({ currency: "EUR24", to: owner2, amount: 42n }),
    );
    expectSuccess(receipt);
    const head = receipt.blockNumber;

    const events = await getHistory(fork.publicClient, {
      owner: owner1,
      fromBlock: head - 5n,
      toBlock: head,
      chunkSize: 10n,
    });
    const local = events.filter((e) => e.blockNumber === head);
    expect(local.some((e) => isTransferInTx(e, receipt.transactionHash))).toBe(true);

    const before = await getHistory(fork.publicClient, {
      owner: owner1,
      fromBlock: head - 5n,
      toBlock: head - 1n,
      chunkSize: 10n,
    });
    expect(before.filter((e) => e.blockNumber === head)).toHaveLength(0);
  });

  test("getPayoutSettlement finds the recorded CashPayout and only it", async () => {
    // Recorded on chain (§8.2 fixture): EUR24 CashPayout at block 0x1f51b130 in tx
    // 0xf0e57f010325e4b366dbeff06363a61510c266735375d7368cc53be664348fb5.
    const settled = await getPayoutSettlement(fork.publicClient, {
      currency: "EUR24",
      tokenId: 671098n,
      contactId: "SP",
      txid: "671098-525447250",
      fromBlock: 525447250n,
      chunkSize: 200_000n,
      blockNumber: FORK_BLOCK,
    });
    expect(settled.status).toBe("settled");
    const event = required(settled.event);
    expect(event.kind).toBe("cash-payout");
    expect(event.transactionHash).toBe(
      "0xf0e57f010325e4b366dbeff06363a61510c266735375d7368cc53be664348fb5",
    );
    expect(event.blockNumber).toBe(0x1f51b130n);

    const pending = await getPayoutSettlement(fork.publicClient, {
      currency: "EUR24",
      tokenId: 671098n,
      contactId: "SP",
      txid: "671098-000000000",
      fromBlock: 525447250n,
      chunkSize: 200_000n,
      blockNumber: FORK_BLOCK,
    });
    expect(pending.status).toBe("pending");
    expect(pending.event).toBeUndefined();
  });
});
