import { encodeAbiParameters, encodeEventTopics } from "viem";
import type { Abi, AbiEvent, Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { accountAbi, cardAbi, depositAbi, tokenAbi } from "../../src/abi/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import type { Deployment } from "../../src/deployments/index.ts";
import { decodeFiat24Log, decodeFiat24Logs } from "../../src/events/index.ts";
import type { RawLog } from "../../src/events/index.ts";
import { expectError } from "../helpers.ts";

const TX: `0x${string}` = `0x${"ab".repeat(32)}`;

const isNamedEvent = (e: Abi[number], name: string): e is AbiEvent =>
  e.type === "event" && e.name === name;

function mustEvent(abi: Abi, name: string): AbiEvent {
  const event = abi.find((e) => isNamedEvent(e, name));
  if (event === undefined) {
    throw new Error(`missing ${name} event`);
  }
  return event;
}

// viem types every indexed arg as `Hex | Hex[] | null`; the §7.1 set is all-static, so every
// topic is a single Hex — anything else means the test's encoding was wrong.
const mustTopics = (topics: ReadonlyArray<Hex | Hex[] | null>): ReadonlyArray<Hex> =>
  topics.map((t) => {
    if (typeof t !== "string") {
      throw new TypeError("unexpected topic shape");
    }
    return t;
  });

// A static `address` indexed topic is the address left-padded to 32 bytes.
const addressTopic = (address: Address): Hex => `0x${"0".repeat(24)}${address.slice(2)}`;

function log(patch: Partial<RawLog> & Pick<RawLog, "topics">): RawLog {
  return {
    address: arbitrum.tokens.EUR24.proxy,
    data: "0x",
    blockNumber: 526365924n,
    transactionHash: TX,
    logIndex: 0,
    ...patch,
  };
}

function erc20TransferLog(from: Address, to: Address, value: bigint): RawLog {
  const [topic0] = encodeEventTopics({ abi: [mustEvent(tokenAbi, "Transfer")] });
  return log({
    address: arbitrum.tokens.EUR24.proxy,
    topics: [topic0, addressTopic(from), addressTopic(to)],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  });
}

const foreign: Deployment = { ...arbitrum, chainId: 1 as never };

describe("decodeFiat24Log", () => {
  test("deployment chainId != 42161 is unsupported-chain", () => {
    expect.hasAssertions();
    expectError(
      () => decodeFiat24Log(log({ topics: [`0x${"0".repeat(64)}`] }), foreign),
      "unsupported-chain",
    );
  });

  test("decodes an ERC-20 Transfer (§3.5)", () => {
    const from = "0x1111111111111111111111111111111111111111";
    const to = "0x2222222222222222222222222222222222222222";
    const event = decodeFiat24Log(erc20TransferLog(from, to, 7500n));
    expect(event).toMatchObject({
      kind: "transfer",
      currency: "EUR24",
      from,
      to,
      amount: 7500n,
      blockNumber: 526365924n,
      transactionHash: TX,
      logIndex: 0,
    });
    expect(Object.isFrozen(event)).toBe(true);
  });

  test("log address match is case-insensitive", () => {
    const raw = erc20TransferLog(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      1n,
    );
    const lowered = { ...raw, address: raw.address.toLowerCase() as Address };
    expect(decodeFiat24Log(lowered)?.kind).toBe("transfer");
  });

  test("empty topics and unknown addresses return undefined", () => {
    expect(decodeFiat24Log(log({ topics: [] }))).toBeUndefined();
    expect(
      decodeFiat24Log(
        log({
          address: "0x000000000000000000000000000000000000bEEF",
          topics: [`0x${"0".repeat(64)}`],
        }),
      ),
    ).toBeUndefined();
    // `0X…` is not a valid hex prefix: it must stay "not ours" even though the
    // lowercase address would match a pinned token (contractOf compares lowercased).
    expect(
      decodeFiat24Log(
        log({
          address: `0X${arbitrum.tokens.EUR24.proxy.slice(2)}` as Address,
          topics: erc20TransferLog(
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000002",
            1n,
          ).topics,
        }),
      ),
    ).toBeUndefined();
  });

  test("unknown address with a wanted topic0 of each §7.1 group returns undefined", () => {
    const unknown = "0x000000000000000000000000000000000000bEEF" as Address;
    const sender = "0x1111111111111111111111111111111111111111";
    // tokens group: ERC-20 Transfer
    const transfer = erc20TransferLog(sender, sender, 1n);
    expect(decodeFiat24Log({ ...transfer, address: unknown })).toBeUndefined();
    // deposit group: MoneyExchangedExactIn (sender indexed, four non-indexed args)
    expect(
      decodeFiat24Log(
        log({
          address: unknown,
          topics: mustTopics(
            encodeEventTopics({
              abi: [mustEvent(depositAbi, "MoneyExchangedExactIn")],
              args: { sender },
            }),
          ),
          data: encodeAbiParameters(
            [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
            [arbitrum.tokens.EUR24.proxy, arbitrum.tokens.CHF24.proxy, 100n, 99n],
          ),
        }),
      ),
    ).toBeUndefined();
    // card group: Authorized (tokenId + sender indexed, four non-indexed args)
    expect(
      decodeFiat24Log(
        log({
          address: unknown,
          topics: mustTopics(
            encodeEventTopics({
              abi: [mustEvent(cardAbi, "Authorized")],
              args: { tokenId: 7n, sender },
            }),
          ),
          data: encodeAbiParameters(
            [{ type: "string" }, { type: "string" }, { type: "address" }, { type: "uint256" }],
            ["auth-1", "CARD-1", arbitrum.tokens.EUR24.proxy, 100n],
          ),
        }),
      ),
    ).toBeUndefined();
    // account group: ERC-721 Transfer (three indexed topics, empty data)
    expect(
      decodeFiat24Log(
        log({
          address: unknown,
          topics: mustTopics(
            encodeEventTopics({
              abi: [mustEvent(accountAbi, "Transfer")],
              args: { from: sender, to: sender, tokenId: 7n },
            }),
          ),
        }),
      ),
    ).toBeUndefined();
  });

  test("pinned addresses outside the §7.1 set are not ours", () => {
    const pausedTopic: Hex = `0x${"0".repeat(64)}`;
    for (const address of [
      arbitrum.f24.address,
      arbitrum.priceList.proxy,
      arbitrum.f24Sales.proxy,
      arbitrum.usdc,
      arbitrum.tokens.EUR24.implementation,
      arbitrum.proxyAdmin.address,
    ]) {
      expect(decodeFiat24Log(log({ address, topics: [pausedTopic] }))).toBeUndefined();
    }
  });

  test("unlisted ABI events on a known address return undefined even when decodable", () => {
    // Paused(address) is a tokenAbi event but not in the §7.1 set.
    const topics = mustTopics(encodeEventTopics({ abi: [mustEvent(tokenAbi, "Paused")] }));
    const raw = log({
      topics,
      data: encodeAbiParameters([{ type: "address" }], [arbitrum.account.proxy]),
    });
    expect(decodeFiat24Log(raw)).toBeUndefined();
    // …and a malformed Paused log is still "not ours" (topic0 is not a §7.1 key).
    const malformed = log({ topics, data: "0x1234" });
    expect(decodeFiat24Log(malformed)).toBeUndefined();
  });

  test("ERC-721 Transfer on the account NFT is account-transfer", () => {
    const topics = mustTopics(
      encodeEventTopics({
        abi: [mustEvent(accountAbi, "Transfer")],
        args: {
          from: "0x1111111111111111111111111111111111111111",
          to: "0x2222222222222222222222222222222222222222",
          tokenId: 123456n,
        },
      }),
    );
    const decoded = decodeFiat24Log(log({ address: arbitrum.account.proxy, topics }));
    expect(decoded).toMatchObject({
      kind: "account-transfer",
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      tokenId: 123456n,
    });
  });

  test("null position fields are malformed-log on a known pair", () => {
    const raw = erc20TransferLog(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      1n,
    );
    expect.hasAssertions();
    expectError(() => decodeFiat24Log({ ...raw, blockNumber: null }), "malformed-log");
    expectError(() => decodeFiat24Log({ ...raw, transactionHash: null }), "malformed-log");
    expectError(() => decodeFiat24Log({ ...raw, logIndex: null }), "malformed-log");
  });
});

describe("decodeFiat24Logs", () => {
  test("drops undefined and preserves input order", () => {
    const a = erc20TransferLog(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      1n,
    );
    const b = erc20TransferLog(
      "0x3333333333333333333333333333333333333333",
      "0x4444444444444444444444444444444444444444",
      2n,
    );
    const unknown = log({
      address: "0x000000000000000000000000000000000000bEEF",
      topics: [`0x${"0".repeat(64)}`],
    });
    const decoded = decodeFiat24Logs([a, unknown, b]);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject({ from: "0x1111111111111111111111111111111111111111" });
    expect(decoded[1]).toMatchObject({ from: "0x3333333333333333333333333333333333333333" });
  });
});
