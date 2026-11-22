import { erc20Abi, isAddressEqual, zeroAddress } from "viem";
import type { Address, Client, Hex, TransactionReceipt } from "viem";

import { freeze } from "../api/schemas.ts";
import { mintAccountCall, mintAccountWithEthCall } from "../calls/account.ts";
import { approveCall } from "../calls/approve.ts";
import type { Fiat24Call } from "../calls/types.ts";
import { getAccount } from "../chain/account.ts";
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
import { getMintQuote } from "../chain/mint.ts";
import type { MintQuote } from "../chain/mint.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { Deployment } from "../deployments/deployment.ts";
import { decodeFiat24Log } from "../events/decode.ts";
import { assertPath, checkedSigner, supplyBound } from "./guards.ts";
import { checkedState } from "./state.ts";
import { advanceTx } from "./tx.ts";
import type { TxEvidence } from "./tx.ts";
import type { FlowDeps, OnboardingState, TxRecord } from "./types.ts";

function invalidState(): never {
  throw new Fiat24Error("invalid-state", "invalid flow state");
}

function invalidArgument(): never {
  throw new Fiat24Error("invalid-argument", "invalid argument");
}

function quoteChanged(): never {
  throw new Fiat24Error("quote-changed", "quote changed");
}

/**
 * §10.8: `mintAccountCall` refuses non-standard ids before any I/O; payment is `f24` or `eth`, else
 * `invalid-argument`. No chain reads; `step:"check"`.
 */
export function startOnboarding(input: {
  readonly owner: Address;
  readonly tokenId: bigint;
  readonly payment: "f24" | "eth";
}): OnboardingState {
  const owner = checkedAddress(input.owner);
  mintAccountCall({ tokenId: input.tokenId });
  if (input.payment !== "f24" && input.payment !== "eth") {
    invalidArgument();
  }
  return freeze({
    flow: "onboarding",
    version: 1,
    owner,
    txs: [],
    step: "check",
    tokenId: input.tokenId,
    payment: input.payment,
  });
}

/**
 * §10.8 check guards at B — shared by `check → ready` and every tx guard. Availability first
 * (pause/f24/digits; `f24Sales.paused` only for the ETH path), then mint eligibility
 * (`historicOwnership == 0 && balanceOf == 0` — the contract's `_mintAllowed`), then the quote
 * (`taken` ⇒ `account-id-taken`), then the F24 balance for the F24 path.
 */
async function checkGuards(
  client: Client,
  deployment: Deployment,
  state: OnboardingState,
  blockNumber: bigint,
): Promise<MintQuote> {
  const availability = await getAvailability(client, { deployment, blockNumber });
  if (availability.account.paused) {
    throw new Fiat24Error("unavailable", "account unavailable", {
      contract: "account",
      reason: "account-paused",
    });
  }
  if (!availability.account.f24Active) {
    throw new Fiat24Error("unavailable", "account mint unavailable", {
      contract: "account",
      reason: "f24-inactive",
    });
  }
  if (availability.account.maxDigitForSale < 6) {
    throw new Fiat24Error("unavailable", "account mint unavailable", {
      contract: "account",
      reason: "mint-digits",
    });
  }
  if (state.payment === "eth" && availability.f24Sales.paused) {
    throw new Fiat24Error("unavailable", "account mint unavailable", {
      contract: "f24Sales",
      reason: "f24-sales-paused",
    });
  }
  const accountTarget = contractTarget(deployment, "account");
  const [historic, balance] = await Promise.all([
    readAt(client, blockNumber, {
      ...accountTarget,
      functionName: "historicOwnership",
      args: [state.owner],
    }),
    readAt(client, blockNumber, {
      ...accountTarget,
      functionName: "balanceOf",
      args: [state.owner],
    }),
  ]);
  if (asBigint(historic) !== 0n || asBigint(balance) !== 0n) {
    throw new Fiat24Error("address-ineligible", "address ineligible");
  }
  const quote = await getMintQuote(client, {
    deployment,
    tokenId: state.tokenId,
    blockNumber,
  });
  if (quote.taken) {
    throw new Fiat24Error("account-id-taken", "account id taken");
  }
  if (state.payment === "f24") {
    const f24Balance = asBigint(
      await readAt(client, blockNumber, {
        ...contractTarget(deployment, "f24"),
        functionName: "balanceOf",
        args: [state.owner],
      }),
    );
    if (f24Balance < quote.priceF24) {
      throw new Fiat24Error("insufficient-balance", "insufficient balance");
    }
  }
  return quote;
}

/**
 * The calls a `check`/`ready` state can send — approve F24 (f24 path) plus the mint call.
 * `assertPath` consumes only `.contracts`, so the amounts stand in until a quote exists.
 */
function pathCalls(state: OnboardingState, deployment: Deployment): ReadonlyArray<Fiat24Call> {
  if (state.payment === "f24") {
    return [
      approveCall({ asset: "F24", spender: "account", amount: 1n, deployment }),
      mintAccountCall({ tokenId: state.tokenId, deployment }),
    ];
  }
  return [mintAccountWithEthCall({ tokenId: state.tokenId, value: 1n, deployment })];
}

function requiredInput(state: OnboardingState): bigint {
  if (state.quote === undefined) {
    return invalidState();
  }
  return state.quote.input;
}

/** §10.8 approve guard: check guards + the F24 supply bound (I11). */
async function approveGuard(
  client: Client,
  deployment: Deployment,
  state: OnboardingState,
  blockNumber: bigint,
): Promise<void> {
  await checkGuards(client, deployment, state, blockNumber);
  await supplyBound(client, {
    deployment,
    blockNumber,
    asset: "F24",
    amount: requiredInput(state),
  });
}

/**
 * §10.8 main guard: check guards with a fresh quote, then — f24: a higher price or a drifted
 * allowance is `quote-changed`; eth: a higher wei price is `quote-changed` (excess value buys F24
 * that is returned, not the account).
 */
async function mainGuard(
  client: Client,
  deployment: Deployment,
  state: OnboardingState,
  blockNumber: bigint,
): Promise<void> {
  const fresh = await checkGuards(client, deployment, state, blockNumber);
  const input = requiredInput(state);
  if (state.payment === "f24") {
    if (fresh.priceF24 > input) {
      quoteChanged();
    }
    const allowance = await getAllowance(client, {
      deployment,
      owner: state.owner,
      asset: "F24",
      spender: "account",
      blockNumber,
    });
    if (allowance !== input) {
      quoteChanged();
    }
  } else if (fresh.priceWei > input) {
    quoteChanged();
  }
}

function ownerTopic(owner: Address): Hex {
  return `0x${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}

const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";

// §4 evidence rows — erc20 `Approval(owner, account)` on the F24 token for the
// approve, `Transfer(0x0, owner)` on the account contract for the mint.
function approveEvidence(deployment: Deployment, state: OnboardingState): TxEvidence {
  return {
    filters: [
      {
        address: deployment.f24.address,
        topics: [
          topic0Of(erc20Abi, "Approval"),
          ownerTopic(state.owner),
          ownerTopic(deployment.account.proxy),
        ],
      },
    ],
    erc20: true,
  };
}

function mintEvidence(deployment: Deployment, state: OnboardingState): TxEvidence {
  return {
    filters: [
      {
        address: deployment.account.proxy,
        topics: [
          topic0Of(contractTarget(deployment, "account").abi, "Transfer"),
          ZERO_TOPIC,
          ownerTopic(state.owner),
        ],
      },
    ],
  };
}

/**
 * §10.8: the mint is confirmed by the decoded `account-transfer` event — `from` zero, `to ==
 * owner`, `tokenId == tokenId` — else `invalid-rpc-response` (no transition). The minted account is
 * the result.
 */
function assertMinted(
  receipt: TransactionReceipt,
  state: OnboardingState,
  deployment: Deployment,
): void {
  for (const log of receipt.logs) {
    const event = decodeFiat24Log(log, deployment);
    if (
      event !== undefined &&
      event.kind === "account-transfer" &&
      isAddressEqual(event.from, zeroAddress) &&
      isAddressEqual(event.to, state.owner) &&
      event.tokenId === state.tokenId
    ) {
      return;
    }
  }
  throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
}

/**
 * §10.8. `check` runs the check guards at a fresh block and stores the quote (f24 ⇒ `priceF24`, eth
 * ⇒ `priceWei`). `ready` plans the exact F24 approve (`allowance !== quote.input`) — none for the
 * ETH path — and sends the first record. `tx` advances the last record; a confirmed mint becomes
 * `tourist`. `tourist`/`kyc` poll `deps.api.kycStatus` once plus the chain account status; `live`
 * only on chain live, `rejected` only on API rejected with chain not live.
 */
export async function advanceOnboarding(
  deps: FlowDeps,
  state: OnboardingState,
): Promise<OnboardingState> {
  const checked = checkedState(state, "onboarding");
  checkedSigner(deps.signer, checked.owner);
  const deployment = resolveDeployment(deps.client, deps.deployment);
  switch (checked.step) {
    case "live":
    case "rejected":
    case "failed":
    case "not-sent":
      return invalidState();
    case "check": {
      const { blockNumber } = await snapshot(deps.client, { deployment });
      await assertPath(deps.client, deployment, blockNumber, pathCalls(checked, deployment));
      const quote = await checkGuards(deps.client, deployment, checked, blockNumber);
      const next = freeze({
        ...checked,
        step: "ready" as const,
        quote: {
          input: checked.payment === "f24" ? quote.priceF24 : quote.priceWei,
          blockNumber,
        },
      });
      await deps.persist(next);
      return next;
    }
    case "tourist":
    case "kyc": {
      if (deps.api === undefined) {
        invalidArgument();
      }
      const kyc = await deps.api.kycStatus(checked.tokenId);
      const account = await getAccount(deps.client, {
        deployment,
        tokenId: checked.tokenId,
      });
      // `kyc` exists iff the step is `kyc` — the base carries no `kyc` key so
      // leaving the step drops it (exactOptionalPropertyTypes).
      const base = {
        flow: "onboarding" as const,
        version: 1 as const,
        owner: checked.owner,
        txs: checked.txs,
        tokenId: checked.tokenId,
        payment: checked.payment,
        ...(checked.quote === undefined ? {} : { quote: checked.quote }),
      };
      const next =
        account !== undefined && account.status === "live"
          ? freeze({ ...base, step: "live" as const })
          : kyc === "rejected"
            ? freeze({ ...base, step: "rejected" as const })
            : freeze({ ...base, step: "kyc" as const, kyc });
      await deps.persist(next);
      return next;
    }
    default:
      break;
  }
  let index: number;
  let purpose: "approve" | "main";
  if (checked.step === "ready") {
    if (checked.quote === undefined) {
      return invalidState();
    }
    if (checked.payment === "f24") {
      const { blockNumber } = await snapshot(deps.client, { deployment });
      await assertPath(deps.client, deployment, blockNumber, pathCalls(checked, deployment));
      const allowance = await getAllowance(deps.client, {
        deployment,
        owner: checked.owner,
        asset: "F24",
        spender: "account",
        blockNumber,
      });
      purpose = allowance === checked.quote.input ? "main" : "approve";
    } else {
      purpose = "main";
    }
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
        asset: "F24",
        spender: "account",
        amount: requiredInput(checked),
        deployment,
      })
    : checked.payment === "f24"
      ? mintAccountCall({ tokenId: checked.tokenId, deployment })
      : mintAccountWithEthCall({
          tokenId: checked.tokenId,
          value: requiredInput(checked),
          deployment,
        });
  const outcome = await advanceTx<OnboardingState, undefined>(deps, {
    record: checked.step === "tx" ? checked.txs[index] : undefined,
    purpose,
    call,
    owner: checked.owner,
    deployment,
    guard: async (blockNumber) =>
      isApprove
        ? approveGuard(deps.client, deployment, checked, blockNumber)
        : mainGuard(deps.client, deployment, checked, blockNumber),
    evidence: isApprove ? approveEvidence(deployment, checked) : mintEvidence(deployment, checked),
    // `onConfirmed` is omitted entirely for the approve record —
    // exactOptionalPropertyTypes forbids an explicit `undefined`.
    ...(isApprove
      ? {}
      : {
          onConfirmed: (receipt: TransactionReceipt) => {
            assertMinted(receipt, checked, deployment);
            return undefined;
          },
        }),
    commit: (record: TxRecord) => {
      const txs = [...checked.txs.slice(0, index), record];
      // confirmed mint ⇒ `tourist` (the account exists, KYC not started yet);
      // a confirmed approve appends `main{ready}` and stays `tx` (§10.8).
      const step: OnboardingState["step"] =
        record.phase === "confirmed"
          ? isApprove
            ? "tx"
            : "tourist"
          : record.phase === "failed"
            ? "failed"
            : record.phase === "not-sent"
              ? "not-sent"
              : "tx";
      if (isApprove && record.phase === "confirmed") {
        txs.push({ purpose: "main", phase: "ready" });
      }
      return freeze({ ...checked, step, txs });
    },
  });
  return outcome.state;
}

/**
 * §10.8 / Part 3 doc: the KYC entry point the host opens in the system browser. `walletProviderId`
 * (a bigint `>= 1`) deep-links the wallet provider's flow as `?wallet=<id>`; anything else ⇒
 * `invalid-argument`.
 */
export function kycUrl(walletProviderId?: bigint): string {
  const base = "https://id.fiat24.com/login";
  if (walletProviderId === undefined) {
    return base;
  }
  if (typeof walletProviderId !== "bigint" || walletProviderId < 1n) {
    invalidArgument();
  }
  return `${base}?wallet=${walletProviderId}`;
}
