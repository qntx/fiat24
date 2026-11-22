import { decodeEventLog, erc20Abi, getAddress, isAddress, isAddressEqual, isHash } from "viem";
import type { Address, Hash, Transaction, TransactionReceipt } from "viem";
import { getTransaction, getTransactionCount, getTransactionReceipt } from "viem/actions";

import type { Fiat24Call } from "../calls/types.ts";
import { getLogsChunked, invalidResponse, mapViemError, snapshot } from "../chain/context.ts";
import type { LogFilter } from "../chain/context.ts";
import { assertDeployment } from "../chain/deployment.ts";
import { simulateCall } from "../chain/simulate.ts";
import { Fiat24Error } from "../core/errors.ts";
import { CHAIN_ID } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { decodeFiat24Log } from "../events/decode.ts";
import type { Fiat24Event, RawLog } from "../events/types.ts";
import type { FlowDeps, FlowState, TxMismatch, TxRecord } from "./types.ts";

// SPEC §7.2: arb1's eth_getLogs window limit for an address/topic-array filter is
// 100,000 blocks; the evidence search walks [fromBlock, latest] in those windows.
const EVIDENCE_CHUNK = 100_000n;

/**
 * A decoded evidence candidate: cash-token/deposit/account logs come through `decodeFiat24Log`;
 * USDC/F24 approvals come through viem's erc20Abi decoder.
 */
export type EvidenceEvent =
  | { readonly kind: "fiat24"; readonly event: Fiat24Event }
  | {
      readonly kind: "erc20-approval";
      readonly owner: Address;
      readonly spender: Address;
      readonly value: bigint;
    };

/**
 * The flow-supplied half of the evidence search (§4): which logs to scan and how to decode them
 * (`erc20: true` for USDC/F24 `Approval`). Decoding runs only to surface `malformed-log`; it is the
 * five-field transaction binding, never the log fields, that decides evidence — filtering
 * candidates on decoded args could turn a real send into `not-sent` (the host would wrongly believe
 * it is safe to start again).
 */
export type TxEvidence = {
  readonly filters: ReadonlyArray<LogFilter>;
  readonly erc20?: boolean;
};

export type TxArgs<S extends FlowState, R> = {
  /** The record being advanced; `undefined` appends a fresh one. */
  readonly record: TxRecord | undefined;
  readonly purpose: "approve" | "main";
  /** Rebuilt from the flow's intent fields every advance — never stored (I20). */
  readonly call: Fiat24Call;
  readonly owner: Address;
  readonly deployment: Deployment;
  /** The flow's guards, re-run at the ready-phase block before every send. */
  readonly guard?: (blockNumber: bigint) => Promise<void>;
  /** The §4 evidence spec; required — an absent spec would make every `L > N` reconcile `not-sent`. */
  readonly evidence: TxEvidence;
  /**
   * Runs on a successful, binding-verified receipt before `confirmed` is produced (§6 per-flow
   * result extraction); a throw means no transition.
   */
  readonly onConfirmed?: (receipt: TransactionReceipt) => R;
  /** Builds the next flow state around `record` (replaces/appends in `txs`). */
  readonly commit: (record: TxRecord) => S;
};

export type TxOutcome<S extends FlowState, R> = {
  readonly record: TxRecord;
  readonly state: S;
  readonly result: R | undefined;
};

function invalidState(): never {
  throw new Fiat24Error("invalid-state", "invalid flow state");
}

// Walks the `cause` chain (cycle-safe) for a `name` match — viem nests the
// concrete error under transport wrappers.
function errorNamed(error: unknown, name: string): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    if ("name" in cursor && cursor.name === name) {
      return true;
    }
    cursor = "cause" in cursor ? cursor.cause : undefined;
  }
  return false;
}

/**
 * §10.9 / design §4 step 8: a refusal surfaces as Fiat24Error{signer-rejected}, or any object in
 * the cause chain with `code === 4001` or `name === "UserRejectedRequestError"`.
 */
function isRejection(error: unknown): boolean {
  if (error instanceof Fiat24Error) {
    return error.code === "signer-rejected";
  }
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    if (
      ("code" in cursor && cursor.code === 4001) ||
      ("name" in cursor && cursor.name === "UserRejectedRequestError")
    ) {
      return true;
    }
    cursor = "cause" in cursor ? cursor.cause : undefined;
  }
  return false;
}

/**
 * The five-field binding (§4): the transaction must be exactly the rebuilt call — `from`, `nonce`,
 * `to`, `input`, `value` — else it is not ours, and the first differing field (in that order) is
 * the record's `mismatch`. A contract-creation `to: null` is a `to` mismatch.
 */
export function mismatchOf(
  tx: Transaction,
  args: { readonly owner: Address; readonly call: Fiat24Call; readonly nonce: number },
): TxMismatch | undefined {
  if (!isAddressEqual(tx.from, args.owner)) {
    return "from";
  }
  if (tx.nonce !== args.nonce) {
    return "nonce";
  }
  if (tx.to === null || !isAddressEqual(tx.to, args.call.to)) {
    return "to";
  }
  if (tx.input.toLowerCase() !== args.call.data.toLowerCase()) {
    return "input";
  }
  if (tx.value !== args.call.value) {
    return "value";
  }
  return undefined;
}

function checkedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : invalidResponse();
}

export async function persistSwallow(deps: FlowDeps, state: FlowState): Promise<void> {
  // §3.3: this state was produced after signer.sendTransaction was called — a
  // persist rejection is swallowed and the state returned, because the already
  // persisted `sending` record covers it and throwing would leave the host
  // holding the pre-send state, from which a retry would send a second
  // transaction.
  try {
    await deps.persist(state);
  } catch {
    // swallowed — see above
  }
}

/** §4 `ready`: assert → guard → simulate → persist `sending` → signer → record the outcome. */
async function readyPhase<S extends FlowState, R>(
  deps: FlowDeps,
  args: TxArgs<S, R>,
): Promise<TxOutcome<S, R>> {
  const { blockNumber } = await snapshot(deps.client, { deployment: args.deployment });
  await assertDeployment(deps.client, {
    deployment: args.deployment,
    contracts: args.call.contracts,
    blockNumber,
  });
  if (args.guard !== undefined) {
    await args.guard(blockNumber);
  }
  await simulateCall(deps.client, {
    call: args.call,
    from: args.owner,
    blockNumber,
  });
  let nonce: number;
  try {
    nonce = checkedCount(
      await getTransactionCount(deps.client, {
        address: args.owner,
        blockTag: "pending",
      }),
    );
  } catch (error) {
    if (error instanceof Fiat24Error) {
      throw error;
    }
    return mapViemError(error);
  }
  const sending: TxRecord = {
    purpose: args.purpose,
    phase: "sending",
    fromBlock: blockNumber,
    nonce,
  };
  // Persist-before-send: a rejection propagates and the signer is never called.
  await deps.persist(args.commit(sending));
  let next: TxRecord;
  try {
    const result: unknown = await deps.signer.sendTransaction({
      chainId: CHAIN_ID,
      from: args.owner,
      to: args.call.to,
      data: args.call.data,
      value: args.call.value,
      nonce,
      intent: args.call.intent,
    });
    const lowered = typeof result === "string" ? result.toLowerCase() : "";
    next = isHash(lowered)
      ? {
          purpose: args.purpose,
          phase: "submitted",
          fromBlock: blockNumber,
          nonce,
          hash: lowered,
        }
      : // A resolved value that is not a 32-byte hash cannot bind a tx to the
        // send — indistinguishable from an unknown outcome.
        {
          purpose: args.purpose,
          phase: "unknown",
          fromBlock: blockNumber,
          nonce,
          error: "unknown-outcome",
        };
  } catch (error) {
    next = isRejection(error)
      ? { purpose: args.purpose, phase: "ready", error: "signer-rejected" }
      : {
          purpose: args.purpose,
          phase: "unknown",
          fromBlock: blockNumber,
          nonce,
          error: "unknown-outcome",
        };
  }
  const state = args.commit(next);
  await persistSwallow(deps, state);
  return { record: next, state, result: undefined };
}

// The outcome for a hash-bearing record whose transaction has no receipt yet: a mismatching
// pending tx is `unknown{…, mismatch}`, a binding one is (back to) `submitted`; a vanished tx
// falls through to the nonce reconciliation.
async function pendingOrVanished<S extends FlowState, R>(
  deps: FlowDeps,
  args: TxArgs<S, R>,
  record: TxRecord,
  hash: Hash,
  nonce: number,
  fromBlock: bigint,
): Promise<TxOutcome<S, R>> {
  let tx: Transaction;
  try {
    tx = await getTransaction(deps.client, { hash });
  } catch (error) {
    if (errorNamed(error, "TransactionNotFoundError")) {
      return byNonce(deps, args, record);
    }
    return mapViemError(error);
  }
  const mismatch = mismatchOf(tx, { owner: args.owner, call: args.call, nonce });
  if (mismatch !== undefined) {
    const next: TxRecord = {
      purpose: args.purpose,
      phase: "unknown",
      fromBlock,
      nonce,
      hash,
      error: "unknown-outcome",
      mismatch,
    };
    const state = args.commit(next);
    await deps.persist(state);
    return { record: next, state, result: undefined };
  }
  // Binding and pending (or mined without a receipt yet): `submitted` — an `unknown` record is
  // promoted, a `submitted` stays; persisted once either way (§3.5).
  const next: TxRecord = { purpose: args.purpose, phase: "submitted", fromBlock, nonce, hash };
  const state = args.commit(next);
  await deps.persist(state);
  return { record: next, state, result: undefined };
}

/**
 * §4 hash-first reconciliation (R-01): a record that carries a hash is reconciled by that hash's
 * receipt before the nonce ledger is consulted — a mined own-hash transaction is never `not-sent`.
 * Receipt and transaction both bind ⇒ `confirmed`; a mined transaction whose
 * `from`/`nonce`/`to`/`input`/`value` differs from the rebuilt call is `unknown{…, mismatch}`.
 */
async function byHash<S extends FlowState, R>(
  deps: FlowDeps,
  args: TxArgs<S, R>,
  record: TxRecord,
): Promise<TxOutcome<S, R>> {
  const { hash } = record;
  const { nonce } = record;
  const { fromBlock } = record;
  if (hash === undefined || nonce === undefined || fromBlock === undefined) {
    return invalidState();
  }
  let receipt: TransactionReceipt;
  try {
    receipt = await getTransactionReceipt(deps.client, { hash });
  } catch (error) {
    if (errorNamed(error, "TransactionReceiptNotFoundError")) {
      return pendingOrVanished(deps, args, record, hash, nonce, fromBlock);
    }
    return mapViemError(error);
  }
  const tx = await getTx(deps, hash);
  const mismatch = mismatchOf(tx, { owner: args.owner, call: args.call, nonce });
  if (mismatch !== undefined) {
    const next: TxRecord = {
      purpose: args.purpose,
      phase: "unknown",
      fromBlock,
      nonce,
      hash,
      error: "unknown-outcome",
      mismatch,
    };
    const state = args.commit(next);
    await deps.persist(state);
    return { record: next, state, result: undefined };
  }
  if (receipt.status === "reverted") {
    const next: TxRecord = {
      purpose: args.purpose,
      phase: "failed",
      fromBlock,
      nonce,
      hash,
      blockNumber: receipt.blockNumber,
      error: "tx-reverted",
    };
    const state = args.commit(next);
    await deps.persist(state);
    return { record: next, state, result: undefined };
  }
  const result = args.onConfirmed === undefined ? undefined : args.onConfirmed(receipt);
  const next: TxRecord = {
    purpose: args.purpose,
    phase: "confirmed",
    fromBlock,
    nonce,
    hash,
    blockNumber: receipt.blockNumber,
  };
  const state = args.commit(next);
  await deps.persist(state);
  return { record: next, state, result };
}

async function getTx(deps: FlowDeps, hash: Hash): Promise<Transaction> {
  try {
    return await getTransaction(deps.client, { hash });
  } catch (error) {
    return mapViemError(error);
  }
}

function isApprovalArgs(
  eventName: unknown,
  args: unknown,
): { readonly owner: Address; readonly spender: Address; readonly value: bigint } | undefined {
  if (
    eventName !== "Approval" ||
    typeof args !== "object" ||
    args === null ||
    !("owner" in args) ||
    !("spender" in args) ||
    !("value" in args) ||
    typeof args.owner !== "string" ||
    !isAddress(args.owner, { strict: false }) ||
    typeof args.spender !== "string" ||
    !isAddress(args.spender, { strict: false }) ||
    typeof args.value !== "bigint"
  ) {
    return undefined;
  }
  return {
    owner: getAddress(args.owner),
    spender: getAddress(args.spender),
    value: args.value,
  };
}

function decodeEvidence(
  raw: RawLog,
  evidence: TxEvidence,
  deployment: Deployment,
): EvidenceEvent | undefined {
  if (evidence.erc20 === true) {
    const [topic0, ...rest] = raw.topics;
    if (topic0 === undefined) {
      throw new Fiat24Error("malformed-log", "malformed log");
    }
    let decoded: { readonly eventName?: unknown; readonly args?: unknown };
    try {
      decoded = decodeEventLog({
        abi: erc20Abi,
        topics: [topic0, ...rest],
        data: raw.data,
        strict: true,
      });
    } catch {
      throw new Fiat24Error("malformed-log", "malformed log");
    }
    const approvalArgs = isApprovalArgs(decoded.eventName, decoded.args);
    if (!approvalArgs) {
      throw new Fiat24Error("malformed-log", "malformed log");
    }
    return { kind: "erc20-approval", ...approvalArgs };
  }
  const event = decodeFiat24Log(raw, deployment);
  if (event === undefined) {
    return undefined;
  }
  return { kind: "fiat24", event };
}

/** The confirmed (`blockNumber`) or pending (`"pending"`) transaction count, mapped like §4. */
async function countAt(
  deps: FlowDeps,
  owner: Address,
  at: { readonly blockNumber: bigint } | { readonly pending: true },
): Promise<number> {
  try {
    return checkedCount(
      await getTransactionCount(
        deps.client,
        "pending" in at
          ? { address: owner, blockTag: "pending" }
          : { address: owner, blockNumber: at.blockNumber },
      ),
    );
  } catch (error) {
    if (error instanceof Fiat24Error) {
      throw error;
    }
    return mapViemError(error);
  }
}

/**
 * §4 byNonce — `sending`/`unknown` without a hash, and hash-bearing records whose hash vanished:
 * the account nonce decides (R-13). `L1 > N` is consumed — the evidence search over `[fromBlock,
 * B1]` only surfaces candidate transactions (the first whose transaction matches all five fields is
 * `submitted{hash}`); no candidate ⇒ `unknown{unknown-outcome}`, NEVER `not-sent`. `L1 <= N` is no
 * proof on its own: `not-sent` requires the same reading at a SECOND, LATER block (`L2 <= N` at `B2 >
 * B1`) plus the pending pool (`P <= N`) — anything else is undecidable, so a `sending` degrades to
 * `unknown{unknown-outcome}` and `submitted`/`unknown` stay unchanged.
 */
async function byNonce<S extends FlowState, R>(
  deps: FlowDeps,
  args: TxArgs<S, R>,
  record: TxRecord,
): Promise<TxOutcome<S, R>> {
  const { nonce } = record;
  const { fromBlock } = record;
  if (nonce === undefined || fromBlock === undefined) {
    return invalidState();
  }
  const { blockNumber: b1 } = await snapshot(deps.client, { deployment: args.deployment });
  const l1 = await countAt(deps, args.owner, { blockNumber: b1 });
  if (l1 <= nonce) {
    const { blockNumber: b2 } = await snapshot(deps.client, { deployment: args.deployment });
    if (b2 > b1) {
      const l2 = await countAt(deps, args.owner, { blockNumber: b2 });
      const pending = await countAt(deps, args.owner, { pending: true });
      if (l2 <= nonce && pending <= nonce) {
        const next: TxRecord = {
          purpose: args.purpose,
          phase: "not-sent",
          fromBlock,
          nonce,
          // A signer-returned hash that never landed stays on the record.
          ...(record.hash === undefined ? {} : { hash: record.hash }),
        };
        const state = args.commit(next);
        await deps.persist(state);
        return { record: next, state, result: undefined };
      }
    }
    if (record.phase === "sending") {
      const next: TxRecord = {
        purpose: args.purpose,
        phase: "unknown",
        fromBlock,
        nonce,
        error: "unknown-outcome",
      };
      const state = args.commit(next);
      await deps.persist(state);
      return { record: next, state, result: undefined };
    }
    // `submitted`/`unknown`: unchanged, persisted once (§3.5).
    const state = args.commit(record);
    await deps.persist(state);
    return { record, state, result: undefined };
  }
  const logs = await getLogsChunked(deps.client, {
    filters: args.evidence.filters,
    fromBlock,
    toBlock: b1,
    chunkSize: EVIDENCE_CHUNK,
  });
  const seen = new Set<Hash>();
  const candidates: Hash[] = [];
  for (const raw of logs) {
    // Decoded only for its `malformed-log` contract — args never filter (§4: the
    // transaction binding decides).
    if (decodeEvidence(raw, args.evidence, args.deployment) === undefined) {
      continue;
    }
    const txid = raw.transactionHash;
    if (txid === null || seen.has(txid)) {
      continue;
    }
    seen.add(txid);
    candidates.push(txid);
  }
  // Candidates are inspected strictly in log order; the first one satisfying all
  // five bindings wins (§4). Sequential by design — recursion keeps the order.
  const inspect = async (index: number): Promise<TxOutcome<S, R>> => {
    const txid = candidates[index];
    if (txid !== undefined) {
      const tx = await getTx(deps, txid);
      if (mismatchOf(tx, { owner: args.owner, call: args.call, nonce }) !== undefined) {
        return inspect(index + 1);
      }
    }
    const next: TxRecord =
      txid === undefined
        ? {
            purpose: args.purpose,
            phase: "unknown",
            fromBlock,
            nonce,
            error: "unknown-outcome",
            ...(record.hash === undefined ? {} : { hash: record.hash }),
          }
        : { purpose: args.purpose, phase: "submitted", fromBlock, nonce, hash: txid };
    const state = args.commit(next);
    await deps.persist(state);
    return { record: next, state, result: undefined };
  };
  return inspect(0);
}

/**
 * The §10.1 sub-machine over one TxRecord. `ready` (or no record) runs the send path; every
 * hash-bearing record reconciles by that hash's receipt first; `sending`/`unknown` without a hash
 * reconcile by nonce and never send again (I10). Terminal records are unreachable — the codec and
 * the flow's step check keep them out.
 */
export async function advanceTx<S extends FlowState, R>(
  deps: FlowDeps,
  args: TxArgs<S, R>,
): Promise<TxOutcome<S, R>> {
  const { record } = args;
  if (record === undefined || record.phase === "ready") {
    return readyPhase(deps, args);
  }
  switch (record.phase) {
    case "submitted":
      return byHash(deps, args, record);
    case "sending":
    case "unknown":
      return record.hash === undefined ? byNonce(deps, args, record) : byHash(deps, args, record);
    default:
      return invalidState();
  }
}
