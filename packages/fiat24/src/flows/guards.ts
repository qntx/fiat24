import { erc20Abi, isAddressEqual } from "viem";
import type { Address, Client } from "viem";

import { getAccount } from "../chain/account.ts";
import type { Fiat24Account } from "../chain/account.ts";
import type { Availability } from "../chain/availability.ts";
import {
  asAddress,
  asBigint,
  asBoolean,
  contractTarget,
  readAt,
  revertError,
} from "../chain/context.ts";
import { Fiat24Error } from "../core/errors.ts";
import { isFiat24Signer } from "../core/signer.ts";
import type { Fiat24Signer } from "../core/signer.ts";
import type { Asset, Currency } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";

/**
 * §3.1: `deps.signer` must be an object whose `address` is a valid address equal to the flow
 * state's `owner` (I21 seam, §10.9) — else `invalid-argument`, before any I/O. Its send hook must
 * be callable; a missing method would otherwise surface as an untyped TypeError at send time.
 */
export function checkedSigner(signer: Fiat24Signer | undefined, owner: Address): Fiat24Signer {
  if (!isFiat24Signer(signer) || !isAddressEqual(signer.address, owner)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  return signer;
}

/**
 * §5: `availability.account.paused` ⇒ `unavailable {account, account-paused}` (skipped only where
 * an approve moves no funds); each `tokens[c].paused` ⇒ `unavailable {c, token-paused}`.
 */
export function assertUnpaused(
  availability: Availability,
  currencies: ReadonlyArray<Currency>,
  options?: { readonly account?: boolean },
): void {
  if (options?.account !== false && availability.account.paused) {
    throw new Fiat24Error("unavailable", "account unavailable", {
      contract: "account",
      reason: "account-paused",
    });
  }
  for (const currency of currencies) {
    if (availability.tokens[currency].paused) {
      throw new Fiat24Error("unavailable", `${currency} unavailable`, {
        contract: currency,
        reason: "token-paused",
      });
    }
  }
}

/** §5: `getAccount({owner, B})` absent ⇒ `no-account`; `status !== "live"` ⇒ `not-live`. */
export async function senderLive(
  client: Client,
  args: { readonly deployment: Deployment; readonly owner: Address; readonly blockNumber: bigint },
): Promise<Fiat24Account> {
  const account = await getAccount(client, {
    deployment: args.deployment,
    owner: args.owner,
    blockNumber: args.blockNumber,
  });
  if (account === undefined) {
    throw new Fiat24Error("no-account", "no account");
  }
  if (account.status !== "live") {
    throw new Fiat24Error("not-live", "sender account not live");
  }
  return account;
}

// checkTransfer's later steps map contract reverts through the §6.3 table; the
// leg pre-checks need the same mapping (a pause revert is `unavailable`, not `contract-revert`).
function remapRevert(error: unknown): never {
  if (
    error instanceof Fiat24Error &&
    error.code === "contract-revert" &&
    error.detail.revert !== undefined
  ) {
    throw revertError(error.detail.revert);
  }
  throw error;
}

/**
 * §5: `tokenTransferAllowed(from, to, amount)` at B (a revert maps via §6.3, as `checkTransfer`
 * does). `false` ⇒ `checkLimit(limitOf, convertToChf(amount))` splits `limit-exceeded` from
 * `transfer-not-allowed` when `limitOf` names the sender's tokenId; without it the verdict is plain
 * `transfer-not-allowed`.
 */
export async function legAllowed(
  client: Client,
  args: {
    readonly deployment: Deployment;
    readonly blockNumber: bigint;
    readonly token: Currency;
    readonly from: Address;
    readonly to: Address;
    readonly amount: bigint;
    readonly limitOf?: bigint;
  },
): Promise<void> {
  const B = args.blockNumber;
  let allowed: boolean;
  try {
    allowed = asBoolean(
      await readAt(client, B, {
        ...contractTarget(args.deployment, args.token),
        functionName: "tokenTransferAllowed",
        args: [args.from, args.to, args.amount],
      }),
    );
  } catch (error) {
    remapRevert(error);
  }
  if (allowed) {
    return;
  }
  if (args.limitOf !== undefined) {
    const chf = asBigint(
      await readAt(client, B, {
        ...contractTarget(args.deployment, args.token),
        functionName: "convertToChf",
        args: [args.amount],
      }),
    );
    const within = asBoolean(
      await readAt(client, B, {
        ...contractTarget(args.deployment, "account"),
        functionName: "checkLimit",
        args: [args.limitOf, chf],
      }),
    );
    if (!within) {
      throw new Fiat24Error("limit-exceeded", "limit exceeded");
    }
  }
  throw new Fiat24Error("transfer-not-allowed", "transfer not allowed");
}

/** §5: `ownerOf(tokenId)` on the account contract at B — the internal desks 9100/9102/9105. */
export async function deskOwner(
  client: Client,
  args: { readonly deployment: Deployment; readonly blockNumber: bigint; readonly tokenId: bigint },
): Promise<Address> {
  return asAddress(
    await readAt(client, args.blockNumber, {
      ...contractTarget(args.deployment, "account"),
      functionName: "ownerOf",
      args: [args.tokenId],
    }),
  );
}

/**
 * §5/I11: `amount > totalSupply(asset)` at B ⇒ `unlimited-approval` — runs in every approve tx's
 * guard, on top of the builder's `< 10^18` bound.
 */
export async function supplyBound(
  client: Client,
  args: {
    readonly deployment: Deployment;
    readonly blockNumber: bigint;
    readonly asset: Asset;
    readonly amount: bigint;
  },
): Promise<void> {
  const { asset } = args;
  const target =
    asset === "USDC"
      ? { address: args.deployment.usdc, abi: erc20Abi }
      : contractTarget(args.deployment, asset === "F24" ? "f24" : asset);
  const supply = asBigint(
    await readAt(client, args.blockNumber, {
      ...target,
      functionName: "totalSupply",
    }),
  );
  if (args.amount > supply) {
    throw new Fiat24Error("unlimited-approval", "unlimited approval");
  }
}
