import type { Address, Client } from "viem";
import { getAddress, isAddress } from "viem";

import { accountAbi, tokenAbi } from "../abi/index.ts";
import { transferCall, transferToAccountCall } from "../calls/transfer.ts";
import { isInternalAccount } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { Currency, Recipient } from "../core/types.ts";
import { resolveAccount } from "./account.ts";
import type { ChainArgs } from "./context.ts";
import { readAt, revertError, snapshot } from "./context.ts";

type AnyClient = Client;

/** SPEC §3.6. */
export type TransferCheck = {
  readonly recipient: Address;
  readonly recipientTokenId: bigint | undefined;
  readonly blockNumber: bigint;
};

const invalidResponse = (): never => {
  throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
};

function asBigint(value: unknown): bigint {
  return typeof value === "bigint" ? value : invalidResponse();
}

function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalidResponse();
}

function asAddress(value: unknown): Address {
  return typeof value === "string" && isAddress(value, { strict: false })
    ? getAddress(value)
    : invalidResponse();
}

// checkTransfer's later steps map contract reverts through the §6.3 table, not
// the plain contract-revert bucket (§8.4 step 5).
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
 * SPEC §8.4 — the same ordered refusals the contract would give, checked locally and on chain at
 * one B: (0) build the call to inherit its local refusals; (1) resolve the recipient; (2) sender
 * must have an account and be live; (3) recipient's account must exist, not be an internal desk
 * (I12 by resolved address), not be a stale owner (I17) and be Live/SoftBlocked (I18); (4) balance;
 * (5) the contract's own `tokenTransferAllowed` verdict, with `checkLimit` splitting limit-exceeded
 * from transfer-not-allowed.
 */
export async function checkTransfer(
  client: AnyClient,
  args: ChainArgs & { from: Address; to: Recipient; currency: Currency; amount: bigint },
): Promise<TransferCheck> {
  const { deployment, blockNumber: B } = await snapshot(client, args);

  // Step 0 — local refusals ride on the builders (invalid-address, internal-account,
  // currency and amount checks), never re-implemented here.
  if ("address" in args.to) {
    transferCall({
      currency: args.currency,
      to: args.to.address,
      amount: args.amount,
      deployment,
    });
  } else {
    transferToAccountCall({
      currency: args.currency,
      tokenId: args.to.tokenId,
      amount: args.amount,
      deployment,
    });
  }
  const { currency, amount } = args;
  if (typeof args.from !== "string" || !isAddress(args.from, { strict: false })) {
    throw new Fiat24Error("invalid-address", "invalid address");
  }
  const from = getAddress(args.from);
  const token = deployment.tokens[currency].proxy;
  const account = deployment.account.proxy;

  // Step 1 — resolve the recipient address.
  let recipient: Address;
  if ("tokenId" in args.to) {
    const { tokenId } = args.to;
    const exists = asBoolean(
      await readAt(client, B, {
        address: account,
        abi: accountAbi,
        functionName: "exists",
        args: [tokenId],
      }),
    );
    if (!exists) {
      throw new Fiat24Error("no-account", "no account");
    }
    recipient = asAddress(
      await readAt(client, B, {
        address: account,
        abi: accountAbi,
        functionName: "ownerOf",
        args: [tokenId],
      }),
    );
  } else {
    recipient = getAddress(args.to.address);
  }

  // Steps 2+3 — both resolutions in one round, verdicts checked in order.
  const [sender, receiver] = await Promise.all([
    resolveAccount(client, deployment, B, from),
    resolveAccount(client, deployment, B, recipient),
  ]);
  if (sender === undefined) {
    throw new Fiat24Error("no-account", "no account");
  }
  if (sender.account.status !== "live") {
    throw new Fiat24Error("not-live", "sender account not live");
  }
  if (receiver === undefined) {
    throw new Fiat24Error("recipient-not-live", "recipient not live");
  }
  if (isInternalAccount(receiver.account.tokenId)) {
    throw new Fiat24Error("internal-account", "internal account");
  }
  if (!receiver.account.ownsToken && receiver.via === "historic") {
    // I17: historicOwnership resolves the account but the NFT moved — the old
    // address still receives tokens, which is exactly what the sender doesn't want.
    throw new Fiat24Error("stale-recipient", "stale recipient");
  }
  const recipientStatus = receiver.account.status;
  if (recipientStatus !== "live" && recipientStatus !== "soft-blocked") {
    throw new Fiat24Error("recipient-not-live", "recipient not live");
  }

  // Step 4 — plain balance check.
  const balance = asBigint(
    await readAt(client, B, {
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [from],
    }),
  );
  if (balance < amount) {
    throw new Fiat24Error("insufficient-balance", "insufficient balance");
  }

  // Step 5 — the contract's own decision (Fiat24Token.sol:156-206); a revert is
  // already a verdict, mapped by §6.3.
  let allowed: boolean;
  try {
    allowed = asBoolean(
      await readAt(client, B, {
        address: token,
        abi: tokenAbi,
        functionName: "tokenTransferAllowed",
        args: [from, recipient, amount],
      }),
    );
  } catch (error) {
    remapRevert(error);
  }
  if (!allowed) {
    const chf = asBigint(
      await readAt(client, B, {
        address: token,
        abi: tokenAbi,
        functionName: "convertToChf",
        args: [amount],
      }),
    );
    const withinLimit = asBoolean(
      await readAt(client, B, {
        address: account,
        abi: accountAbi,
        functionName: "checkLimit",
        args: [sender.account.tokenId, chf],
      }),
    );
    if (!withinLimit) {
      throw new Fiat24Error("limit-exceeded", "limit exceeded");
    }
    // The contract gives no finer reason (sanctions, recipient's own limit, ...) —
    // documented as transfer-not-allowed (§8.4).
    throw new Fiat24Error("transfer-not-allowed", "transfer not allowed");
  }
  return {
    recipient,
    recipientTokenId: receiver.account.tokenId,
    blockNumber: B,
  };
}
