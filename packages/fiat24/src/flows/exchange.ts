import { isAddressEqual } from "viem";
import type { Address, Client, Hex, TransactionReceipt } from "viem";

import { freeze } from "../api/schemas.ts";
import { approveCall } from "../calls/approve.ts";
import { exchangeCall } from "../calls/exchange.ts";
import { getAvailability } from "../chain/availability.ts";
import { getAllowance } from "../chain/balances.ts";
import {
  asBigint,
  checkedAddress,
  contractTarget,
  readAt,
  resolveDeployment,
  snapshot,
  topic0Of,
} from "../chain/context.ts";
import { getExchangeQuote } from "../chain/quote.ts";
import type { ExchangeQuote } from "../chain/quote.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { Currency } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { decodeFiat24Log } from "../events/decode.ts";
import {
  assertUnpaused,
  checkedSigner,
  deskOwner,
  legAllowed,
  senderLive,
  supplyBound,
} from "./guards.ts";
import { checkedState } from "./state.ts";
import { advanceTx } from "./tx.ts";
import type { TxEvidence } from "./tx.ts";
import type { ExchangeState, FlowDeps, TxRecord } from "./types.ts";

// The internal exchange desks (§10.5): input leg goes owner → treasury, output
// leg goes crypto desk → owner.
const TREASURY_DESK = 9100n;
const CRYPTO_DESK = 9105n;

function invalidState(): never {
  throw new Fiat24Error("invalid-state", "invalid flow state");
}

function quoteChanged(): never {
  throw new Fiat24Error("quote-changed", "quote changed");
}

/**
 * §10.5: `exchangeCall` carries every validation (side enum, both currencies, `from !== to`,
 * amount). No chain reads; returns `step:"draft"` with `txs:[]`.
 */
export function startExchange(input: {
  readonly owner: Address;
  readonly side: "exact-in" | "exact-out";
  readonly from: Currency;
  readonly to: Currency;
  readonly amount: bigint;
}): ExchangeState {
  const owner = checkedAddress(input.owner);
  exchangeCall({
    side: input.side,
    from: input.from,
    to: input.to,
    amount: input.amount,
  });
  return freeze({
    flow: "exchange",
    version: 1,
    owner,
    txs: [],
    step: "draft",
    side: input.side,
    from: input.from,
    to: input.to,
    amount: input.amount,
  });
}

/**
 * §10.5 quoted guards at B, shared by draft→quoted and every tx guard: quote + both tokens unpaused +
 * sender live + balance + the two transfer legs. The input leg carries `limitOf` so a rejected leg
 * can split `limit-exceeded` from `transfer-not-allowed`; the output leg is the desk's call, no
 * limit.
 */
async function quotedGuards(
  client: Client,
  deployment: Deployment,
  state: ExchangeState,
  blockNumber: bigint,
): Promise<ExchangeQuote> {
  const quote = await getExchangeQuote(client, {
    deployment,
    side: state.side,
    from: state.from,
    to: state.to,
    amount: state.amount,
    blockNumber,
  });
  const availability = await getAvailability(client, { deployment, blockNumber });
  assertUnpaused(availability, [state.from, state.to]);
  const account = await senderLive(client, {
    deployment,
    owner: state.owner,
    blockNumber,
  });
  const balance = asBigint(
    await readAt(client, blockNumber, {
      ...contractTarget(deployment, state.from),
      functionName: "balanceOf",
      args: [state.owner],
    }),
  );
  if (balance < quote.input) {
    throw new Fiat24Error("insufficient-balance", "insufficient balance");
  }
  const treasury = await deskOwner(client, {
    deployment,
    blockNumber,
    tokenId: TREASURY_DESK,
  });
  await legAllowed(client, {
    deployment,
    blockNumber,
    token: state.from,
    from: state.owner,
    to: treasury,
    amount: quote.input,
    limitOf: account.tokenId,
  });
  const crypto = await deskOwner(client, {
    deployment,
    blockNumber,
    tokenId: CRYPTO_DESK,
  });
  await legAllowed(client, {
    deployment,
    blockNumber,
    token: state.to,
    from: crypto,
    to: state.owner,
    amount: quote.output,
  });
  return quote;
}

// Deterministic from the state (I20): exact-in approves `amount`, exact-out
// approves the quoted input exactly — including re-approving down (I16).
function approveAmount(state: ExchangeState): bigint {
  if (state.side === "exact-in") {
    return state.amount;
  }
  if (state.quote === undefined) {
    return invalidState();
  }
  return state.quote.input;
}

/** §10.5 approve guard: the quoted guards (fresh quote, no comparison) + supply bound. */
async function approveGuard(
  client: Client,
  deployment: Deployment,
  state: ExchangeState,
  blockNumber: bigint,
): Promise<void> {
  await quotedGuards(client, deployment, state, blockNumber);
  await supplyBound(client, {
    deployment,
    blockNumber,
    asset: state.from,
    amount: approveAmount(state),
  });
}

/** §10.5 main guard: quoted guards + quote/allowance comparisons per side. */
async function mainGuard(
  client: Client,
  deployment: Deployment,
  state: ExchangeState,
  blockNumber: bigint,
): Promise<void> {
  const { quote } = state;
  if (quote === undefined) {
    return invalidState();
  }
  const fresh = await quotedGuards(client, deployment, state, blockNumber);
  const allowance = await getAllowance(client, {
    deployment,
    owner: state.owner,
    asset: state.from,
    spender: "deposit",
    blockNumber,
  });
  if (state.side === "exact-in") {
    if (fresh.output < quote.output) {
      quoteChanged();
    }
    if (allowance < state.amount) {
      throw new Fiat24Error("insufficient-allowance", "insufficient allowance");
    }
  } else if (fresh.input > quote.input || allowance !== quote.input) {
    quoteChanged();
  }
}

function ownerTopic(owner: Address): Hex {
  return `0x${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}

// §4 evidence rows — cash-token `Approval(owner, deposit)` for the approve, the
// side's `MoneyExchanged*(owner)` on the deposit proxy for the main.
function approveEvidence(deployment: Deployment, state: ExchangeState): TxEvidence {
  return {
    filters: [
      {
        address: deployment.tokens[state.from].proxy,
        topics: [
          topic0Of(contractTarget(deployment, state.from).abi, "Approval"),
          ownerTopic(state.owner),
          ownerTopic(deployment.deposit.proxy),
        ],
      },
    ],
  };
}

function mainEvidence(deployment: Deployment, state: ExchangeState): TxEvidence {
  const event = state.side === "exact-in" ? "MoneyExchangedExactIn" : "MoneyExchangedExactOut";
  return {
    filters: [
      {
        address: deployment.deposit.proxy,
        topics: [
          topic0Of(contractTarget(deployment, "deposit").abi, event),
          ownerTopic(state.owner),
        ],
      },
    ],
  };
}

/**
 * §10.5: `actual` comes from the receipt's decoded exchange event with `sender == owner` and
 * matching side — the first such; none ⇒ `invalid-rpc-response` (no transition).
 */
function extractActual(
  receipt: TransactionReceipt,
  state: ExchangeState,
  deployment: Deployment,
): { readonly input: bigint; readonly output: bigint } {
  for (const log of receipt.logs) {
    const event = decodeFiat24Log(log, deployment);
    if (
      event !== undefined &&
      event.kind === "exchange" &&
      event.side === state.side &&
      isAddressEqual(event.sender, state.owner)
    ) {
      return { input: event.inputAmount, output: event.outputAmount };
    }
  }
  throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
}

/**
 * §10.5. `draft` runs the quoted guards at a fresh block and becomes `quoted` (quote stored).
 * `quoted` plans the approve at a fresh block — exact-in iff `allowance < amount`, exact-out iff
 * `allowance !== quote.input` — then sends the first record in the same advance. `tx` advances the
 * last record; a confirmed approve appends `main{ready}` and returns without sending it.
 */
export async function advanceExchange(
  deps: FlowDeps,
  state: ExchangeState,
): Promise<ExchangeState> {
  const checked = checkedState(state, "exchange");
  checkedSigner(deps.signer, checked.owner);
  const deployment = resolveDeployment(deps.client, deps.deployment);
  switch (checked.step) {
    case "confirmed":
    case "failed":
    case "not-sent":
      return invalidState();
    case "draft": {
      const { blockNumber } = await snapshot(deps.client, { deployment });
      const quote = await quotedGuards(deps.client, deployment, checked, blockNumber);
      const next = freeze({
        ...checked,
        step: "quoted" as const,
        quote: {
          input: quote.input,
          output: quote.output,
          rate: quote.rate,
          spread: quote.spread,
          blockNumber,
        },
      });
      await deps.persist(next);
      return next;
    }
    default:
      break;
  }
  let index: number;
  let purpose: "approve" | "main";
  if (checked.step === "quoted") {
    if (checked.quote === undefined) {
      return invalidState();
    }
    const { blockNumber } = await snapshot(deps.client, { deployment });
    const allowance = await getAllowance(deps.client, {
      deployment,
      owner: checked.owner,
      asset: checked.from,
      spender: "deposit",
      blockNumber,
    });
    purpose =
      checked.side === "exact-in"
        ? allowance < checked.amount
          ? "approve"
          : "main"
        : allowance === checked.quote.input
          ? "main"
          : "approve";
    index = checked.txs.length;
  } else {
    const last = checked.txs.at(-1);
    if (last === undefined) {
      return invalidState();
    }
    index = checked.txs.length - 1;
    ({ purpose } = last);
  }
  const isApprove = purpose === "approve";
  const call = isApprove
    ? approveCall({
        asset: checked.from,
        spender: "deposit",
        amount: approveAmount(checked),
        deployment,
      })
    : exchangeCall({
        side: checked.side,
        from: checked.from,
        to: checked.to,
        amount: checked.amount,
        deployment,
      });
  let actual: { readonly input: bigint; readonly output: bigint } | undefined;
  const outcome = await advanceTx<
    ExchangeState,
    { readonly input: bigint; readonly output: bigint }
  >(deps, {
    record: checked.step === "tx" ? checked.txs[index] : undefined,
    purpose,
    call,
    owner: checked.owner,
    deployment,
    guard: async (blockNumber) =>
      isApprove
        ? approveGuard(deps.client, deployment, checked, blockNumber)
        : mainGuard(deps.client, deployment, checked, blockNumber),
    evidence: isApprove ? approveEvidence(deployment, checked) : mainEvidence(deployment, checked),
    // `onConfirmed` is omitted entirely for the approve record —
    // exactOptionalPropertyTypes forbids an explicit `undefined`.
    ...(isApprove
      ? {}
      : {
          onConfirmed: (receipt: TransactionReceipt) => {
            actual = extractActual(receipt, checked, deployment);
            return actual;
          },
        }),
    commit: (record: TxRecord) => {
      const txs = [...checked.txs.slice(0, index), record];
      // A confirmed approve only unlocks the main record — the main is sent
      // on the next advance, never in the same one (§10.5).
      const step: ExchangeState["step"] =
        record.phase === "confirmed"
          ? isApprove
            ? "tx"
            : "confirmed"
          : record.phase === "failed"
            ? "failed"
            : record.phase === "not-sent"
              ? "not-sent"
              : "tx";
      if (isApprove && record.phase === "confirmed") {
        txs.push({ purpose: "main", phase: "ready" });
      }
      return freeze({
        ...checked,
        step,
        txs,
        ...(actual === undefined ? {} : { actual }),
      });
    },
  });
  return outcome.state;
}
