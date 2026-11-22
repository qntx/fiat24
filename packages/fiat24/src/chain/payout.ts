import { numberToHex } from "viem";
import type { Client } from "viem";

import { tokenAbi } from "../abi/index.ts";
import { isValidContactId } from "../calls/payout.ts";
import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { PayoutCurrency } from "../core/types.ts";
import { decodeFiat24Log } from "../events/decode.ts";
import type { Fiat24Event, RawLog } from "../events/types.ts";
import type { ChainArgs } from "./context.ts";
import {
  asBigint,
  checkedChunkSize,
  checkedPayoutCurrency,
  getLogsChunked,
  invalidResponse,
  readAt,
  resolveDeployment,
  snapshot,
  topic0Of,
} from "./context.ts";

/** SPEC §3.6. */
export type PayoutSettlement = {
  readonly status: "pending" | "settled" | "rejected";
  readonly event?: Fiat24Event;
  readonly blockNumber: bigint;
};

/** `minimalPayoutAmount()` on the payout token, at B (SPEC §8.2). */
export async function getPayoutMinimum(
  client: Client,
  args: ChainArgs & { currency: PayoutCurrency },
): Promise<bigint> {
  resolveDeployment(client, args.deployment);
  const currency = checkedPayoutCurrency(args.currency);
  const { deployment, blockNumber: B } = await snapshot(client, args);
  const value = await readAt(client, B, {
    address: deployment.tokens[currency].proxy,
    abi: tokenAbi,
    functionName: "minimalPayoutAmount",
  });
  return asBigint(value);
}

/**
 * SPEC §8.2: one `eth_getLogs` filter — token address, topics `[CashPayout, tokenId]` — over
 * `[fromBlock, B]` in `chunkSize` windows (default 1M). A `bankId`+`trxId` match is unique on chain
 * (pacs008 dedup, Fiat24Token.sol:111-113): zero matches ⇒ `pending`, one ⇒ its `settlement` (an
 * `unknown` payoutAccount is an RPC/decoder anomaly), more ⇒ the RPC lied.
 */
export async function getPayoutSettlement(
  client: Client,
  args: ChainArgs & {
    currency: PayoutCurrency;
    tokenId: bigint;
    contactId: string;
    txid: string;
    fromBlock: bigint;
    chunkSize?: bigint;
  },
): Promise<PayoutSettlement> {
  resolveDeployment(client, args.deployment);
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
  if (typeof args.fromBlock !== "bigint" || args.fromBlock < 0n) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  if (args.chunkSize !== undefined) {
    checkedChunkSize(args.chunkSize);
  }
  const { deployment, blockNumber: B } = await snapshot(client, args);
  if (args.fromBlock > B) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const chunkSize = args.chunkSize ?? 1_000_000n;

  const logs: RawLog[] = await getLogsChunked(client, {
    filters: [
      {
        address: deployment.tokens[currency].proxy,
        topics: [topic0Of(tokenAbi, "CashPayout"), numberToHex(args.tokenId, { size: 32 })],
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
      matches.set(`${event.transactionHash.toLowerCase()}:${event.logIndex}`, event);
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
