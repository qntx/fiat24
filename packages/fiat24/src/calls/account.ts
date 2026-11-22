import { encodeFunctionData } from "viem";

import { accountAbi } from "../abi/index.ts";
import { isStandardMintId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { checkedDeployment, freezeCall } from "./types.ts";
import type { Fiat24Call } from "./types.ts";

function checkedMintId(tokenId: bigint): void {
  if (typeof tokenId !== "bigint" || !isStandardMintId(tokenId)) {
    throw new Fiat24Error("invalid-account-id", "invalid account id");
  }
}

/** `mintByClient(tokenId)` — F24-priced account mint (`Fiat24Account.sol:92-96`). */
export function mintAccountCall(args: { tokenId: bigint; deployment?: Deployment }): Fiat24Call {
  const deployment = checkedDeployment(args.deployment);
  checkedMintId(args.tokenId);
  return freezeCall({
    to: deployment.account.proxy,
    data: encodeFunctionData({
      abi: accountAbi,
      functionName: "mintByClient",
      args: [args.tokenId],
    }),
    value: 0n,
    intent: { kind: "mint", tokenId: args.tokenId, payment: "f24" },
    contracts: ["account", "priceList", "f24"],
  } satisfies Fiat24Call);
}

/** `mintByClientWithETH(tokenId)` payable (`Fiat24Account.sol:98-115`); `value` is the ETH price. */
export function mintAccountWithEthCall(args: {
  tokenId: bigint;
  value: bigint;
  deployment?: Deployment;
}): Fiat24Call {
  const deployment = checkedDeployment(args.deployment);
  checkedMintId(args.tokenId);
  if (typeof args.value !== "bigint" || args.value <= 0n) {
    throw new Fiat24Error("invalid-amount", "invalid amount");
  }
  return freezeCall({
    to: deployment.account.proxy,
    data: encodeFunctionData({
      abi: accountAbi,
      functionName: "mintByClientWithETH",
      args: [args.tokenId],
    }),
    value: args.value,
    intent: { kind: "mint", tokenId: args.tokenId, payment: "eth" },
    contracts: ["account", "priceList", "f24", "f24Sales"],
  } satisfies Fiat24Call);
}
