import { encodeFunctionData } from "viem";

import { tokenAbi } from "../abi/index.ts";
import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { PayoutCurrency } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { checkedAmount, checkedDeployment, freezeCall } from "./types.ts";
import type { Fiat24Call } from "./types.ts";

/** The only currencies with a Fiat24 payout rail (§6.1). */
export const PAYOUT_CURRENCIES: ReadonlyArray<PayoutCurrency> = Object.freeze(["EUR24", "CHF24"]);

const CONTACT_ID = /^[A-Z]{2,8}(-[0-9]{1,16})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `^[A-Z]{2,8}(-[0-9]{1,16})?$` (§6.2); never throws. */
export function isValidContactId(text: string): boolean {
  return typeof text === "string" && CONTACT_ID.test(text);
}

/**
 * §6.2 `P "-" U Z`: the payer's tokenId in canonical decimal, a lowercase uuid, then zero or more
 * U+0000; padding, when present, must fill the field to exactly 45 chars (observed on chain:
 * `690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\0\0`). Never throws.
 */
export function isValidPayoutRef(text: string, tokenId: bigint): boolean {
  if (typeof text !== "string" || typeof tokenId !== "bigint" || tokenId < 1n) {
    return false;
  }
  const prefix = `${tokenId}-`;
  if (!text.startsWith(prefix) || !UUID.test(text.slice(prefix.length, prefix.length + 36))) {
    return false;
  }
  const padding = text.slice(prefix.length + 36);
  if (padding.length === 0) {
    return true;
  }
  return text.length === 45 && padding.split("").every((ch) => ch === "\u0000");
}

function checkedPayoutCurrency(currency: unknown): PayoutCurrency {
  if (currency !== "EUR24" && currency !== "CHF24") {
    throw new Fiat24Error("unsupported-currency", "unsupported currency");
  }
  return currency;
}

function checkedContactId(contactId: string): string {
  if (!isValidContactId(contactId)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  return contactId;
}

/** `clientPayout(amount, contactId)` (`Fiat24Token.sol:132-138`). */
export function payoutCall(args: {
  currency: PayoutCurrency;
  amount: bigint;
  contactId: string;
  deployment?: Deployment;
}): Fiat24Call {
  const deployment = checkedDeployment(args.deployment);
  const currency = checkedPayoutCurrency(args.currency);
  const contactId = checkedContactId(args.contactId);
  checkedAmount(args.amount);
  return freezeCall({
    to: deployment.tokens[currency].proxy,
    data: encodeFunctionData({
      abi: tokenAbi,
      functionName: "clientPayout",
      args: [args.amount, contactId],
    }),
    value: 0n,
    intent: { kind: "payout", currency, amount: args.amount, contactId, payee: "off-chain" },
    contracts: [currency, "account"],
  } satisfies Fiat24Call);
}

/**
 * `clientPayoutRef(amount, contactId, purposeId, ref)` (`Fiat24Token.sol:140-146`); the ref goes
 * out verbatim, NUL padding included.
 */
export function payoutRefCall(args: {
  currency: PayoutCurrency;
  amount: bigint;
  contactId: string;
  purposeId: bigint;
  ref: string;
  tokenId: bigint;
  deployment?: Deployment;
}): Fiat24Call {
  const deployment = checkedDeployment(args.deployment);
  const currency = checkedPayoutCurrency(args.currency);
  const contactId = checkedContactId(args.contactId);
  assertTokenId(args.tokenId);
  if (typeof args.purposeId !== "bigint" || args.purposeId < 0n || args.purposeId > 1_000_000n) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  if (!isValidPayoutRef(args.ref, args.tokenId)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  checkedAmount(args.amount);
  return freezeCall({
    to: deployment.tokens[currency].proxy,
    data: encodeFunctionData({
      abi: tokenAbi,
      functionName: "clientPayoutRef",
      args: [args.amount, contactId, args.purposeId, args.ref],
    }),
    value: 0n,
    intent: {
      kind: "payout",
      currency,
      amount: args.amount,
      contactId,
      purposeId: args.purposeId,
      ref: args.ref,
      payee: "off-chain",
    },
    contracts: [currency, "account"],
  } satisfies Fiat24Call);
}
