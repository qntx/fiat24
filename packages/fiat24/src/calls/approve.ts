import { encodeFunctionData, erc20Abi } from "viem";
import type { Address } from "viem";

import { f24Abi, tokenAbi } from "../abi/index.ts";
import { Fiat24Error } from "../core/errors.ts";
import { MAX_UNITS } from "../core/money.ts";
import type { ApprovalSpender, Asset, ContractName } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { checkedAsset, checkedDeployment, freezeCall } from "./types.ts";
import type { Fiat24Call } from "./types.ts";

const SPENDERS: ReadonlySet<string> = new Set(["card", "deposit", "account"]);

function spenderAddress(deployment: Deployment, spender: ApprovalSpender): Address {
  const proxies: Record<ApprovalSpender, Address> = {
    card: deployment.card.proxy,
    deposit: deployment.deposit.proxy,
    account: deployment.account.proxy,
  };
  return proxies[spender];
}

/**
 * `approve(spender, amount)` on the asset contract (§6.1). Approvals stay bounded (I11): `amount >=
 * MAX_UNITS` ⇒ `unlimited-approval`; `0` is allowed (revoke). Allowed pairs only:
 * cash→`card`/`deposit`, USDC→`deposit`, F24→`account`.
 */
export function approveCall(args: {
  asset: Asset;
  spender: ApprovalSpender;
  amount: bigint;
  deployment?: Deployment;
}): Fiat24Call {
  const deployment = checkedDeployment(args.deployment);
  const asset = checkedAsset(args.asset);
  const { spender } = args;
  if (typeof spender !== "string" || !SPENDERS.has(spender)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  if (typeof args.amount !== "bigint" || args.amount < 0n) {
    throw new Fiat24Error("invalid-amount", "invalid amount");
  }
  if (args.amount >= MAX_UNITS) {
    throw new Fiat24Error("unlimited-approval", "unlimited approval");
  }
  const allowed =
    (asset !== "USDC" && asset !== "F24" && (spender === "card" || spender === "deposit")) ||
    (asset === "USDC" && spender === "deposit") ||
    (asset === "F24" && spender === "account");
  if (!allowed) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }

  const spenderAddr = spenderAddress(deployment, spender);
  let to;
  let data;
  let contracts: ContractName[];
  if (asset === "USDC") {
    to = deployment.usdc;
    data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spenderAddr, args.amount],
    });
    contracts = ["deposit"];
  } else if (asset === "F24") {
    to = deployment.f24.address;
    data = encodeFunctionData({
      abi: f24Abi,
      functionName: "approve",
      args: [spenderAddr, args.amount],
    });
    contracts = ["f24", "account"];
  } else {
    to = deployment.tokens[asset].proxy;
    data = encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [spenderAddr, args.amount],
    });
    contracts = [asset, spender];
  }

  return freezeCall({
    to,
    data,
    value: 0n,
    intent: { kind: "approve", asset, spender, amount: args.amount },
    contracts,
  } satisfies Fiat24Call);
}
