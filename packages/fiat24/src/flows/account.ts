import type { Address } from "viem";

import { freeze } from "../api/schemas.ts";
import { getAccount } from "../chain/account.ts";
import { getAvailability } from "../chain/availability.ts";
import { getBalances, getAllowances } from "../chain/balances.ts";
import { checkedAddress, resolveDeployment } from "../chain/context.ts";
import { verifiedBlock } from "./guards.ts";
import type { AccountView, FlowDeps } from "./types.ts";

/**
 * SPEC §10.3 — the read model; nothing persisted. One verified block pins every read — the
 * deployment of every contract the reads touch is asserted first; `step` is `ownsToken ? status :
 * "stale"` (I17: historicOwnership resolved the account but the NFT moved — funds sent there are
 * stranded). USDC is an external token, not a pinned contract.
 */
export async function loadAccount(
  deps: Pick<FlowDeps, "client" | "deployment">,
  args: { readonly owner: Address },
): Promise<AccountView> {
  const owner = checkedAddress(args.owner);
  const deployment = resolveDeployment(deps.client, deps.deployment);
  const at = await verifiedBlock(deps.client, deployment, [
    "account",
    "USD24",
    "EUR24",
    "CHF24",
    "CNH24",
    "deposit",
    "card",
    "f24Sales",
    "f24",
  ]);
  const account = await getAccount(deps.client, {
    deployment,
    owner,
    blockNumber: at.blockNumber,
  });
  if (account === undefined) {
    return freeze({ step: "no-account" });
  }
  const [balancesResult, availability, allowances] = await Promise.all([
    getBalances(deps.client, { deployment, owner, blockNumber: at.blockNumber }),
    getAvailability(deps.client, { deployment, blockNumber: at.blockNumber }),
    getAllowances(deps.client, { deployment, owner, blockNumber: at.blockNumber }),
  ]);
  return freeze({
    step: account.ownsToken ? account.status : "stale",
    account,
    balances: balancesResult.balances,
    iban: account.iban,
    availability,
    allowances,
  });
}
