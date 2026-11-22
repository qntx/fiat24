import { erc20Abi, isAddressEqual } from "viem";
import type { Address, Client, Hex, TransactionReceipt } from "viem";

import { freeze } from "../api/schemas.ts";
import { approveCall } from "../calls/approve.ts";
import { topUpCall } from "../calls/topup.ts";
import { getAvailability } from "../chain/availability.ts";
import type { Availability } from "../chain/availability.ts";
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
import { getTopUpQuote } from "../chain/quote.ts";
import type { TopUpQuote } from "../chain/quote.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { UnavailableReason } from "../core/errors.ts";
import type { ContractName, Currency } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { decodeFiat24Log } from "../events/decode.ts";
import { assertPath, checkedSigner, deskOwner, legAllowed, supplyBound } from "./guards.ts";
import { checkedState } from "./state.ts";
import { advanceTx } from "./tx.ts";
import type { TxEvidence } from "./tx.ts";
import type { FlowDeps, TopUpState, TxRecord } from "./types.ts";

// The output leg is paid out of the crypto desk (§10.8).
const CRYPTO_DESK = 9105n;

function invalidState(): never {
  throw new Fiat24Error("invalid-state", "invalid flow state");
}

/**
 * §10.8: owner checked, `topUpCall` carries the output/usdcAmount validation. No chain reads;
 * returns `step:"check"` with `txs:[]`.
 */
export function startTopUp(input: {
  readonly owner: Address;
  readonly output: Currency;
  readonly usdcAmount: bigint;
}): TopUpState {
  const owner = checkedAddress(input.owner);
  topUpCall({ output: input.output, usdcAmount: input.usdcAmount });
  return freeze({
    flow: "top-up",
    version: 1,
    owner,
    txs: [],
    step: "check",
    output: input.output,
    usdcAmount: input.usdcAmount,
  });
}

/**
 * §10.8 pause evaluation, in the design's order: deposit paused, then account paused, then USD24 or
 * the output token paused. `check` turns the verdict into the persisted terminal `unavailable`
 * state; tx guards throw the same verdict as an `unavailable` error instead.
 */
function pauseVerdict(
  quote: TopUpQuote,
  availability: Availability,
  output: Currency,
): { readonly reason: UnavailableReason; readonly contract: ContractName } | undefined {
  if (quote.paused) {
    return { reason: "deposit-paused", contract: "deposit" };
  }
  if (availability.account.paused) {
    return { reason: "account-paused", contract: "account" };
  }
  if (availability.tokens.USD24.paused) {
    return { reason: "token-paused", contract: "USD24" };
  }
  if (availability.tokens[output].paused) {
    return { reason: "token-paused", contract: output };
  }
  return undefined;
}

function throwVerdict(verdict: {
  readonly reason: UnavailableReason;
  readonly contract: ContractName;
}): never {
  throw new Fiat24Error("unavailable", "top-up unavailable", {
    contract: verdict.contract,
    reason: verdict.reason,
  });
}

/** §10.8 quoted guards at B: USDC balance + the desk → owner output leg. */
async function quotedGuards(
  client: Client,
  deployment: Deployment,
  state: TopUpState,
  blockNumber: bigint,
  outputAmount: bigint,
): Promise<void> {
  const balance = asBigint(
    await readAt(client, blockNumber, {
      address: deployment.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [state.owner],
    }),
  );
  if (balance < state.usdcAmount) {
    throw new Fiat24Error("insufficient-balance", "insufficient balance");
  }
  const crypto = await deskOwner(client, {
    deployment,
    blockNumber,
    tokenId: CRYPTO_DESK,
  });
  await legAllowed(client, {
    deployment,
    blockNumber,
    token: state.output,
    from: crypto,
    to: state.owner,
    amount: outputAmount,
  });
}

// Every tx guard starts with a fresh quote + availability at B; a pause that
// appeared since `check` throws `unavailable` here (the terminal state is only
// produced by `check`).
async function txPrelude(
  client: Client,
  deployment: Deployment,
  state: TopUpState,
  blockNumber: bigint,
): Promise<TopUpQuote> {
  const quote = await getTopUpQuote(client, {
    deployment,
    owner: state.owner,
    output: state.output,
    usdcAmount: state.usdcAmount,
    blockNumber,
  });
  const availability = await getAvailability(client, { deployment, blockNumber });
  const verdict = pauseVerdict(quote, availability, state.output);
  if (verdict !== undefined) {
    throwVerdict(verdict);
  }
  return quote;
}

/** §10.8 approve guard: prelude + quoted guards + USDC supply bound. */
async function approveGuard(
  client: Client,
  deployment: Deployment,
  state: TopUpState,
  blockNumber: bigint,
): Promise<void> {
  const fresh = await txPrelude(client, deployment, state, blockNumber);
  await quotedGuards(client, deployment, state, blockNumber, fresh.outputAmount);
  await supplyBound(client, {
    deployment,
    blockNumber,
    asset: "USDC",
    amount: state.usdcAmount,
  });
}

/** §10.8 main guard: prelude + quoted guards + allowance and quote drift checks. */
async function mainGuard(
  client: Client,
  deployment: Deployment,
  state: TopUpState,
  blockNumber: bigint,
): Promise<void> {
  const { quote } = state;
  if (quote === undefined) {
    return invalidState();
  }
  const fresh = await txPrelude(client, deployment, state, blockNumber);
  await quotedGuards(client, deployment, state, blockNumber, fresh.outputAmount);
  const allowance = await getAllowance(client, {
    deployment,
    owner: state.owner,
    asset: "USDC",
    spender: "deposit",
    blockNumber,
  });
  if (allowance < state.usdcAmount) {
    throw new Fiat24Error("insufficient-allowance", "insufficient allowance");
  }
  if (fresh.outputAmount < quote.output) {
    throw new Fiat24Error("quote-changed", "quote changed");
  }
}

function ownerTopic(owner: Address): Hex {
  return `0x${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}

// §4 evidence rows — erc20 `Approval(owner, deposit)` on the pinned USDC for the
// approve, `DepositedTokenViaUsd(owner)` on the deposit proxy for the main.
function approveEvidence(deployment: Deployment, state: TopUpState): TxEvidence {
  return {
    filters: [
      {
        address: deployment.usdc,
        topics: [
          topic0Of(erc20Abi, "Approval"),
          ownerTopic(state.owner),
          ownerTopic(deployment.deposit.proxy),
        ],
      },
    ],
    erc20: true,
  };
}

function mainEvidence(deployment: Deployment, state: TopUpState): TxEvidence {
  return {
    filters: [
      {
        address: deployment.deposit.proxy,
        topics: [
          topic0Of(contractTarget(deployment, "deposit").abi, "DepositedTokenViaUsd"),
          ownerTopic(state.owner),
        ],
      },
    ],
  };
}

/**
 * §10.8: `actual` comes from the receipt's decoded `top-up` event (`via:"usdc"`, `sender ==
 * owner`); none ⇒ `invalid-rpc-response` (no transition).
 */
function extractActual(
  receipt: TransactionReceipt,
  state: TopUpState,
  deployment: Deployment,
): { readonly input: bigint; readonly output: bigint } {
  for (const log of receipt.logs) {
    const event = decodeFiat24Log(log, deployment);
    if (
      event !== undefined &&
      event.kind === "top-up" &&
      event.via === "usdc" &&
      isAddressEqual(event.sender, state.owner)
    ) {
      return { input: event.inputAmount, output: event.outputAmount };
    }
  }
  throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
}

/**
 * §10.8. `check` evaluates quote + availability at one block: a pause becomes the persisted
 * terminal `unavailable{reason}` (a new `startTopUp` retries), otherwise the quoted guards run and
 * the state becomes `quoted`. `quoted` plans the exact USDC approve (`allowance < usdcAmount`) and
 * sends the first record in the same advance; `tx` advances the last record.
 */
export async function advanceTopUp(deps: FlowDeps, state: TopUpState): Promise<TopUpState> {
  const checked = checkedState(state, "top-up");
  checkedSigner(deps.signer, checked.owner);
  const deployment = resolveDeployment(deps.client, deps.deployment);
  switch (checked.step) {
    case "confirmed":
    case "failed":
    case "not-sent":
    case "unavailable":
      return invalidState();
    case "check": {
      const { blockNumber } = await snapshot(deps.client, { deployment });
      await assertPath(deps.client, deployment, blockNumber, [
        approveCall({
          asset: "USDC",
          spender: "deposit",
          amount: checked.usdcAmount,
          deployment,
        }),
        topUpCall({ output: checked.output, usdcAmount: checked.usdcAmount, deployment }),
      ]);
      const quote = await getTopUpQuote(deps.client, {
        deployment,
        owner: checked.owner,
        output: checked.output,
        usdcAmount: checked.usdcAmount,
        blockNumber,
      });
      const availability = await getAvailability(deps.client, {
        deployment,
        blockNumber,
      });
      const verdict = pauseVerdict(quote, availability, checked.output);
      if (verdict !== undefined) {
        const next = freeze({
          ...checked,
          step: "unavailable" as const,
          reason: verdict.reason,
        });
        await deps.persist(next);
        return next;
      }
      await quotedGuards(deps.client, deployment, checked, blockNumber, quote.outputAmount);
      const next = freeze({
        ...checked,
        step: "quoted" as const,
        quote: {
          input: checked.usdcAmount,
          output: quote.outputAmount,
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
    await assertPath(deps.client, deployment, blockNumber, [
      approveCall({
        asset: "USDC",
        spender: "deposit",
        amount: checked.usdcAmount,
        deployment,
      }),
      topUpCall({ output: checked.output, usdcAmount: checked.usdcAmount, deployment }),
    ]);
    const allowance = await getAllowance(deps.client, {
      deployment,
      owner: checked.owner,
      asset: "USDC",
      spender: "deposit",
      blockNumber,
    });
    purpose = allowance < checked.usdcAmount ? "approve" : "main";
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
        asset: "USDC",
        spender: "deposit",
        amount: checked.usdcAmount,
        deployment,
      })
    : topUpCall({
        output: checked.output,
        usdcAmount: checked.usdcAmount,
        deployment,
      });
  let actual: { readonly input: bigint; readonly output: bigint } | undefined;
  const outcome = await advanceTx<TopUpState, { readonly input: bigint; readonly output: bigint }>(
    deps,
    {
      record: checked.step === "tx" ? checked.txs[index] : undefined,
      purpose,
      call,
      owner: checked.owner,
      deployment,
      guard: async (blockNumber) =>
        isApprove
          ? approveGuard(deps.client, deployment, checked, blockNumber)
          : mainGuard(deps.client, deployment, checked, blockNumber),
      evidence: isApprove
        ? approveEvidence(deployment, checked)
        : mainEvidence(deployment, checked),
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
        const step: TopUpState["step"] =
          record.phase === "confirmed"
            ? isApprove
              ? "tx"
              : "confirmed"
            : record.phase === "failed"
              ? "failed"
              : record.phase === "not-sent"
                ? "not-sent"
                : "tx";
        // Same rule as exchange: the confirmed approve unlocks `main{ready}`;
        // the main is sent on the next advance (§10.8).
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
    },
  );
  return outcome.state;
}
