import type { Address, Client, Hex } from "viem";

import { apiError } from "../api/http.ts";
import { freeze } from "../api/schemas.ts";
import type { Card as ApiCard, Fiat24Session } from "../api/types.ts";
import { approveCall } from "../calls/approve.ts";
import { getAvailability } from "../chain/availability.ts";
import { getAllowance } from "../chain/balances.ts";
import {
  checkedAddress,
  contractTarget,
  resolveDeployment,
  snapshot,
  topic0Of,
} from "../chain/context.ts";
import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { Fiat24ErrorCode } from "../core/errors.ts";
import type { Currency } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { assertUnpaused, checkedSigner, supplyBound } from "./guards.ts";
import { API_READY_ERRORS, checkedState } from "./state.ts";
import { advanceTx, persistSwallow } from "./tx.ts";
import type { TxEvidence } from "./tx.ts";
import type { CardOperation, CardState, FlowDeps, TxRecord } from "./types.ts";

function invalidState(): never {
  throw new Fiat24Error("invalid-state", "invalid flow state");
}

function invalidArgument(): never {
  throw new Fiat24Error("invalid-argument", "invalid argument");
}

const CARD_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "create",
  "set-cap",
  "block",
  "unblock",
  "set-currency",
  "device-token",
]);

function checkedTextId(text: unknown): void {
  if (typeof text !== "string" || text.length === 0 || text.length > 1024) {
    invalidArgument();
  }
}

/**
 * §10.7: `cap.amount >= 1` (a setup always approves a positive cap; `approveCall` would allow 0),
 * then the approve builder's validation — cash currency, bounded amount. `operation` is `create`,
 * `cap` rides along so the approve-to-cap can precede the write.
 */
export function startCardSetup(input: {
  readonly owner: Address;
  readonly tokenId: bigint;
  readonly cap: { readonly currency: Currency; readonly amount: bigint };
}): CardState {
  const owner = checkedAddress(input.owner);
  assertTokenId(input.tokenId);
  const { cap } = input;
  if (
    typeof cap !== "object" ||
    cap === null ||
    typeof cap.amount !== "bigint" ||
    cap.amount < 1n
  ) {
    invalidArgument();
  }
  approveCall({ asset: cap.currency, spender: "card", amount: cap.amount });
  return freeze({
    flow: "card",
    version: 1,
    owner,
    txs: [],
    step: "ready",
    tokenId: input.tokenId,
    operation: { kind: "create" },
    cap,
  });
}

/**
 * §10.7: operation shape — `externalId`/`cardTokenId` non-empty `<= 1024`, enums exact, `set-cap`
 * through `approveCall` (amount `0` is a valid revoke). `step:"ready"` with `txs:[]`.
 */
export function startCardOperation(input: {
  readonly owner: Address;
  readonly tokenId: bigint;
  readonly operation: CardOperation;
}): CardState {
  const owner = checkedAddress(input.owner);
  assertTokenId(input.tokenId);
  const { operation } = input;
  if (
    typeof operation !== "object" ||
    operation === null ||
    !CARD_OPERATION_KINDS.has(operation.kind)
  ) {
    invalidArgument();
  }
  switch (operation.kind) {
    case "create":
      break;
    case "set-cap":
      approveCall({ asset: operation.currency, spender: "card", amount: operation.amount });
      break;
    case "block":
    case "unblock":
      checkedTextId(operation.externalId);
      break;
    case "set-currency":
      checkedTextId(operation.externalId);
      if (
        operation.currency !== "EUR" &&
        operation.currency !== "USD" &&
        operation.currency !== "CHF" &&
        operation.currency !== "CNH"
      ) {
        invalidArgument();
      }
      break;
    case "device-token":
      checkedTextId(operation.externalId);
      checkedTextId(operation.cardTokenId);
      if (operation.status !== "activate" && operation.status !== "deactivate") {
        invalidArgument();
      }
      break;
  }
  return freeze({
    flow: "card",
    version: 1,
    owner,
    txs: [],
    step: "ready",
    tokenId: input.tokenId,
    operation,
  });
}

/**
 * The API write this operation performs — the endpoint string the error classification keys on, the
 * session call, and the `GET /cards` observation that proves it landed (§10.7 targets). `set-cap`
 * never reaches here: the codec forbids a `main` record for it.
 */
type CardWrite = {
  readonly endpoint: string;
  readonly call: (session: Fiat24Session) => Promise<void>;
  readonly observed: (cards: ReadonlyArray<ApiCard>) => boolean;
};

function cardOf(cards: ReadonlyArray<ApiCard>, externalId: string): ApiCard | undefined {
  return cards.find((card) => card.externalId === externalId);
}

function writeFor(operation: CardOperation): CardWrite {
  switch (operation.kind) {
    case "create":
      return {
        endpoint: "POST /card",
        call: async (session) => session.createCard(),
        observed: (cards) => cards.length > 0,
      };
    case "block":
    case "unblock":
      return {
        endpoint: "POST /card-status",
        call: async (session) =>
          session.setCardStatus({ externalId: operation.externalId, status: operation.kind }),
        observed: (cards) =>
          cardOf(cards, operation.externalId)?.status ===
          (operation.kind === "block" ? "blocked" : "active"),
      };
    case "set-currency":
      return {
        endpoint: "PUT /card-currency",
        call: async (session) =>
          session.setCardCurrency({
            externalId: operation.externalId,
            currency: operation.currency,
          }),
        observed: (cards) =>
          cardOf(cards, operation.externalId)?.currency === `${operation.currency}24`,
      };
    case "device-token":
      return {
        endpoint: "POST /card-device-token",
        call: async (session) =>
          session.setDeviceToken({
            externalId: operation.externalId,
            cardTokenId: operation.cardTokenId,
            status: operation.status,
          }),
        observed: (cards) =>
          operation.status === "activate"
            ? (cardOf(cards, operation.externalId)?.activeTokens.some(
                (token) => token.id === operation.cardTokenId,
              ) ?? false)
            : (cardOf(cards, operation.externalId)?.inactiveTokens.some(
                (token) => token.id === operation.cardTokenId,
              ) ?? false),
      };
    default:
      return invalidState();
  }
}

/** §10.7 classification of a thrown write error. */
type WriteVerdict = "ambiguous" | "api-rejected" | Fiat24ErrorCode;

/**
 * §10.7: a write error is `api-rejected` (⇒ `failed`) only on the write's own endpoint; ambiguous
 * when the outcome cannot be told (`network-error`/`invalid-response`/`http-error >= 500` on the
 * write endpoint, or any non-Fiat24Error); every other Fiat24Error is a declined write whose code
 * lands on `ready{error}` — a code the codec's ready table cannot hold is impossible by §9.5, so it
 * degrades to ambiguous rather than producing an unpersistable state.
 */
function classifyWriteError(error: unknown, endpoint: string): WriteVerdict {
  if (!(error instanceof Fiat24Error)) {
    return "ambiguous";
  }
  if (error.detail.endpoint === endpoint) {
    if (error.code === "network-error" || error.code === "invalid-response") {
      return "ambiguous";
    }
    if (error.code === "http-error" && (error.detail.status ?? 0) >= 500) {
      return "ambiguous";
    }
    if (error.code === "api-rejected") {
      return "api-rejected";
    }
  }
  return API_READY_ERRORS.has(error.code) ? error.code : "ambiguous";
}

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

/**
 * §10.7 API write record (a `main` with no chain fields): `ready` runs the session checks and the
 * `GET /cards` pre-read — target already observed ⇒ `confirmed` with no write; a non-create op
 * whose card is absent ⇒ `api-rejected` (`GET /cards`); `create` additionally requires
 * `profile().isCardEligible` (`api-rejected`, `GET /br`). Else persist `sending` and issue the
 * write exactly once; the outcome lands per the §10.7 classification and every post-write persist
 * is swallowed (the write was issued). `sending`/`unknown` resumes read once and never write.
 */
async function advanceApiWrite(
  deps: FlowDeps,
  state: CardState,
  record: TxRecord | undefined,
  index: number,
): Promise<CardState> {
  const write = writeFor(state.operation);
  const session = checkedSession(deps, state.tokenId);
  const commit = (next: TxRecord): CardState =>
    freeze({
      ...state,
      step:
        next.phase === "confirmed"
          ? ("confirmed" as const)
          : next.phase === "failed"
            ? ("failed" as const)
            : ("tx" as const),
      txs: [...state.txs.slice(0, index), next],
    });
  if (record === undefined || record.phase === "ready") {
    if (state.operation.kind === "create") {
      const profile = await session.profile();
      if (!profile.isCardEligible) {
        throw apiError("api-rejected", "GET /br");
      }
    }
    const cards = await session.cards();
    const { operation } = state;
    if (
      operation.kind !== "create" &&
      operation.kind !== "set-cap" &&
      cardOf(cards, operation.externalId) === undefined
    ) {
      throw apiError("api-rejected", "GET /cards");
    }
    if (write.observed(cards)) {
      const next = commit({ purpose: "main", phase: "confirmed" });
      await deps.persist(next);
      return next;
    }
    await deps.persist(commit({ purpose: "main", phase: "sending" }));
    let next: TxRecord;
    try {
      await write.call(session);
      next = { purpose: "main", phase: "confirmed" };
    } catch (error) {
      const verdict = classifyWriteError(error, write.endpoint);
      if (verdict === "api-rejected") {
        next = { purpose: "main", phase: "failed", error: "api-rejected" };
      } else if (verdict === "ambiguous") {
        next = await observeOnce(session, write);
      } else {
        next = { purpose: "main", phase: "ready", error: verdict };
      }
    }
    const nextState = commit(next);
    await persistSwallow(deps, nextState);
    return nextState;
  }
  if (record.phase === "sending" || record.phase === "unknown") {
    const next = await observeOnce(session, write);
    const nextState = commit(next);
    await persistSwallow(deps, nextState);
    return nextState;
  }
  return invalidState();
}

/** One `GET /cards` read: target observed ⇒ `confirmed`, anything else ⇒ `unknown`. */
async function observeOnce(session: Fiat24Session, write: CardWrite): Promise<TxRecord> {
  const cards = await session.cards().catch(() => undefined);
  return cards !== undefined && write.observed(cards)
    ? { purpose: "main", phase: "confirmed" }
    : { purpose: "main", phase: "unknown", error: "unknown-outcome" };
}

function ownerTopic(owner: Address): Hex {
  return `0x${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}

// §4 approve row: `Approval(owner, card)` on the cap's token.
function approveEvidence(deployment: Deployment, currency: Currency, owner: Address): TxEvidence {
  return {
    filters: [
      {
        address: deployment.tokens[currency].proxy,
        topics: [
          topic0Of(contractTarget(deployment, currency).abi, "Approval"),
          ownerTopic(owner),
          ownerTopic(deployment.card.proxy),
        ],
      },
    ],
  };
}

/**
 * §10.7 approve guard: token unpaused (account flag not required — an approve moves no funds) +
 * supply bound.
 */
async function approveGuard(
  client: Client,
  deployment: Deployment,
  currency: Currency,
  amount: bigint,
  blockNumber: bigint,
): Promise<void> {
  const availability = await getAvailability(client, { deployment, blockNumber });
  assertUnpaused(availability, [currency], { account: false });
  await supplyBound(client, { deployment, blockNumber, asset: currency, amount });
}

// The chain leg of an operation: the setup's `cap` or a `set-cap` (the approve IS the operation).
function chainAmount(
  state: CardState,
): { readonly currency: Currency; readonly amount: bigint } | undefined {
  const { cap, operation } = state;
  if (cap !== undefined) {
    return { currency: cap.currency, amount: cap.amount };
  }
  return operation.kind === "set-cap"
    ? { currency: operation.currency, amount: operation.amount }
    : undefined;
}

/**
 * §10.7. `ready` plans at a fresh block: a cap-implying op approves iff `allowance(owner, card) !==
 * amount` (exact, incl. down) — a matching `set-cap` is `confirmed` with no tx, a matching `cap`
 * skips straight to the write; other ops go straight to the write. `tx` advances the last record —
 * an `approve` through the chain sub-machine, a `main` through the API write; a confirmed setup
 * approve appends `main{ready}` and returns without writing.
 */
export async function advanceCard(deps: FlowDeps, state: CardState): Promise<CardState> {
  const checked = checkedState(state, "card");
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
  const chain = chainAmount(checked);
  let index: number;
  let purpose: "approve" | "main";
  if (checked.step === "tx") {
    const last = checked.txs.at(-1);
    if (last === undefined) {
      return invalidState();
    }
    index = checked.txs.length - 1;
    ({ purpose } = last);
  } else if (chain === undefined) {
    index = checked.txs.length;
    purpose = "main";
  } else {
    const { blockNumber } = await snapshot(deps.client, { deployment });
    const allowance = await getAllowance(deps.client, {
      deployment,
      owner: checked.owner,
      asset: chain.currency,
      spender: "card",
      blockNumber,
    });
    if (allowance === chain.amount) {
      if (checked.operation.kind === "set-cap") {
        const next = freeze({ ...checked, step: "confirmed" as const });
        await deps.persist(next);
        return next;
      }
      index = checked.txs.length;
      purpose = "main";
    } else {
      index = checked.txs.length;
      purpose = "approve";
    }
  }
  if (purpose === "main") {
    return advanceApiWrite(
      deps,
      checked,
      checked.step === "tx" ? checked.txs[index] : undefined,
      index,
    );
  }
  if (chain === undefined) {
    return invalidState();
  }
  const call = approveCall({
    asset: chain.currency,
    spender: "card",
    amount: chain.amount,
    deployment,
  });
  const outcome = await advanceTx<CardState, never>(deps, {
    record: checked.step === "tx" ? checked.txs[index] : undefined,
    purpose: "approve",
    call,
    owner: checked.owner,
    deployment,
    guard: async (blockNumber) =>
      approveGuard(deps.client, deployment, chain.currency, chain.amount, blockNumber),
    evidence: approveEvidence(deployment, chain.currency, checked.owner),
    commit: (record: TxRecord) => {
      const txs = [...checked.txs.slice(0, index), record];
      let step: CardState["step"];
      if (record.phase === "confirmed") {
        if (checked.operation.kind === "set-cap") {
          step = "confirmed";
        } else {
          // A confirmed cap approve only unlocks the write — it runs on the
          // next advance, never in the same one (§10.7).
          step = "tx";
          txs.push({ purpose: "main", phase: "ready" });
        }
      } else {
        step =
          record.phase === "failed" ? "failed" : record.phase === "not-sent" ? "not-sent" : "tx";
      }
      return freeze({ ...checked, step, txs });
    },
  });
  return outcome.state;
}
