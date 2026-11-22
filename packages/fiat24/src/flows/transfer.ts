import { getAddress, isAddress, isAddressEqual } from "viem";
import type { Address, Client, TransactionReceipt } from "viem";

import { freeze } from "../api/schemas.ts";
import { transferCall, transferToAccountCall } from "../calls/transfer.ts";
import { getAvailability } from "../chain/availability.ts";
import {
  checkedAddress,
  contractTarget,
  resolveDeployment,
  snapshot,
  topic0Of,
} from "../chain/context.ts";
import { checkTransfer } from "../chain/transfer.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { Currency, Recipient } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { decodeFiat24Log } from "../events/decode.ts";
import { assertUnpaused, checkedSigner } from "./guards.ts";
import { checkedState } from "./state.ts";
import { advanceTx } from "./tx.ts";
import type { TxEvidence } from "./tx.ts";
import type { FlowDeps, TransferState, TxRecord } from "./types.ts";

function invalidState(): never {
  throw new Fiat24Error("invalid-state", "invalid flow state");
}

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
  blockNumber: bigint,
): Promise<void> {
  const check = await checkTransfer(client, {
    deployment,
    from: state.owner,
    to: state.to,
    currency: state.currency,
    amount: state.amount,
    blockNumber,
  });
  const availability = await getAvailability(client, { deployment, blockNumber });
  assertUnpaused(availability, [state.currency]);
  if (isAddressEqual(check.recipient, state.owner)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
}

// Matches the §10.4 transfer row — `Transfer(owner, …)` on the token proxy —
// restricted by args so a wallet's other transfers at nonce N don't collide.
function transferEvidence(deployment: Deployment, state: TransferState): TxEvidence {
  return {
    filters: [
      {
        address: deployment.tokens[state.currency].proxy,
        topics: [
          topic0Of(contractTarget(deployment, state.currency).abi, "Transfer"),
          `0x${state.owner.slice(2).padStart(64, "0")}`,
        ],
      },
    ],
    check: (candidate) =>
      candidate.kind === "fiat24" &&
      candidate.event.kind === "transfer" &&
      candidate.event.currency === state.currency &&
      isAddressEqual(candidate.event.from, state.owner) &&
      candidate.event.amount === state.amount &&
      (!("address" in state.to) || isAddressEqual(candidate.event.to, state.to.address)),
  };
}

// A confirmed transfer must carry its Transfer event in the receipt (§10.4);
// absence means the receipt is not ours ⇒ invalid-rpc-response, no transition.
function assertTransferLog(receipt: TransactionReceipt, state: TransferState): void {
  const found = receipt.logs.some((log) => {
    const event = decodeFiat24Log(log);
    return (
      event !== undefined &&
      event.kind === "transfer" &&
      event.currency === state.currency &&
      isAddressEqual(event.from, state.owner) &&
      event.amount === state.amount &&
      (!("address" in state.to) || isAddressEqual(event.to, state.to.address))
    );
  });
  if (!found) {
    throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
  }
}

const stepFor = (record: TxRecord): TransferState["step"] =>
  record.phase === "confirmed"
    ? "confirmed"
    : record.phase === "failed"
      ? "failed"
      : record.phase === "not-sent"
        ? "not-sent"
        : "tx";

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
    case "confirmed":
    case "failed":
    case "not-sent":
      return invalidState();
    case "draft": {
      const { blockNumber } = await snapshot(deps.client, { deployment });
      await transferGuards(deps.client, deployment, checked, blockNumber);
      const next = freeze({ ...checked, step: "ready" as const });
      await deps.persist(next);
      return next;
    }
    default: {
      const call = buildCall(checked, deployment);
      const index = checked.txs.length === 0 ? 0 : checked.txs.length - 1;
      const outcome = await advanceTx<TransferState, undefined>(deps, {
        record: checked.txs[index],
        purpose: "main",
        call,
        owner: checked.owner,
        deployment,
        guard: async (blockNumber) => transferGuards(deps.client, deployment, checked, blockNumber),
        evidence: transferEvidence(deployment, checked),
        onConfirmed: (receipt) => {
          assertTransferLog(receipt, checked);
        },
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
