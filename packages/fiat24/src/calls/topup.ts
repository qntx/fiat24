import { encodeFunctionData } from "viem";

import { depositAbi } from "../abi/index.ts";
import type { ContractName, Currency } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { checkedAmount, checkedCurrency, checkedDeployment, freezeCall } from "./types.ts";
import type { Fiat24Call } from "./types.ts";

/**
 * `depositTokenViaUsdc(usdc, outputToken, usdcAmount)` (`Fiat24CryptoDeposit.sol:212-269`): the
 * input leg is always the pinned USDC (`:212,224`), the output a cash token pulled from the crypto
 * desk (`:258-259`); the fee leg moves USD24 crypto desk → fee desk (`:253`), which is why `USD24`
 * is on the verified path even for other outputs (§6.1).
 */
export function topUpCall(args: {
  output: Currency;
  usdcAmount: bigint;
  deployment?: Deployment;
}): Fiat24Call {
  const deployment = checkedDeployment(args.deployment);
  const output = checkedCurrency(args.output);
  checkedAmount(args.usdcAmount);
  const contracts: ContractName[] =
    output === "USD24" ? ["deposit", "account", "USD24"] : ["deposit", "account", output, "USD24"];
  return freezeCall({
    to: deployment.deposit.proxy,
    data: encodeFunctionData({
      abi: depositAbi,
      functionName: "depositTokenViaUsdc",
      args: [deployment.usdc, deployment.tokens[output].proxy, args.usdcAmount],
    }),
    value: 0n,
    intent: { kind: "top-up", output, usdcAmount: args.usdcAmount },
    contracts,
  } satisfies Fiat24Call);
}
