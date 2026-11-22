import { isAddressEqual } from "viem";
import type { Address, Client, Hex, TransactionReceipt } from "viem";

import { apiError } from "../api/http.ts";
import { freeze } from "../api/schemas.ts";
import { parseSwissQr } from "../api/swiss-qr.ts";
import type { Fiat24Session } from "../api/types.ts";
import { isValidContactId, isValidPayoutRef, payoutCall, payoutRefCall } from "../calls/payout.ts";
import { checkedAmount } from "../calls/types.ts";
import { getAvailability } from "../chain/availability.ts";
import {
  asBigint,
  checkedAddress,
  checkedPayoutCurrency,
  contractTarget,
  readAt,
  resolveDeployment,
  topic0Of,
} from "../chain/context.ts";
import { getPayoutMinimum } from "../chain/payout.ts";
import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { PayoutCurrency } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { decodeFiat24Log } from "../events/decode.ts";
import { assertUnpaused, checkedSigner, deskOwner, legAllowed, senderLive } from "./guards.ts";
import { checkedState } from "./state.ts";
import { advanceTx } from "./tx.ts";
import type { TxEvidence } from "./tx.ts";
import type { FlowDeps, PayoutDraft, PayoutState, PayoutTarget, TxRecord } from "./types.ts";

// The payout desk's internal account (§10.6): the outbound leg is owner → desk.
const PAYOUT_DESK = 9102n;

const PAYOUT_TARGET_KINDS: ReadonlySet<string> = new Set(["contact", "bank", "swiss-qr"]);

function invalidState(): never {
  throw new Fiat24Error("invalid-state", "invalid flow state");
}

function invalidArgument(): never {
  throw new Fiat24Error("invalid-argument", "invalid argument");
}

// A /verify binding miss is the api layer's own verdict shape (§9.5, I3).
function apiMismatch(): never {
  throw apiError("api-mismatch", "GET /verify");
}

/**
 * §10.6: draft fields re-checked on every entry — `startPayout`'s own validation, reused by
 * `advancePayout(draft)` so a tampered in-memory draft can never reach I/O. Returns the checksummed
 * owner.
 */
function checkedDraft(input: {
  readonly owner: Address;
  readonly tokenId: bigint;
  readonly currency: PayoutCurrency;
  readonly amount: bigint;
  readonly target: PayoutTarget;
}): Address {
  const owner = checkedAddress(input.owner);
  assertTokenId(input.tokenId);
  checkedPayoutCurrency(input.currency);
  checkedAmount(input.amount);
  const { target } = input;
  if (typeof target !== "object" || target === null || !PAYOUT_TARGET_KINDS.has(target.kind)) {
    invalidArgument();
  }
  switch (target.kind) {
    case "contact":
      if (!isValidContactId(target.contactId)) {
        invalidArgument();
      }
      break;
    case "bank":
      // Object shape only — the /verify bindings and the api's deep checks do the rest.
      if (typeof target.request !== "object" || target.request === null) {
        invalidArgument();
      }
      break;
    case "swiss-qr": {
      const scanned = parseSwissQr(target.qr);
      if (`${scanned.currency}24` !== input.currency || scanned.amount !== input.amount) {
        invalidArgument();
      }
      break;
    }
  }
  return owner;
}

/**
 * §10.6: field checks only, no chain reads. The draft holds unverified payee PII — it is
 * memory-only, never passed to `persist`, and `encodeFlowState` refuses it.
 */
export function startPayout(input: {
  readonly owner: Address;
  readonly tokenId: bigint;
  readonly currency: PayoutCurrency;
  readonly amount: bigint;
  readonly target: PayoutTarget;
}): PayoutDraft {
  const owner = checkedDraft(input);
  return freeze({ ...input, flow: "payout", step: "draft", owner });
}

/** §10.6: `deps.session` for the draft's tokenId, else the flow cannot verify. */
function checkedSession(deps: FlowDeps, tokenId: bigint): Fiat24Session {
  const { session } = deps;
  if (session === undefined) {
    throw new Fiat24Error("session-required", "session required");
  }
  if (session.tokenId !== tokenId) {
    invalidArgument();
  }
  return session;
}

// I3: the flow re-binds what /verify returned — the api checks too, but a hostile
// or buggy session implementation must not reach a payout the host never verified.
async function verifyTarget(
  session: Fiat24Session,
  draft: PayoutDraft,
): Promise<{ readonly contactId: string; readonly purposeId: bigint; readonly ref: string }> {
  const { target } = draft;
  if (target.kind === "bank") {
    const verified = await session.verifyBankPayment(target.request);
    if (
      verified.purposeId !== target.request.purpose ||
      !isValidContactId(verified.contactId) ||
      !isValidPayoutRef(verified.ref, draft.tokenId)
    ) {
      apiMismatch();
    }
    return verified;
  }
  if (target.kind !== "swiss-qr") {
    return invalidState();
  }
  const scanned = parseSwissQr(target.qr);
  const verified = await session.verifySwissQr(target.qr);
  if (
    verified.currency !== `${scanned.currency}24` ||
    verified.currency !== draft.currency ||
    verified.amount !== scanned.amount ||
    verified.amount !== draft.amount ||
    verified.contactId !== "QRCH" ||
    !isValidPayoutRef(verified.ref, draft.tokenId) ||
    verified.account !== scanned.account
  ) {
    apiMismatch();
  }
  return verified;
}

/**
 * §10.6 main guard at B: availability + token unpaused, sender live AND the stored tokenId still
 * owned by the sender (the ref prefix and `tokenOfOwnerByIndex(sender,0)` must name the same
 * account), the contract's payout minimum, balance, and the owner → desk leg with the sender's
 * limit.
 */
async function mainGuard(
  client: Client,
  deployment: Deployment,
  state: PayoutState,
  blockNumber: bigint,
): Promise<void> {
  const availability = await getAvailability(client, { deployment, blockNumber });
  assertUnpaused(availability, [state.currency]);
  const account = await senderLive(client, {
    deployment,
    owner: state.owner,
    blockNumber,
  });
  if (account.tokenId !== state.tokenId || !account.ownsToken) {
    invalidArgument();
  }
  const minimum = await getPayoutMinimum(client, {
    deployment,
    currency: state.currency,
    blockNumber,
  });
  if (state.amount < minimum) {
    throw new Fiat24Error("below-minimum", "below minimum");
  }
  const balance = asBigint(
    await readAt(client, blockNumber, {
      ...contractTarget(deployment, state.currency),
      functionName: "balanceOf",
      args: [state.owner],
    }),
  );
  if (balance < state.amount) {
    throw new Fiat24Error("insufficient-balance", "insufficient balance");
  }
  const desk = await deskOwner(client, {
    deployment,
    blockNumber,
    tokenId: PAYOUT_DESK,
  });
  await legAllowed(client, {
    deployment,
    blockNumber,
    token: state.currency,
    from: state.owner,
    to: desk,
    amount: state.amount,
    limitOf: state.tokenId,
  });
}

function ownerTopic(owner: Address): Hex {
  return `0x${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}

// §4 payout row: `[ClientPayout | ClientPayoutRef (by ref presence), null, owner]` on the token.
function payoutEvidence(deployment: Deployment, state: PayoutState): TxEvidence {
  return {
    filters: [
      {
        address: deployment.tokens[state.currency].proxy,
        topics: [
          topic0Of(
            contractTarget(deployment, state.currency).abi,
            state.ref === undefined ? "ClientPayout" : "ClientPayoutRef",
          ),
          null,
          ownerTopic(state.owner),
        ],
      },
    ],
  };
}

/**
 * §10.6: `txid` comes from the receipt's payout event (kind by ref presence) with `sender == owner`
 * and `tokenId == state.tokenId`; none ⇒ `invalid-rpc-response`, no transition.
 */
function extractTxid(
  receipt: TransactionReceipt,
  state: PayoutState,
  deployment: Deployment,
): string {
  const kind = state.ref === undefined ? "payout" : "payout-ref";
  for (const log of receipt.logs) {
    const event = decodeFiat24Log(log, deployment);
    if (
      event !== undefined &&
      event.kind === kind &&
      isAddressEqual(event.sender, state.owner) &&
      event.tokenId === state.tokenId
    ) {
      return event.txid;
    }
  }
  throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
}

const stepFor = (record: TxRecord): PayoutState["step"] =>
  record.phase === "confirmed"
    ? "confirmed"
    : record.phase === "failed"
      ? "failed"
      : record.phase === "not-sent"
        ? "not-sent"
        : "tx";

/**
 * §10.6. A `draft` is validated as `startPayout` does (plus the signer check), verified — `contact`
 * locally, `bank`/`swiss-qr` through `GET /verify` with the I3 bindings re-checked in flow
 * (`api-mismatch` on any miss, nothing persisted) — and persisted `verified`. A `verified` state
 * appends `main{ready}` and sends it in the same advance; `tx` advances the record.
 */
export async function advancePayout(
  deps: FlowDeps,
  state: PayoutDraft | PayoutState,
): Promise<PayoutState> {
  if (state.step === "draft") {
    const owner = checkedDraft(state);
    checkedSigner(deps.signer, owner);
    const { target } = state;
    let contactId: string;
    let purposeId: bigint | undefined;
    let ref: string | undefined;
    if (target.kind === "contact") {
      ({ contactId } = target);
    } else {
      const session = checkedSession(deps, state.tokenId);
      const bound = await verifyTarget(session, state);
      ({ contactId, purposeId, ref } = bound);
    }
    const next = freeze({
      flow: "payout" as const,
      version: 1 as const,
      owner,
      txs: [],
      step: "verified" as const,
      tokenId: state.tokenId,
      currency: state.currency,
      amount: state.amount,
      contactId,
      ...(purposeId === undefined ? {} : { purposeId }),
      ...(ref === undefined ? {} : { ref }),
    });
    await deps.persist(next);
    return next;
  }
  const checked = checkedState(state, "payout");
  checkedSigner(deps.signer, checked.owner);
  const deployment = resolveDeployment(deps.client, deps.deployment);
  switch (checked.step) {
    case "confirmed":
    case "failed":
    case "not-sent":
      return invalidState();
    default:
      break;
  }
  const index = checked.step === "verified" ? checked.txs.length : checked.txs.length - 1;
  const call =
    checked.ref === undefined || checked.purposeId === undefined
      ? payoutCall({
          currency: checked.currency,
          amount: checked.amount,
          contactId: checked.contactId,
          deployment,
        })
      : payoutRefCall({
          currency: checked.currency,
          amount: checked.amount,
          contactId: checked.contactId,
          purposeId: checked.purposeId,
          ref: checked.ref,
          tokenId: checked.tokenId,
          deployment,
        });
  let txid: string | undefined;
  const outcome = await advanceTx<PayoutState, string>(deps, {
    record: checked.txs[index],
    purpose: "main",
    call,
    owner: checked.owner,
    deployment,
    guard: async (blockNumber) => mainGuard(deps.client, deployment, checked, blockNumber),
    evidence: payoutEvidence(deployment, checked),
    onConfirmed: (receipt: TransactionReceipt) => {
      txid = extractTxid(receipt, checked, deployment);
      return txid;
    },
    commit: (record: TxRecord) =>
      freeze({
        ...checked,
        step: stepFor(record),
        txs: [...checked.txs.slice(0, index), record],
        ...(txid === undefined ? {} : { txid }),
      }),
  });
  return outcome.state;
}
