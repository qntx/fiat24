import { encodeFunctionData, getAddress, isAddress, zeroAddress } from "viem";
import type { Address } from "viem";

import { tokenAbi } from "../abi/index.ts";
import { assertTokenId, isInternalAccount } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import { CURRENCIES } from "../core/types.ts";
import type { Currency } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { checkedAmount, checkedCurrency, checkedDeployment, freezeCall } from "./types.ts";
import type { Fiat24Call } from "./types.ts";

const ZERO = zeroAddress.toLowerCase();

/**
 * Every address the deployment pins: all proxy/implementation/admin triples plus f24, usdc and the
 * proxyAdmin pair. Sending a cash transfer to any of them burns the tokens, so it is refused
 * locally (§6.1).
 */
function deploymentAddresses(deployment: Deployment): ReadonlySet<string> {
  const out = new Set<string>();
  const pins = [
    deployment.account,
    ...CURRENCIES.map((name) => deployment.tokens[name]),
    deployment.deposit,
    deployment.card,
    deployment.priceList,
    deployment.f24Sales,
  ];
  for (const pin of pins) {
    out.add(pin.proxy.toLowerCase());
    out.add(pin.implementation.toLowerCase());
    out.add(pin.admin.toLowerCase());
  }
  out.add(deployment.f24.address.toLowerCase());
  out.add(deployment.usdc.toLowerCase());
  out.add(deployment.proxyAdmin.address.toLowerCase());
  out.add(deployment.proxyAdmin.owner.toLowerCase());
  return out;
}

function checkedRecipient(deployment: Deployment, to: Address): Address {
  if (typeof to !== "string" || !isAddress(to) || to.toLowerCase() === ZERO) {
    throw new Fiat24Error("invalid-address", "invalid address");
  }
  if (deploymentAddresses(deployment).has(to.toLowerCase())) {
    throw new Fiat24Error("invalid-address", "invalid address");
  }
  return getAddress(to);
}

/** `transfer(to, amount)` on a cash token (§6.1). */
export function transferCall(args: {
  currency: Currency;
  to: Address;
  amount: bigint;
  deployment?: Deployment;
}): Fiat24Call {
  const deployment = checkedDeployment(args.deployment);
  const currency = checkedCurrency(args.currency);
  const to = checkedRecipient(deployment, args.to);
  checkedAmount(args.amount);
  return freezeCall({
    to: deployment.tokens[currency].proxy,
    data: encodeFunctionData({
      abi: tokenAbi,
      functionName: "transfer",
      args: [to, args.amount],
    }),
    value: 0n,
    intent: { kind: "transfer", currency, amount: args.amount, to: { address: to } },
    contracts: [currency, "account"],
  } satisfies Fiat24Call);
}

/** `transferByAccountId(tokenId, amount)` (`Fiat24Token.sol:148-150`); I12 refuses internal ids. */
export function transferToAccountCall(args: {
  currency: Currency;
  tokenId: bigint;
  amount: bigint;
  deployment?: Deployment;
}): Fiat24Call {
  const deployment = checkedDeployment(args.deployment);
  const currency = checkedCurrency(args.currency);
  assertTokenId(args.tokenId);
  if (isInternalAccount(args.tokenId)) {
    throw new Fiat24Error("internal-account", "internal account");
  }
  checkedAmount(args.amount);
  return freezeCall({
    to: deployment.tokens[currency].proxy,
    data: encodeFunctionData({
      abi: tokenAbi,
      functionName: "transferByAccountId",
      args: [args.tokenId, args.amount],
    }),
    value: 0n,
    intent: { kind: "transfer", currency, amount: args.amount, to: { tokenId: args.tokenId } },
    contracts: [currency, "account"],
  } satisfies Fiat24Call);
}
