import type { Address, Client } from "viem";
import { getAddress, isAddress, zeroAddress } from "viem";
import { getBlock } from "viem/actions";

import { accountAbi } from "../abi/index.ts";
import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import { ibanOf } from "../core/iban.ts";
import { accountStatusFromIndex } from "../core/status.ts";
import type { AccountStatus } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import type { ChainArgs } from "./context.ts";
import { mapViemError, readAt, snapshot } from "./context.ts";

type AnyClient = Client;

/** SPEC §3.6. */
export type Fiat24Account = {
  readonly tokenId: bigint;
  readonly owner: Address;
  readonly status: AccountStatus;
  readonly ownsToken: boolean;
  readonly walletProvider: bigint;
  readonly approved: Address | undefined;
  readonly limit: {
    readonly max: bigint;
    readonly used: bigint;
    readonly periodStart: bigint;
    readonly periodEnd: bigint;
  };
  readonly iban: string | undefined;
  readonly blockNumber: bigint;
};

// `ibanOf` only yields an unambiguous IBAN below 10^11 (SPEC §5.3).
const IBAN_BOUND = 10n ** 11n;

// THIRTYDAYS (Fiat24Account.sol:45) — the 30-day limit window.
const THIRTY_DAYS = 2_592_000n;

// Stored `enum Status` index for Tourist (Fiat24Account.sol:26); checkLimit's own
// branch reads the stored value, not the resolved one (:304).
const STATUS_TOURIST = 2;

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

type StoredLimit = readonly [bigint, bigint, bigint];

const invalidResponse = (): never => {
  throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
};

function asStoredLimit(value: unknown): StoredLimit {
  if (!Array.isArray(value) || value.length !== 3) {
    return invalidResponse();
  }
  const items: ReadonlyArray<unknown> = value;
  const [used, max, start] = items;
  if (typeof used !== "bigint" || typeof max !== "bigint" || typeof start !== "bigint") {
    return invalidResponse();
  }
  return [used, max, start];
}

function asBigint(value: unknown): bigint {
  return typeof value === "bigint" ? value : invalidResponse();
}

function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalidResponse();
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : invalidResponse();
}

function asAddress(value: unknown): Address {
  return typeof value === "string" && isAddress(value, { strict: false })
    ? getAddress(value)
    : invalidResponse();
}

function checkedAddress(value: unknown): Address {
  return typeof value === "string" && isAddress(value, { strict: false })
    ? getAddress(value)
    : (() => {
        throw new Fiat24Error("invalid-address", "invalid address");
      })();
}

type Round = {
  exists: boolean;
  statusIndex: number;
  limit: StoredLimit;
  limitTourist: bigint;
  walletProvider: bigint;
  timestamp: bigint;
  owner: Address | undefined;
  approved: Address | undefined;
};

async function readRound(
  client: AnyClient,
  B: bigint,
  account: Address,
  tokenId: bigint,
  exists: boolean,
): Promise<Round> {
  const blockTimestamp = (async (): Promise<bigint> => {
    try {
      const block = await getBlock(client, { blockNumber: B });
      if (block === null || typeof block.timestamp !== "bigint") {
        invalidResponse();
      }
      return block.timestamp;
    } catch (error) {
      return mapViemError(error);
    }
  })();
  const calls: Array<Promise<unknown>> = [
    readAt(client, B, {
      address: account,
      abi: accountAbi,
      functionName: "status",
      args: [tokenId],
    }),
    readAt(client, B, {
      address: account,
      abi: accountAbi,
      functionName: "limit",
      args: [tokenId],
    }),
    readAt(client, B, { address: account, abi: accountAbi, functionName: "limitTourist" }),
    readAt(client, B, {
      address: account,
      abi: accountAbi,
      functionName: "walletProvider",
      args: [tokenId],
    }),
    blockTimestamp,
  ];
  // ownerOf/getApproved join the same round only when the token exists on chain.
  if (exists) {
    calls.push(
      readAt(client, B, {
        address: account,
        abi: accountAbi,
        functionName: "ownerOf",
        args: [tokenId],
      }),
      readAt(client, B, {
        address: account,
        abi: accountAbi,
        functionName: "getApproved",
        args: [tokenId],
      }),
    );
  }
  const [status, limit, limitTourist, walletProvider, timestamp, owner, approved] =
    await Promise.all(calls);
  return {
    exists,
    statusIndex: asNumber(status),
    limit: asStoredLimit(limit),
    limitTourist: asBigint(limitTourist),
    walletProvider: asBigint(walletProvider),
    timestamp: asBigint(timestamp),
    owner: exists ? asAddress(owner) : undefined,
    approved: exists ? asAddress(approved) : undefined,
  };
}

function buildAccount(
  tokenId: bigint,
  B: bigint,
  round: Round,
  status: AccountStatus,
  ownsToken: boolean,
): Fiat24Account {
  const [usedLimit, clientLimit, startLimitDate] = round.limit;
  const periodStart = startLimitDate;
  const periodEnd = periodStart + THIRTY_DAYS;
  // Fiat24Account.sol:304,306 — a finished 30-day period zeroes usedLimit (strict <).
  const used = periodEnd < round.timestamp ? 0n : usedLimit;
  return {
    tokenId,
    owner: round.owner ?? zeroAddress,
    status,
    ownsToken,
    walletProvider: round.walletProvider,
    approved:
      round.approved === undefined || sameAddress(round.approved, zeroAddress)
        ? undefined
        : round.approved,
    limit: {
      max: round.statusIndex === STATUS_TOURIST ? round.limitTourist : clientLimit,
      used,
      periodStart,
      periodEnd,
    },
    iban: tokenId < IBAN_BOUND ? ibanOf(tokenId) : undefined,
    blockNumber: B,
  };
}

async function accountByTokenId(
  client: AnyClient,
  B: bigint,
  account: Address,
  tokenId: bigint,
): Promise<Fiat24Account | undefined> {
  const exists = asBoolean(
    await readAt(client, B, {
      address: account,
      abi: accountAbi,
      functionName: "exists",
      args: [tokenId],
    }),
  );
  if (!exists) {
    return undefined;
  }
  const round = await readRound(client, B, account, tokenId, true);
  return buildAccount(tokenId, B, round, accountStatusFromIndex(round.statusIndex), true);
}

/**
 * Layer-internal for checkTransfer: resolve an owner's account via the contract's own path and
 * report which path hit (`historic` = historicOwnership, `index` = the tokenOfOwnerByIndex walk-in,
 * Fiat24Token.sol:172-180).
 */
export async function resolveAccount(
  client: AnyClient,
  deployment: Deployment,
  B: bigint,
  ownerRaw: unknown,
): Promise<{ account: Fiat24Account; via: "historic" | "index" } | undefined> {
  const owner = checkedAddress(ownerRaw);
  const account = deployment.account.proxy;
  const [historicRaw, balanceRaw] = await Promise.all([
    readAt(client, B, {
      address: account,
      abi: accountAbi,
      functionName: "historicOwnership",
      args: [owner],
    }),
    readAt(client, B, {
      address: account,
      abi: accountAbi,
      functionName: "balanceOf",
      args: [owner],
    }),
  ]);
  const historic = asBigint(historicRaw);
  const balance = asBigint(balanceRaw);

  let tokenId: bigint;
  let via: "historic" | "index";
  if (historic !== 0n) {
    tokenId = historic;
    via = "historic";
  } else if (balance > 0n) {
    tokenId = asBigint(
      await readAt(client, B, {
        address: account,
        abi: accountAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [owner, 0n],
      }),
    );
    via = "index";
  } else {
    return undefined;
  }

  const exists = asBoolean(
    await readAt(client, B, {
      address: account,
      abi: accountAbi,
      functionName: "exists",
      args: [tokenId],
    }),
  );
  const round = await readRound(client, B, account, tokenId, exists);
  return {
    account: buildAccount(
      tokenId,
      B,
      round,
      // The index path always resolves to a walk-in.
      via === "historic" ? accountStatusFromIndex(round.statusIndex) : "tourist",
      round.owner !== undefined && sameAddress(round.owner, owner),
    ),
    via,
  };
}

/**
 * SPEC §8.2: `{owner}` mirrors Fiat24Token.sol:172-180 — a `historicOwnership` hit takes
 * precedence, else a positive ERC-721 balance resolves the first token (walk-in ⇒ status
 * "tourist"). `{tokenId}` goes straight at the id. Every read at one snapshot B.
 */
export async function getAccount(
  client: AnyClient,
  args: ChainArgs & ({ owner: Address } | { tokenId: bigint }),
): Promise<Fiat24Account | undefined> {
  const { deployment, blockNumber: B } = await snapshot(client, args);
  if ("tokenId" in args) {
    if (typeof args.tokenId !== "bigint") {
      throw new Fiat24Error("invalid-account-id", "invalid account id");
    }
    assertTokenId(args.tokenId);
    return accountByTokenId(client, B, deployment.account.proxy, args.tokenId);
  }
  const resolved = await resolveAccount(client, deployment, B, args.owner);
  return resolved?.account;
}
