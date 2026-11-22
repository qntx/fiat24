import * as fc from "fast-check";
import { toEventSelector } from "viem";
import type { Abi, AbiEvent, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { accountAbi, cardAbi, depositAbi, tokenAbi } from "../../src/abi/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { decodeFiat24Log, decodeFiat24Logs } from "../../src/events/index.ts";
import type { RawLog } from "../../src/events/index.ts";
import { okOrCode, throwsCode } from "../helpers.ts";

const MALFORMED = new Set(["malformed-log"]);

const isWantedEvent = (e: Abi[number], name: string): e is AbiEvent =>
  e.type === "event" && e.name === name;

function selectorOf(abi: Abi, name: string): Hex {
  const event = abi.find((e) => isWantedEvent(e, name));
  if (event === undefined) {
    throw new Error(`missing event ${name}`);
  }
  return toEventSelector(event);
}

// A decoded result is either "not ours" (undefined) or a normalized event object.
const undefinedOrObject = (value: unknown): boolean =>
  value === undefined || typeof value === "object";

// A (address, topic0) pair from every §7.1 group.
const KNOWN: ReadonlyArray<readonly [`0x${string}`, Hex]> = [
  [arbitrum.tokens.EUR24.proxy, selectorOf(tokenAbi, "Transfer")],
  [arbitrum.tokens.USD24.proxy, selectorOf(tokenAbi, "ClientPayoutRef")],
  [arbitrum.tokens.CHF24.proxy, selectorOf(tokenAbi, "CashPayout")],
  [arbitrum.tokens.CNH24.proxy, selectorOf(tokenAbi, "CashDepositNOK")],
  [arbitrum.deposit.proxy, selectorOf(depositAbi, "MoneyExchangedExactIn")],
  [arbitrum.deposit.proxy, selectorOf(depositAbi, "DepositedByWallet")],
  [arbitrum.card.proxy, selectorOf(cardAbi, "Authorized")],
  [arbitrum.card.proxy, selectorOf(cardAbi, "Adviced")],
  [arbitrum.account.proxy, selectorOf(accountAbi, "Transfer")],
];

const hexByte = fc.integer({ min: 0, max: 255 }).map((n) => n.toString(16).padStart(2, "0"));
const hexOf = (): fc.Arbitrary<Hex> =>
  fc.array(hexByte, { minLength: 0, maxLength: 96 }).map((bytes): Hex => `0x${bytes.join("")}`);
const topicArb = fc
  .array(hexByte, { minLength: 32, maxLength: 32 })
  .map((bytes): Hex => `0x${bytes.join("")}`);
const knownPair = fc.constantFrom(...KNOWN);

function rawLog(patch: Partial<RawLog> & Pick<RawLog, "topics" | "data">): RawLog {
  return {
    address: arbitrum.tokens.EUR24.proxy,
    blockNumber: 526365924n,
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: 0,
    ...patch,
  };
}

describe("decodeFiat24Log properties", () => {
  test("random topics/data under a known pair: event or malformed-log, never another throw", () => {
    expect(() =>
      fc.assert(
        fc.property(
          knownPair,
          fc.array(topicArb, { minLength: 0, maxLength: 5 }),
          hexOf(),
          ([address, topic0], extraTopics, data) =>
            okOrCode(
              () => decodeFiat24Log(rawLog({ address, topics: [topic0, ...extraTopics], data })),
              MALFORMED,
              undefinedOrObject,
            ),
        ),
      ),
    ).not.toThrow();
  });

  test("a random address or random topic0 is never an error", () => {
    const randomAddress = fc
      .array(hexByte, { minLength: 20, maxLength: 20 })
      .map((bytes): `0x${string}` => `0x${bytes.join("")}`);
    expect(() =>
      fc.assert(
        fc.property(
          randomAddress,
          topicArb,
          fc.array(topicArb, { minLength: 0, maxLength: 3 }),
          hexOf(),
          (address, topic0, extra, data) => {
            const result = decodeFiat24Log(rawLog({ address, topics: [topic0, ...extra], data }));
            // Unknown (address, topic0) pairs are "not ours"; the result may be an
            // event only when the pair is a §7.1 key — but it must never throw here
            // unless the pair is known (random chance ~0).
            return undefinedOrObject(result);
          },
        ),
      ),
    ).not.toThrow();
  });

  test("fc.anything() as a log: undefined, an event, or malformed-log — never another throw", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.anything(), (value) =>
          okOrCode(() => decodeFiat24Log(value as RawLog), MALFORMED, undefinedOrObject),
        ),
      ),
    ).not.toThrow();
  });

  test("junk fields under a known (address, topic0) pair: same contract", () => {
    // Every field that is not the address/topic0 key is arbitrary — the decoder must still
    // answer only with undefined (never reachable for a known pair), an event, or
    // malformed-log.
    const junk = fc.record({
      address: knownPair.map(([address]) => address),
      topics: fc
        .tuple(topicArb, fc.array(fc.anything(), { minLength: 0, maxLength: 4 }))
        .map(([first, rest]) => [first, ...rest]),
      data: fc.anything(),
      blockNumber: fc.anything(),
      transactionHash: fc.anything(),
      logIndex: fc.anything(),
    });
    expect(() =>
      fc.assert(
        fc.property(junk, (log) =>
          okOrCode(() => decodeFiat24Log(log as RawLog), MALFORMED, undefinedOrObject),
        ),
      ),
    ).not.toThrow();
  });

  test("a known selector at topics[0] with arbitrary tails", () => {
    // topics[0] pinned to a real §7.1 selector + known address: result is an event or
    // malformed-log (undefined is unreachable, but harmless to allow).
    const junk = fc.record({
      address: knownPair.map(([address]) => address),
      topics: knownPair.chain(([_, topic0]) =>
        fc.array(fc.anything(), { minLength: 0, maxLength: 5 }).map((rest) => [topic0, ...rest]),
      ),
      data: fc.anything(),
      blockNumber: fc.anything(),
      transactionHash: fc.anything(),
      logIndex: fc.anything(),
    });
    expect(() =>
      fc.assert(
        fc.property(junk, (log) =>
          okOrCode(() => decodeFiat24Log(log as RawLog), MALFORMED, undefinedOrObject),
        ),
      ),
    ).not.toThrow();
  });

  test("decodeFiat24Logs on a non-array is invalid-argument, nothing else throws", () => {
    const INVALID_ARG = new Set(["invalid-argument"]);
    expect(() =>
      fc.assert(
        fc.property(fc.anything(), (value) =>
          okOrCode(
            () => decodeFiat24Logs(value as ReadonlyArray<RawLog>),
            INVALID_ARG,
            (out) => Array.isArray(out),
          ),
        ),
      ),
    ).not.toThrow();
    expect(throwsCode(() => decodeFiat24Logs(42 as never), INVALID_ARG)).toBe(true);
  });

  test("a valid encoding with appended bytes is always malformed-log", () => {
    // ERC-20 Transfer for `from`=zero is still a structurally valid log for testing.
    const validData: Hex = `0x${1n.toString(16).padStart(64, "0")}`;
    const transferTopics: Hex[] = [
      selectorOf(tokenAbi, "Transfer"),
      `0x${"0".repeat(24)}1111111111111111111111111111111111111111`,
      `0x${"0".repeat(24)}2222222222222222222222222222222222222222`,
    ];
    expect(() =>
      fc.assert(
        fc.property(hexOf(), (tail) => {
          fc.pre(tail !== "0x");
          return okOrCode(
            () =>
              decodeFiat24Log(
                rawLog({
                  topics: transferTopics,
                  data: `${validData}${tail.slice(2)}` as Hex,
                }),
              ),
            MALFORMED,
            () => false,
          );
        }),
      ),
    ).not.toThrow();
  });
});
