import { getAddress, isAddress, isAddressEqual } from "viem";
import type { Address, Client } from "viem";

import { transferCall, transferToAccountCall } from "../calls/transfer.ts";
import { getAvailability } from "../chain/availability.ts";
import {
  addressTopic,
  checkedAddress,
  contractTarget,
  resolveDeployment,
  topic0Of,
} from "../chain/context.ts";
import { checkTransfer } from "../chain/transfer.ts";
import { Fiat24Error } from "../core/errors.ts";
import { freeze } from "../core/freeze.ts";
import type { Currency, Recipient } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { assertUnpaused, checkedSigner, contractsOf, verifiedBlock } from "./guards.ts";
import type { VerifiedBlock } from "./guards.ts";
import { checkedState, invalidState } from "./state.ts";
import { advanceTx, recheckTx, stepFor } from "./tx.ts";
import type { TxEvidence } from "./tx.ts";
import type { FlowDeps, TransferState } from "./types.ts";

function buildCall(state: TransferState, deployment: Deployment): ReturnType<typeof transferCall> {
  return "address" in state.to
    ? transferCall({
        currency: state.currency,
        to: state.to.address,
        amount: state.amount,
        deployment,
      })
    : transferToAccountCall({
        currency: state.currency,
        tokenId: state.to.tokenId,
        amount: state.amount,
        deployment,
      });
}

/**
 * SPEC §10.4: `transferCall` for `{address}` (`transferCall`'s address/amount checks ride along),
 * `transferToAccountCall` for `{tokenId}` — exactly one of the two, else `invalid-argument`.
 * `{address}` equal to `owner` ⇒ `invalid-argument`. No chain reads; returns `step:"draft"` with
 * `txs:[]`.
 */
export function startTransfer(input: {
  readonly owner: Address;
  readonly currency: Currency;
  readonly amount: bigint;
  readonly to: Recipient;
}): TransferState {
  const owner = checkedAddress(input.owner);
  const to: unknown = input.to;
  if (
    typeof to !== "object" ||
    to === null ||
    "address" in to === "tokenId" in to ||
    ("address" in to &&
      (typeof to["address"] !== "string" || !isAddress(to["address"], { strict: false }))) ||
    ("tokenId" in to && typeof to["tokenId"] !== "bigint")
  ) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  if ("address" in input.to) {
    const recipient = getAddress(input.to.address);
    if (isAddressEqual(recipient, owner)) {
      throw new Fiat24Error("invalid-argument", "invalid argument");
    }
    transferCall({ currency: input.currency, to: recipient, amount: input.amount });
    return freeze({
      flow: "transfer",
      version: 1,
      owner,
      txs: [],
      step: "draft",
      currency: input.currency,
      amount: input.amount,
      to: { address: recipient },
    });
  }
  transferToAccountCall({
    currency: input.currency,
    tokenId: input.to.tokenId,
    amount: input.amount,
  });
  return freeze({
    flow: "transfer",
    version: 1,
    owner,
    txs: [],
    step: "draft",
    currency: input.currency,
    amount: input.amount,
    to: { tokenId: input.to.tokenId },
  });
}

// §10.4 draft→ready guards, re-run at the ready-phase block before every send.
async function transferGuards(
  client: Client,
  deployment: Deployment,
  state: TransferState,
  at: VerifiedBlock,
): Promise<void> {
  const check = await checkTransfer(client, {
    deployment,
    from: state.owner,
    to: state.to,
    currency: state.currency,
    amount: state.amount,
    blockNumber: at.blockNumber,
  });
  const availability = await getAvailability(client, {
    deployment,
    blockNumber: at.blockNumber,
  });
  assertUnpaused(availability, [state.currency]);
  if (isAddressEqual(check.recipient, state.owner)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
}

// The §10.4 transfer row — `Transfer(owner, …)` on the token proxy. No args-level
// check: the five-field transaction binding, not the log fields, decides evidence (§4).
function transferEvidence(deployment: Deployment, state: TransferState): TxEvidence {
  return {
    filters: [
      {
        address: deployment.tokens[state.currency].proxy,
        topics: [
          topic0Of(contractTarget(deployment, state.currency).abi, "Transfer"),
          addressTopic(state.owner),
        ],
      },
    ],
  };
}

/**
 * §10.4. `checkedState` first (any failure ⇒ `invalid-state`, before I/O), then the §3.1 signer
 * check, then: `draft` runs the guards at a fresh block and becomes `ready`; `ready`/`tx` advance
 * the §10.1 sub-machine — the call is rebuilt from the intent fields, the guards re-run at the send
 * block, and a `confirmed` record lifts the step to `confirmed`.
 */
export async function advanceTransfer(
  deps: FlowDeps,
  state: TransferState,
): Promise<TransferState> {
  const checked = checkedState(state, "transfer");
  checkedSigner(deps.signer, checked.owner);
  const deployment = resolveDeployment(deps.client, deps.deployment);
  switch (checked.step) {
    case "failed":
    case "not-sent":
      return invalidState();
    case "draft": {
      const at = await verifiedBlock(
        deps.client,
        deployment,
        contractsOf([buildCall(checked, deployment)]),
      );
      await transferGuards(deps.client, deployment, checked, at);
      const next = freeze({ ...checked, step: "ready" as const });
      await deps.persist(next);
      return next;
    }
    default: {
      const call = buildCall(checked, deployment);
      const index = checked.txs.length === 0 ? 0 : checked.txs.length - 1;
      // `confirmed` re-checks the receipt of its last transaction (R-12); every
      // other in-flight step advances the sub-machine.
      const outcome = await (checked.step === "confirmed" ? recheckTx : advanceTx)<
        TransferState,
        undefined
      >(deps, {
        record: checked.txs[index],
        purpose: "main",
        call,
        owner: checked.owner,
        deployment,
        guard: async (at: VerifiedBlock) => transferGuards(deps.client, deployment, checked, at),
        evidence: transferEvidence(deployment, checked),
        commit: (record) =>
          freeze({
            ...checked,
            step: stepFor(record),
            txs: [...checked.txs.slice(0, index), record],
          }),
      });
      return outcome.state;
    }
  }
}
