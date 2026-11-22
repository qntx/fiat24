import { numberToHex, pad, toEventSelector, isAddress } from "viem";
import type { Abi, AbiEvent, Address, Client, Hex } from "viem";

import { accountAbi, cardAbi, depositAbi, tokenAbi } from "../abi/index.ts";
import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import { CURRENCIES } from "../core/types.ts";
import { decodeFiat24Log } from "../events/decode.ts";
import type { Fiat24Event } from "../events/types.ts";
import type { ChainArgs } from "./context.ts";
import { getLogsChunked, snapshot } from "./context.ts";

type AnyClient = Client;

const invalidArgument = (): never => {
  throw new Fiat24Error("invalid-argument", "invalid argument");
};

// Topic0 selectors are derived from the ABIs at call time (§4.4, never hand-typed).
function topic0Of(abi: Abi, name: string): Hex {
  const event = abi.find(
    (entry): entry is AbiEvent => entry.type === "event" && entry.name === name,
  );
  if (event === undefined) {
    throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
  }
  return toEventSelector(event);
}

const DEFAULT_CHUNK = 100_000n;

/**
 * SPEC §7.2 — history filters for `owner` (O) and optional `tokenId` (T) over `[fromBlock,
 * toBlock]`. Address topics are `pad(O)` lowercase, id topics 32-byte hex; topic0 always from the
 * ABIs. Windows run sequentially, filters within a window concurrently; malformed logs propagate as
 * `malformed-log`.
 */
export async function getHistory(
  client: AnyClient,
  args: ChainArgs & {
    owner: Address;
    tokenId?: bigint;
    fromBlock: bigint;
    toBlock: bigint;
    chunkSize?: bigint;
  },
): Promise<ReadonlyArray<Fiat24Event>> {
  const { deployment, blockNumber: B } = await snapshot(client, args);
  const ownerRaw = args.owner;
  if (typeof ownerRaw !== "string" || !isAddress(ownerRaw, { strict: false })) {
    throw new Fiat24Error("invalid-address", "invalid address");
  }
  const owner: Hex = `0x${pad(ownerRaw, { size: 32 }).slice(2).toLowerCase()}`;
  if (typeof args.fromBlock !== "bigint" || args.fromBlock < 0n) {
    invalidArgument();
  }
  if (typeof args.toBlock !== "bigint" || args.toBlock < args.fromBlock || args.toBlock > B) {
    invalidArgument();
  }
  let idTopic: Hex | undefined;
  if (args.tokenId !== undefined) {
    if (typeof args.tokenId !== "bigint") {
      throw new Fiat24Error("invalid-account-id", "invalid account id");
    }
    assertTokenId(args.tokenId);
    idTopic = numberToHex(args.tokenId, { size: 32 });
  }
  const chunkSize = args.chunkSize ?? DEFAULT_CHUNK;

  const tokenAddresses = CURRENCIES.map((currency) => deployment.tokens[currency].proxy);
  const tokenTransfer = topic0Of(tokenAbi, "Transfer");
  const clientPayout = topic0Of(tokenAbi, "ClientPayout");
  const clientPayoutRef = topic0Of(tokenAbi, "ClientPayoutRef");
  const cashPayout = topic0Of(tokenAbi, "CashPayout");
  const cashDeposit = topic0Of(tokenAbi, "CashDeposit");
  const cashDepositNok = topic0Of(tokenAbi, "CashDepositNOK");
  const exchangedIn = topic0Of(depositAbi, "MoneyExchangedExactIn");
  const exchangedOut = topic0Of(depositAbi, "MoneyExchangedExactOut");
  const depositedUsd = topic0Of(depositAbi, "DepositedTokenViaUsd");
  const depositedEth = topic0Of(depositAbi, "DepositedEth");
  const depositedViaEth = topic0Of(depositAbi, "DepositedTokenViaEth");
  const depositedByWallet = topic0Of(depositAbi, "DepositedByWallet");
  const accountTransfer = topic0Of(accountAbi, "Transfer");
  const cardEvents = ["Authorized", "Incremented", "Adviced", "Reversed"].map((name) =>
    topic0Of(cardAbi, name),
  );

  const filters = [
    // H1: cash tokens sent by O.
    { address: tokenAddresses, topics: [tokenTransfer, owner] },
    // H2: cash tokens received by O.
    { address: tokenAddresses, topics: [tokenTransfer, null, owner] },
    // H3: payouts (all three payout events) where O is the sender (topic2).
    {
      address: tokenAddresses,
      topics: [[clientPayout, clientPayoutRef, cashPayout], null, owner],
    },
    // H4: inbound cash deposits to O (recipientAddress is topic2).
    { address: tokenAddresses, topics: [cashDeposit, null, owner] },
    // H5: deposit-contract exchanges and top-ups where O is the sender (topic1).
    {
      address: deployment.deposit.proxy,
      topics: [[exchangedIn, exchangedOut, depositedUsd, depositedEth, depositedViaEth], owner],
    },
    ...(idTopic === undefined
      ? []
      : [
          // H6: card authorisations/refunds on T (tokenId is topic1).
          { address: deployment.card.proxy, topics: [cardEvents, idTopic] },
          // H7: the account NFT T arriving at someone (ERC-721 topic3).
          {
            address: deployment.account.proxy,
            topics: [accountTransfer, null, null, idTopic],
          },
          // H8: provider top-ups credited to T.
          { address: deployment.deposit.proxy, topics: [depositedByWallet, idTopic] },
          // H9: rejected cash deposits to T (recipientAccountId is topic1).
          { address: tokenAddresses, topics: [cashDepositNok, idTopic] },
        ]),
  ];

  const logs = await getLogsChunked(client, {
    filters,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    chunkSize,
  });

  const events = new Map<string, Fiat24Event>();
  for (const log of logs) {
    const event = decodeFiat24Log(log, deployment);
    if (event !== undefined) {
      events.set(`${event.transactionHash}:${event.logIndex}`, event);
    }
  }
  return [...events.values()].sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  );
}
