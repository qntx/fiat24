import type { Address } from "viem";

import { freeze } from "../api/schemas.ts";
import { getAccount } from "../chain/account.ts";
import { getAvailability } from "../chain/availability.ts";
import { getBalances, getAllowances } from "../chain/balances.ts";
import { checkedAddress, snapshot } from "../chain/context.ts";
import type { AccountView, FlowDeps } from "./types.ts";

/**
 * SPEC §10.3 — the read model; nothing persisted. One `snapshot` block B pins every read; `step` is
 * `ownsToken ? status : "stale"` (I17: historicOwnership resolved the account but the NFT moved —
 * funds sent there are stranded).
 */
export async function loadAccount(
  deps: Pick<FlowDeps, "client" | "deployment">,
  args: { readonly owner: Address },
): Promise<AccountView> {
  const owner = checkedAddress(args.owner);
  const { deployment, blockNumber } = await snapshot(deps.client, {
    deployment: deps.deployment,
  });
  const account = await getAccount(deps.client, { deployment, owner, blockNumber });
  if (account === undefined) {
    return freeze({ step: "no-account" });
  }
  const [balancesResult, availability, allowances] = await Promise.all([
    getBalances(deps.client, { deployment, owner, blockNumber }),
    getAvailability(deps.client, { deployment, blockNumber }),
    getAllowances(deps.client, { deployment, owner, blockNumber }),
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
