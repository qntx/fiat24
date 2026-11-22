import { encodeFunctionData } from "viem";

import { tokenAbi } from "../abi/index.ts";
import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import { freeze } from "../core/freeze.ts";
import { isValidContactId, isValidPayoutRef } from "../core/payout-grammar.ts";
import type { PayoutCurrency } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { checkedAmount, checkedDeployment, freezeCall } from "./types.ts";
import type { Fiat24Call } from "./types.ts";

/** The only currencies with a Fiat24 payout rail (§6.1). */
export const PAYOUT_CURRENCIES: ReadonlyArray<PayoutCurrency> = /* @__PURE__ */ freeze([
  "EUR24",
  "CHF24",
]);

// The §6.2 grammars live in core so api can run the §10.6 /verify bindings without a
// `core -> calls` or `api -> calls` edge; the calls public surface re-exports them unchanged.
export { isValidContactId, isValidPayoutRef } from "../core/payout-grammar.ts";

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
