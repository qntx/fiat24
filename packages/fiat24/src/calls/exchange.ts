import { encodeFunctionData } from "viem";

import { depositAbi } from "../abi/index.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { Currency } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { checkedAmount, checkedCurrency, checkedDeployment, freezeCall } from "./types.ts";
import type { Fiat24Call } from "./types.ts";

const SIDES: ReadonlySet<string> = new Set(["exact-in", "exact-out"]);

/**
 * `moneyExchangeExactIn`/`moneyExchangeExactOut` on the deposit contract
 * (`Fiat24CryptoDeposit.sol:369-404`). In both functions `_inputToken` is the currency debited from
 * the caller and `_outputToken` the currency paid out. What `amount` means differs by side:
 * exact-in passes `_inputAmount`, the exact `from` amount debited (`:374-375,381`); exact-out
 * passes `_outputAmount`, the exact `to` amount credited (`:387,397` — the contract computes and
 * debits the required input, which is why flows bound it with an exact allowance, I16).
 */
export function exchangeCall(args: {
  side: "exact-in" | "exact-out";
  from: Currency;
  to: Currency;
  amount: bigint;
  deployment?: Deployment;
}): Fiat24Call {
  const deployment = checkedDeployment(args.deployment);
  const { side } = args;
  if (typeof side !== "string" || !SIDES.has(side)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const from = checkedCurrency(args.from);
  const to = checkedCurrency(args.to);
  if (from === to) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  checkedAmount(args.amount);
  return freezeCall({
    to: deployment.deposit.proxy,
    data: encodeFunctionData({
      abi: depositAbi,
      functionName: side === "exact-in" ? "moneyExchangeExactIn" : "moneyExchangeExactOut",
      args: [deployment.tokens[from].proxy, deployment.tokens[to].proxy, args.amount],
    }),
    value: 0n,
    intent: { kind: "exchange", side, from, to, amount: args.amount },
    contracts: ["deposit", from, to, "account"],
  } satisfies Fiat24Call);
}
