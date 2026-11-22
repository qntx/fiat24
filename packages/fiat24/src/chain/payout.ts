import { numberToHex, toEventSelector } from "viem";
import type { Client } from "viem";

import { tokenAbi } from "../abi/index.ts";
import { isValidContactId } from "../calls/payout.ts";
import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { PayoutCurrency } from "../core/types.ts";
import { decodeFiat24Log } from "../events/decode.ts";
import type { Fiat24Event, RawLog } from "../events/types.ts";
import type { ChainArgs } from "./context.ts";
import { getLogsChunked, readAt, snapshot } from "./context.ts";

type AnyClient = Client;

/** SPEC §3.6. */
export type PayoutSettlement = {
  readonly status: "pending" | "settled" | "rejected";
  readonly event?: Fiat24Event;
  readonly blockNumber: bigint;
};

const invalidResponse = (): never => {
  throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
};

function checkedPayoutCurrency(currency: unknown): PayoutCurrency {
  if (currency !== "EUR24" && currency !== "CHF24") {
    throw new Fiat24Error("unsupported-currency", "unsupported currency");
  }
  return currency;
}

// Topic0 is derived from the ABI at call time (never hand-typed, §4.4).
function cashPayoutTopic0(): `0x${string}` {
  const event = tokenAbi.find(
    (entry): entry is Extract<(typeof tokenAbi)[number], { type: "event" }> =>
      entry.type === "event" && entry.name === "CashPayout",
  );
  if (event === undefined) {
    return invalidResponse();
  }
  return toEventSelector(event);
}

/** `minimalPayoutAmount()` on the payout token, at B (SPEC §8.2). */
export async function getPayoutMinimum(
  client: AnyClient,
  args: ChainArgs & { currency: PayoutCurrency },
): Promise<bigint> {
  const { deployment, blockNumber: B } = await snapshot(client, args);
  const currency = checkedPayoutCurrency(args.currency);
  const value = await readAt(client, B, {
    address: deployment.tokens[currency].proxy,
    abi: tokenAbi,
    functionName: "minimalPayoutAmount",
  });
  return typeof value === "bigint" ? value : invalidResponse();
}

/**
 * SPEC §8.2: one `eth_getLogs` filter — token address, topics `[CashPayout, tokenId]` — over
 * `[fromBlock, B]` in `chunkSize` windows (default 1M). A `bankId`+`trxId` match is unique on chain
 * (pacs008 dedup, Fiat24Token.sol:111-113): zero matches ⇒ `pending`, one ⇒ its `settlement` (an
 * `unknown` payoutAccount is an RPC/decoder anomaly), more ⇒ the RPC lied.
 */
export async function getPayoutSettlement(
  client: AnyClient,
  args: ChainArgs & {
    currency: PayoutCurrency;
    tokenId: bigint;
    contactId: string;
    txid: string;
    fromBlock: bigint;
    chunkSize?: bigint;
  },
): Promise<PayoutSettlement> {
  const { deployment, blockNumber: B } = await snapshot(client, args);
  const currency = checkedPayoutCurrency(args.currency);
  if (typeof args.tokenId !== "bigint") {
    throw new Fiat24Error("invalid-account-id", "invalid account id");
  }
  assertTokenId(args.tokenId);
  if (!isValidContactId(args.contactId)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  if (typeof args.txid !== "string" || args.txid.length === 0 || args.txid.length > 1024) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  if (typeof args.fromBlock !== "bigint" || args.fromBlock < 0n || args.fromBlock > B) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const chunkSize = args.chunkSize ?? 1_000_000n;

  const logs: RawLog[] = await getLogsChunked(client, {
    filters: [
      {
        address: deployment.tokens[currency].proxy,
        topics: [cashPayoutTopic0(), numberToHex(args.tokenId, { size: 32 })],
      },
    ],
    fromBlock: args.fromBlock,
    toBlock: B,
    chunkSize,
  });

  const matches = new Map<string, Fiat24Event>();
  for (const log of logs) {
    const event = decodeFiat24Log(log, deployment);
    if (
      event !== undefined &&
      event.kind === "cash-payout" &&
      event.tokenId === args.tokenId &&
      event.trxId === args.txid &&
      event.bankId === args.contactId
    ) {
      matches.set(`${event.transactionHash}:${event.logIndex}`, event);
    }
  }
  const found = [...matches.values()];
  if (found.length === 0) {
    return { status: "pending", blockNumber: B };
  }
  if (found.length > 1) {
    return invalidResponse();
  }
  const [event] = found;
  if (event === undefined || event.kind !== "cash-payout" || event.settlement === "unknown") {
    return invalidResponse();
  }
  return { status: event.settlement, event, blockNumber: B };
}
