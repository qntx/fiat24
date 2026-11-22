/**
 * SPEC §11.2 / acceptance F2 — the resumable flows layer end-to-end on a fork of Arbitrum One at
 * pinned block 526365924. Every success-path advance resumes through
 * `decodeFlowState(encodeFlowState(state))` and every persisted state is asserted decodable. API
 * dependencies (session / kyc) are fakes with synthetic values — no network.
 */
import { encodeFunctionData, getAddress } from "viem";
import type { Address, Hash, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { depositAbi, priceListAbi, tokenAbi } from "../../src/abi/index.ts";
import type { Fiat24Api, Fiat24Session, VerifiedPayout } from "../../src/api/index.ts";
import { payoutRefCall } from "../../src/calls/index.ts";
import { getTopUpQuote } from "../../src/chain/index.ts";
import type { ExchangeQuote } from "../../src/chain/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import {
  advanceCard,
  advanceExchange,
  advanceOnboarding,
  advancePayout,
  advanceTopUp,
  advanceTransfer,
  decodeFlowState,
  encodeFlowState,
  loadPayoutSettlement,
  startCardSetup,
  startExchange,
  startOnboarding,
  startPayout,
  startTopUp,
  startTransfer,
} from "../../src/flows/index.ts";
import type { FlowDeps, FlowState, OnboardingState, TransferState } from "../../src/flows/index.ts";
import { expectErrorAsync } from "../chain/stub.ts";
import {
  DESK,
  FORK_ENABLED,
  LIVE_1,
  LIVE_2,
  ROBOT,
  castCall,
  castUint,
  changeClientStatus,
  expectSuccess,
  forkSigner,
  fund,
  mintPriceWei,
  mintUsdc,
  ownerOf,
  pause,
  sendAs,
  setClientLimit,
  startFork,
  unpause,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

const EUR24 = arbitrum.tokens.EUR24.proxy;
const USD24 = arbitrum.tokens.USD24.proxy;
const DEPOSIT = arbitrum.deposit.proxy;
const ACCOUNT = arbitrum.account.proxy;
const CARD = arbitrum.card.proxy;
const USDC = arbitrum.usdc;
const F24 = arbitrum.f24.address;
const PRICELIST = arbitrum.priceList.proxy;
const F24SALES = arbitrum.f24Sales.proxy;

// Fresh EOAs with no historicOwnership at the fork block (checked via exists()).
const FRESH_1 = getAddress("0x10000000000000000000000000000000000000F1");
const FRESH_2 = getAddress("0x10000000000000000000000000000000000000F2");
const NO_NFT = getAddress("0xF011F011F011F011F011F011F011F011F011F011");
// Free standard mint ids (exists() === false at the pinned block).
const MINT_ID_1 = 734_521n;
const MINT_ID_2 = 734_525n;

const GBP24_TOKEN = getAddress("0x5fc17218196581864974574d715cFC7334794cBE");

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;
const SLOT_358 = "0x166" as Hex;
const SLOT_359 = "0x167" as Hex;
const SLOT_364 = "0x16c" as Hex;
const SLOT_USDC = "0xd0" as Hex;
const DRIFT_ADDR = getAddress("0x10000000000000000000000000000000000000e7");

type Signer = ReturnType<typeof forkSigner>["signer"];

/**
 * Flow deps on the fork: every persisted state is round-tripped through the codec inside `persist`
 * — a state that fails to decode fails the test immediately.
 */
function makeDeps(
  fork: Fork,
  signer: Signer,
  extra: Partial<FlowDeps> = {},
): { deps: FlowDeps; persisted: FlowState[] } {
  const persisted: FlowState[] = [];
  return {
    persisted,
    deps: {
      client: fork.publicClient,
      signer,
      now: Date.now,
      persist: async (state) => {
        decodeFlowState(encodeFlowState(state));
        persisted.push(state);
        await Promise.resolve();
      },
      ...extra,
    },
  };
}

/** Resumes `advance` from the encoded/decoded state — §10.2 resume on every success-path step. */
async function resumed<S extends FlowState>(
  advance: (deps: FlowDeps, state: S) => Promise<S>,
  deps: FlowDeps,
  state: S,
): Promise<S> {
  return advance(deps, decodeFlowState(encodeFlowState(state)) as S);
}

/** Every signer request must carry chain id 42161 and the SDK-supplied nonce. */
function expectSignerShape(sign: ReturnType<typeof forkSigner>): void {
  for (const request of sign.requests) {
    expect(request.chainId).toBe(42161);
    expect(Number.isSafeInteger(request.nonce)).toBe(true);
  }
}

function quoteOf(state: FlowState): ExchangeQuote {
  const candidate = state as { readonly quote?: ExchangeQuote };
  if (candidate.quote === undefined) {
    throw new Error("expected a quote");
  }
  return candidate.quote;
}

/** The block the last record's transaction was mined in — re-read from a fresh receipt. */
async function confirmedBlockOf(fork: Fork, state: FlowState): Promise<bigint> {
  const record = state.txs.at(-1);
  if (record?.phase !== "confirmed" || record.hash === undefined) {
    throw new Error("expected a confirmed record");
  }
  const receipt = await fork.publicClient.getTransactionReceipt({ hash: record.hash });
  return receipt.blockNumber;
}

function submittedHashOf(state: FlowState): Hash {
  const record = state.txs.at(-1);
  if (record?.phase !== "submitted" || record.hash === undefined) {
    throw new Error("expected a submitted record");
  }
  return record.hash;
}

function isSendingTransfer(item: FlowState): item is TransferState {
  return item.flow === "transfer" && item.txs.at(-1)?.phase === "sending";
}

const isConfirmed = (state: FlowState): boolean => state.step === "confirmed";
const isFailed = (state: FlowState): boolean => state.step === "failed";
const isTourist = (state: FlowState): boolean => state.step === "tourist";
const mainReady = (state: FlowState): boolean =>
  state.txs.at(-1)?.phase === "ready" && state.txs.at(-1)?.purpose === "main";

/**
 * Polls `advance` until `done` (bounded). Anvil can briefly report a mined tx's receipt as absent,
 * so one advance may legitimately return `submitted` again — the host polls.
 */
async function driveUntil<S extends FlowState>(
  advance: (deps: FlowDeps, state: S) => Promise<S>,
  deps: FlowDeps,
  state: S,
  done: (state: S) => boolean,
  tries = 8,
): Promise<S> {
  if (done(state) || tries <= 0) {
    return state;
  }
  return driveUntil(advance, deps, await resumed(advance, deps, state), done, tries - 1);
}

function nonceOf(state: FlowState): number {
  const record = state.txs.at(-1);
  if (
    record === undefined ||
    (record.phase !== "submitted" && record.phase !== "unknown") ||
    record.nonce === undefined
  ) {
    throw new Error("expected a recorded nonce");
  }
  return record.nonce;
}

function payoutSession(tokenId: bigint, verified: VerifiedPayout): Fiat24Session {
  return {
    tokenId,
    verifyBankPayment: async () => Promise.resolve(verified),
  } as unknown as Fiat24Session;
}

function cardSession(tokenId: bigint, cards: () => ReadonlyArray<unknown>): Fiat24Session {
  return {
    tokenId,
    profile: async () => Promise.resolve({ isCardEligible: true }),
    cards: async () => Promise.resolve(cards()),
    createCard: async () => Promise.resolve(),
    setCardStatus: async () => Promise.resolve(),
    setCardCurrency: async () => Promise.resolve(),
    setDeviceToken: async () => Promise.resolve(),
  } as unknown as Fiat24Session;
}

const API_COMPLETED: Fiat24Api = {
  kycStatus: async () => Promise.resolve("completed"),
} as unknown as Fiat24Api;

/** Robot `updateExchangeRates`, bumping USD→EUR by ~2.9% (the f3-exactout reproduction). */
async function bumpEurRate(fork: Fork, per1000 = 1029n): Promise<void> {
  const [eur, chf, gbp, cnh] = await Promise.all([
    fork.publicClient.readContract({
      address: DEPOSIT,
      abi: depositAbi,
      functionName: "exchangeRates",
      args: [USD24, EUR24],
    }),
    fork.publicClient.readContract({
      address: DEPOSIT,
      abi: depositAbi,
      functionName: "exchangeRates",
      args: [USD24, arbitrum.tokens.CHF24.proxy],
    }),
    fork.publicClient.readContract({
      address: DEPOSIT,
      abi: depositAbi,
      functionName: "exchangeRates",
      args: [USD24, GBP24_TOKEN],
    }),
    fork.publicClient.readContract({
      address: DEPOSIT,
      abi: depositAbi,
      functionName: "exchangeRates",
      args: [USD24, arbitrum.tokens.CNH24.proxy],
    }),
  ]);
  expectSuccess(
    await sendAs(
      fork,
      ROBOT,
      DEPOSIT,
      encodeFunctionData({
        abi: depositAbi,
        functionName: "updateExchangeRates",
        args: [(eur * per1000) / 1000n, chf, gbp, cnh, true],
      }),
    ),
  );
}

async function erc20Balance(fork: Fork, token: Address, owner: Address): Promise<bigint> {
  return castUint(await castCall(fork, [token, "balanceOf(address)(uint256)", owner], "latest"));
}

async function erc20Allowance(
  fork: Fork,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return castUint(
    await castCall(fork, [token, "allowance(address,address)(uint256)", owner, spender], "latest"),
  );
}

/** `word` with the low `bytes` bytes (rightmost) replaced by `replacement`'s tail. */
function withLowBytes(word: string, bytes: number, replacement: Address): Hex {
  const keep = 64 - 2 * bytes;
  return `0x${word.slice(2, 2 + keep)}${replacement.slice(2).slice(-2 * bytes)}` as Hex;
}

/** `word` with hex chars `lo..hi` (of the 64-char body) replaced. */
function withHexRange(word: string, lo: number, hi: number, fill: string): Hex {
  return `0x${word.slice(2, 2 + lo)}${fill}${word.slice(2 + hi)}` as Hex;
}

type Mutation = {
  readonly name: string;
  readonly field: string;
  readonly address: Address;
  readonly slot: Hex;
  readonly mutate: (word: string) => Hex;
};

function implMut(contract: Address): Mutation {
  return {
    name: "implementation",
    field: "implementation",
    address: contract,
    slot: IMPL_SLOT,
    mutate: (word) => withLowBytes(word, 20, DRIFT_ADDR),
  };
}

function adminMut(contract: Address): Mutation {
  return {
    name: "admin",
    field: "admin",
    address: contract,
    slot: ADMIN_SLOT,
    mutate: (word) => withLowBytes(word, 20, DRIFT_ADDR),
  };
}

const ACCOUNT_WIRING: ReadonlyArray<Mutation> = [
  {
    name: "f24 wiring slot 358",
    field: "f24",
    address: ACCOUNT,
    slot: SLOT_358,
    mutate: (word) => withHexRange(word, 20, 60, DRIFT_ADDR.slice(2)),
  },
  {
    name: "priceList wiring slot 359",
    field: "priceList",
    address: ACCOUNT,
    slot: SLOT_359,
    mutate: (word) => withHexRange(word, 24, 64, DRIFT_ADDR.slice(2)),
  },
  {
    name: "f24Sales wiring slot 364",
    field: "f24Sales",
    address: ACCOUNT,
    slot: SLOT_364,
    mutate: (word) => withLowBytes(word, 20, DRIFT_ADDR),
  },
];

const DEPOSIT_USDC: Mutation = {
  name: "usdc wiring slot 208",
  field: "usdc",
  address: DEPOSIT,
  slot: SLOT_USDC,
  mutate: (word) => withLowBytes(word, 20, DRIFT_ADDR),
};

async function applyMutation(fork: Fork, mutation: Mutation): Promise<void> {
  const word = await fork.publicClient.getStorageAt({
    address: mutation.address,
    slot: mutation.slot,
  });
  await fork.testClient.setStorageAt({
    address: mutation.address,
    index: mutation.slot,
    value: mutation.mutate(word ?? "0x"),
  });
}

describe.skipIf(!FORK_ENABLED)("fork: flows", () => {
  let fork: Fork;
  let snapshot: Hex;
  let owner1: Address;
  let owner2: Address;
  let eurMin = 0n;

  beforeAll(async () => {
    fork = await startFork();
    owner1 = await ownerOf(fork, LIVE_1);
    owner2 = await ownerOf(fork, LIVE_2);
    eurMin = await fork.publicClient.readContract({
      address: EUR24,
      abi: tokenAbi,
      functionName: "minimalPayoutAmount",
    });
  }, 120_000);

  beforeEach(async () => {
    snapshot = await fork.testClient.snapshot();
  });

  afterEach(async () => {
    await fork.testClient.revert({ id: snapshot });
  });

  afterAll(() => {
    fork.stop();
  });

  describe("transfer", () => {
    async function runTransfer(
      to: { address: Address } | { tokenId: bigint },
    ): Promise<TransferState> {
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      let state = startTransfer({ owner: owner1, currency: "EUR24", amount: 100n, to });
      state = await resumed(advanceTransfer, deps, state);
      expect(state.step).toBe("ready");
      state = await resumed(advanceTransfer, deps, state);
      expect(state.step).toBe("tx");
      state = await driveUntil(advanceTransfer, deps, state, isConfirmed);
      expect(state.step).toBe("confirmed");
      expectSignerShape(sign);
      return state;
    }

    test("confirmed by {tokenId} and by {address}, balance moves exactly", async () => {
      const before = await erc20Balance(fork, EUR24, owner2);
      await runTransfer({ tokenId: LIVE_2 });
      await runTransfer({ address: owner2 });
      await expect(erc20Balance(fork, EUR24, owner2)).resolves.toBe(before + 200n);
    });

    test("token paused ⇒ unavailable token-paused", async () => {
      expectSuccess(await pause(fork, EUR24));
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: 100n,
        to: { tokenId: LIVE_2 },
      });
      const error = await expectErrorAsync(async () => advanceTransfer(deps, state), "unavailable");
      expect(error.detail.reason).toBe("token-paused");
      expect(sign.requests).toHaveLength(0);
    });

    test("account paused ⇒ unavailable account-paused", async () => {
      expectSuccess(await pause(fork, ACCOUNT));
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: 100n,
        to: { tokenId: LIVE_2 },
      });
      const error = await expectErrorAsync(async () => advanceTransfer(deps, state), "unavailable");
      expect(error.detail.reason).toBe("account-paused");
      expect(sign.requests).toHaveLength(0);
    });

    test("SoftBlocked sender ⇒ not-live", async () => {
      expectSuccess(await changeClientStatus(fork, LIVE_1, 1));
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: 100n,
        to: { tokenId: LIVE_2 },
      });
      const error = await expectErrorAsync(async () => advanceTransfer(deps, state), "not-live");
      expect(error.code).toBe("not-live");
      expect(sign.requests).toHaveLength(0);
    });

    test("recipient with no account ⇒ recipient-not-live", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: 100n,
        to: { address: FRESH_1 },
      });
      const error = await expectErrorAsync(
        async () => advanceTransfer(deps, state),
        "recipient-not-live",
      );
      expect(error.code).toBe("recipient-not-live");
    });

    test("internal recipient by address ⇒ internal-account", async () => {
      const deskOwner = await ownerOf(fork, 9102n);
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: 100n,
        to: { address: deskOwner },
      });
      const error = await expectErrorAsync(
        async () => advanceTransfer(deps, state),
        "internal-account",
      );
      expect(error.code).toBe("internal-account");
    });

    test("setClientLimit 0 ⇒ limit-exceeded", async () => {
      expectSuccess(await setClientLimit(fork, LIVE_1, 0n));
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: 1n,
        to: { tokenId: LIVE_2 },
      });
      const error = await expectErrorAsync(
        async () => advanceTransfer(deps, state),
        "limit-exceeded",
      );
      expect(error.code).toBe("limit-exceeded");
    });

    test("amount above balance ⇒ insufficient-balance", async () => {
      const balance = await erc20Balance(fork, EUR24, owner1);
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: balance + 1n,
        to: { tokenId: LIVE_2 },
      });
      const error = await expectErrorAsync(
        async () => advanceTransfer(deps, state),
        "insufficient-balance",
      );
      expect(error.code).toBe("insufficient-balance");
    });
  });

  describe("exchange", () => {
    test("the real EUR24→deposit allowance is effectively unlimited at the block", async () => {
      const allowance = await erc20Allowance(fork, EUR24, owner1, DEPOSIT);
      // max-uint minus the ~177k already spent through it — far above any test amount.
      expect(allowance).toBeGreaterThan(2n ** 200n);
    });

    test("exact-in needs no approve: main confirms, actual matches the quote", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      let state = startExchange({
        owner: owner1,
        side: "exact-in",
        from: "EUR24",
        to: "USD24",
        amount: 10_000n,
      });
      state = await resumed(advanceExchange, deps, state);
      expect(state.step).toBe("quoted");
      const quoted = quoteOf(state);
      state = await resumed(advanceExchange, deps, state);
      expect(state.step).toBe("tx");
      expect(state.txs).toHaveLength(1);
      state = await driveUntil(advanceExchange, deps, state, isConfirmed);
      expect(state.step).toBe("confirmed");
      expect(state.actual?.input).toBe(10_000n);
      expect(state.actual?.output).toBeGreaterThanOrEqual(quoted.output);
      expectSignerShape(sign);
    });

    test("exact-out re-approves down to quote.input, then main confirms", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      let state = startExchange({
        owner: owner1,
        side: "exact-out",
        from: "EUR24",
        to: "USD24",
        amount: 10_000n,
      });
      state = await resumed(advanceExchange, deps, state);
      expect(state.step).toBe("quoted");
      const quote = quoteOf(state);
      const before = await erc20Balance(fork, EUR24, owner1);
      state = await resumed(advanceExchange, deps, state);
      expect(state.step).toBe("tx");
      expect(state.txs.at(-1)?.phase).toBe("submitted");
      state = await driveUntil(advanceExchange, deps, state, mainReady);
      expect(state.txs.at(-1)).toStrictEqual({ purpose: "main", phase: "ready" });
      // The down-approve took effect: allowance is exactly the quoted input.
      await expect(erc20Allowance(fork, EUR24, owner1, DEPOSIT)).resolves.toBe(quote?.input);
      state = await resumed(advanceExchange, deps, state);
      expect(state.txs.at(-1)?.phase).toBe("submitted");
      state = await driveUntil(advanceExchange, deps, state, isConfirmed);
      expect(state.step).toBe("confirmed");
      expect(state.actual?.input).toBeLessThanOrEqual(quote.input);
      const after = await erc20Balance(fork, EUR24, owner1);
      expect(before - after).toBe(state.actual?.input);
      expectSignerShape(sign);
    });

    test("max-uint allowance + robot rate update reverts instead of over-debiting", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      let state = startExchange({
        owner: owner1,
        side: "exact-out",
        from: "EUR24",
        to: "USD24",
        amount: 10_000n,
      });
      state = await resumed(advanceExchange, deps, state);
      state = await driveUntil(advanceExchange, deps, state, mainReady);
      expect(state.txs.at(-1)).toStrictEqual({ purpose: "main", phase: "ready" });
      // The down-approve left the allowance at exactly quote.input; a ~2.9% rate bump
      // raises the required input above it, so the contract's input leg reverts (STF)
      // instead of silently over-debiting (I16).
      const before = await erc20Balance(fork, EUR24, owner1);
      const hooked = forkSigner(fork, owner1, {
        kind: "before",
        hook: async () => {
          await bumpEurRate(fork);
        },
      });
      const { deps: hookedDeps } = makeDeps(fork, hooked.signer);
      state = await resumed(advanceExchange, hookedDeps, state);
      expect(state.step).toBe("tx");
      state = await driveUntil(advanceExchange, hookedDeps, state, isFailed);
      expect(state.step).toBe("failed");
      expect(state.txs.at(-1)).toMatchObject({
        purpose: "main",
        phase: "failed",
        error: "tx-reverted",
      });
      await expect(erc20Balance(fork, EUR24, owner1)).resolves.toBe(before);
      expectSignerShape(hooked);
    });

    test("robot rate update between quote and send ⇒ quote-changed, signer not called", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      let state = startExchange({
        owner: owner1,
        side: "exact-in",
        from: "EUR24",
        to: "USD24",
        amount: 10_000n,
      });
      state = await resumed(advanceExchange, deps, state);
      expect(state.step).toBe("quoted");
      await bumpEurRate(fork);
      const error = await expectErrorAsync(
        async () => advanceExchange(deps, state),
        "quote-changed",
      );
      expect(error.code).toBe("quote-changed");
      expect(sign.requests).toHaveLength(0);
      expect(sign.broadcasts).toHaveLength(0);
    });

    test("setClientLimit low ⇒ limit-exceeded at draft→quoted", async () => {
      expectSuccess(await setClientLimit(fork, LIVE_1, 0n));
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const state = startExchange({
        owner: owner1,
        side: "exact-in",
        from: "EUR24",
        to: "USD24",
        amount: 10_000n,
      });
      const error = await expectErrorAsync(
        async () => advanceExchange(deps, state),
        "limit-exceeded",
      );
      expect(error.code).toBe("limit-exceeded");
      expect(sign.requests).toHaveLength(0);
    });
  });

  describe("payout", () => {
    test("contact payout at the minimum confirms with txid <id>-<block>", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps, persisted } = makeDeps(fork, sign.signer);
      // The draft is memory-only (PII) — the first advance takes it as-is; every later
      // advance resumes through the codec.
      const draft = startPayout({
        owner: owner1,
        tokenId: LIVE_1,
        currency: "EUR24",
        amount: eurMin,
        target: { kind: "contact", contactId: "EA-00000738" },
      });
      let state = await advancePayout(deps, draft);
      expect(state.step).toBe("verified");
      state = await resumed(advancePayout, deps, state);
      expect(state.step).toBe("tx");
      state = await driveUntil(advancePayout, deps, state, isConfirmed);
      expect(state.step).toBe("confirmed");
      const mined = await confirmedBlockOf(fork, state);
      const settlement = await loadPayoutSettlement({ client: fork.publicClient }, state);
      expect(settlement.txid).toBe(`${LIVE_1}-${mined}`);
      expect(persisted.length).toBeGreaterThan(0);
      expectSignerShape(sign);
    });

    test("payout-ref via bank session: NUL-padded ref verbatim, confirmed", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const ref = `${LIVE_1}-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000`;
      expect(ref).toHaveLength(45);
      const request = {
        account: "LI7830174502999200012",
        bankName: "Synthetic Bank",
        bic: "SAHHCHZ2",
        purpose: 8n,
        reference: "invoice",
        creditor: "BR" as const,
      };
      const session = payoutSession(LIVE_1, {
        contactId: "SP",
        purposeId: 8n,
        ref,
      });
      const draft = startPayout({
        owner: owner1,
        tokenId: LIVE_1,
        currency: "EUR24",
        amount: eurMin,
        target: { kind: "bank", request },
      });
      let state = await advancePayout({ ...deps, session }, draft);
      expect(state.step).toBe("verified");
      expect(state.ref).toBe(ref);
      state = await resumed(advancePayout, { ...deps, session }, state);
      expect(state.step).toBe("tx");
      // The exact calldata carries the ref — NULs included — verbatim.
      const expected = payoutRefCall({
        currency: "EUR24",
        amount: eurMin,
        contactId: "SP",
        purposeId: 8n,
        ref,
        tokenId: LIVE_1,
      });
      expect(sign.requests.at(-1)?.data).toBe(expected.data);
      state = await driveUntil(advancePayout, { ...deps, session }, state, isConfirmed);
      expect(state.step).toBe("confirmed");
      const mined = await confirmedBlockOf(fork, state);
      const settlement = await loadPayoutSettlement({ client: fork.publicClient }, state);
      expect(settlement.txid).toBe(`${LIVE_1}-${mined}`);
      expectSignerShape(sign);
    });

    test("amount below the on-chain minimum ⇒ below-minimum", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const draft = startPayout({
        owner: owner1,
        tokenId: LIVE_1,
        currency: "EUR24",
        amount: eurMin - 1n,
        target: { kind: "contact", contactId: "EA-00000738" },
      });
      const verified = await advancePayout(deps, draft);
      expect(verified.step).toBe("verified");
      const error = await expectErrorAsync(
        async () => advancePayout(deps, verified),
        "below-minimum",
      );
      expect(error.code).toBe("below-minimum");
      expect(sign.requests).toHaveLength(0);
    });

    test("owner with no account NFT ⇒ no-account", async () => {
      const sign = forkSigner(fork, NO_NFT);
      const { deps } = makeDeps(fork, sign.signer);
      const draft = startPayout({
        owner: NO_NFT,
        tokenId: LIVE_1,
        currency: "EUR24",
        amount: eurMin,
        target: { kind: "contact", contactId: "EA-00000738" },
      });
      const verified = await advancePayout(deps, draft);
      expect(verified.step).toBe("verified");
      const error = await expectErrorAsync(async () => advancePayout(deps, verified), "no-account");
      expect(error.code).toBe("no-account");
      expect(sign.requests).toHaveLength(0);
    });
  });

  describe("card", () => {
    test("setup: approve exactly cap then create via session ⇒ confirmed", async () => {
      const sign = forkSigner(fork, owner1);
      const session = cardSession(LIVE_1, () => []);
      const { deps } = makeDeps(fork, sign.signer, { session });
      let state = startCardSetup({
        owner: owner1,
        tokenId: LIVE_1,
        cap: { currency: "EUR24", amount: 10_000n },
      });
      state = await driveUntil(advanceCard, deps, state, mainReady);
      expect(state.txs.at(-1)).toStrictEqual({ purpose: "main", phase: "ready" });
      expect(state.txs.at(-2)).toMatchObject({ purpose: "approve", phase: "confirmed" });
      // The exact-cap approve landed (down from the real allowance if it was larger).
      await expect(erc20Allowance(fork, EUR24, owner1, CARD)).resolves.toBe(10_000n);
      state = await resumed(advanceCard, deps, state);
      expect(state.step).toBe("confirmed");
      expect(state.txs.at(-1)).toStrictEqual({ purpose: "main", phase: "confirmed" });
      expectSignerShape(sign);
    });

    test("cap above totalSupply ⇒ unlimited-approval, signer not called", async () => {
      const totalSupply = castUint(
        await castCall(fork, [EUR24, "totalSupply()(uint256)"], "latest"),
      );
      const sign = forkSigner(fork, owner1);
      const session = cardSession(LIVE_1, () => []);
      const { deps } = makeDeps(fork, sign.signer, { session });
      const state = startCardSetup({
        owner: owner1,
        tokenId: LIVE_1,
        cap: { currency: "EUR24", amount: totalSupply + 1n },
      });
      const error = await expectErrorAsync(
        async () => advanceCard(deps, state),
        "unlimited-approval",
      );
      expect(error.code).toBe("unlimited-approval");
      expect(sign.requests).toHaveLength(0);
    });
  });

  describe("onboarding", () => {
    test("F24 path: fresh EOA mints 734521 ⇒ tourist ⇒ kyc ⇒ live", async () => {
      // F24 from the desk at the §8.3 price; ETH for gas via impersonation funding.
      const price = await fork.publicClient.readContract({
        address: PRICELIST,
        abi: priceListAbi,
        functionName: "getPrice",
        args: [MINT_ID_1],
      });
      expectSuccess(await fund(fork, F24, DESK, FRESH_1, price));
      const sign = forkSigner(fork, FRESH_1);
      const { deps } = makeDeps(fork, sign.signer, { api: API_COMPLETED });
      let state: OnboardingState = startOnboarding({
        owner: FRESH_1,
        tokenId: MINT_ID_1,
        payment: "f24",
      });
      state = await resumed(advanceOnboarding, deps, state);
      expect(state.step).toBe("ready");
      state = await driveUntil(advanceOnboarding, deps, state, mainReady);
      expect(state.txs.at(-1)).toStrictEqual({ purpose: "main", phase: "ready" });
      expect(state.txs.at(-2)).toMatchObject({ purpose: "approve", phase: "confirmed" });
      state = await driveUntil(advanceOnboarding, deps, state, isTourist);
      expect(state.step).toBe("tourist");
      await expect(ownerOf(fork, MINT_ID_1)).resolves.toBe(FRESH_1);
      // API says COMPLETED but the chain status is still tourist ⇒ kyc.
      state = await resumed(advanceOnboarding, deps, state);
      expect(state.step).toBe("kyc");
      expect(state.kyc).toBe("completed");
      // OPERATOR flips the chain status to Live ⇒ live wins.
      expectSuccess(await changeClientStatus(fork, MINT_ID_1, 5));
      state = await resumed(advanceOnboarding, deps, state);
      expect(state.step).toBe("live");
      expectSignerShape(sign);
    });

    test("ETH path: fresh EOA mints a free id ⇒ tourist, value = quoted wei", async () => {
      const value = await mintPriceWei(fork, MINT_ID_2);
      // eth_call refuses value > balance, so the EOA needs ETH before the flow simulates the mint.
      await fork.testClient.setBalance({ address: FRESH_2, value: value + 10n ** 18n });
      const sign = forkSigner(fork, FRESH_2);
      const { deps } = makeDeps(fork, sign.signer, { api: API_COMPLETED });
      let state: OnboardingState = startOnboarding({
        owner: FRESH_2,
        tokenId: MINT_ID_2,
        payment: "eth",
      });
      state = await resumed(advanceOnboarding, deps, state);
      expect(state.step).toBe("ready");
      state = await resumed(advanceOnboarding, deps, state);
      expect(state.step).toBe("tx");
      expect(state.txs).toHaveLength(1); // no approve on the ETH path
      expect(sign.requests.at(-1)?.value).toBe(value);
      state = await driveUntil(advanceOnboarding, deps, state, isTourist);
      expect(state.step).toBe("tourist");
      await expect(ownerOf(fork, MINT_ID_2)).resolves.toBe(FRESH_2);
      expectSignerShape(sign);
    });

    test("owner already holding an NFT ⇒ address-ineligible", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer, { api: API_COMPLETED });
      const state = startOnboarding({ owner: owner1, tokenId: MINT_ID_1, payment: "f24" });
      const error = await expectErrorAsync(
        async () => advanceOnboarding(deps, state),
        "address-ineligible",
      );
      expect(error.code).toBe("address-ineligible");
      expect(sign.requests).toHaveLength(0);
    });

    test("taken id ⇒ account-id-taken", async () => {
      const sign = forkSigner(fork, FRESH_1);
      const { deps } = makeDeps(fork, sign.signer, { api: API_COMPLETED });
      const state = startOnboarding({ owner: FRESH_1, tokenId: LIVE_1, payment: "f24" });
      const error = await expectErrorAsync(
        async () => advanceOnboarding(deps, state),
        "account-id-taken",
      );
      expect(error.code).toBe("account-id-taken");
      expect(sign.requests).toHaveLength(0);
    });

    test("account paused ⇒ unavailable account-paused", async () => {
      expectSuccess(await pause(fork, ACCOUNT));
      const sign = forkSigner(fork, FRESH_1);
      const { deps } = makeDeps(fork, sign.signer, { api: API_COMPLETED });
      const state = startOnboarding({ owner: FRESH_1, tokenId: MINT_ID_1, payment: "f24" });
      const error = await expectErrorAsync(
        async () => advanceOnboarding(deps, state),
        "unavailable",
      );
      expect(error.detail.reason).toBe("account-paused");
      expect(sign.requests).toHaveLength(0);
    });
  });

  describe("top-up", () => {
    const USDC_5 = 5_000_000n; // minUsdcDepositAmount at the fork block
    const USDC_10 = 10_000_000n;

    test("deposit paused ⇒ check persists terminal unavailable{deposit-paused}", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps, persisted } = makeDeps(fork, sign.signer);
      let state = startTopUp({ owner: owner1, output: "EUR24", usdcAmount: USDC_5 });
      state = await resumed(advanceTopUp, deps, state);
      expect(state.step).toBe("unavailable");
      expect(state.reason).toBe("deposit-paused");
      expect(persisted.at(-1)).toBe(state);
      expect(sign.requests).toHaveLength(0);
    });

    test("unpause + mint ⇒ approve exact USDC, main confirms, actual == quote", async () => {
      expectSuccess(await unpause(fork, DEPOSIT));
      await mintUsdc(fork, owner1, USDC_10);
      // The owner already holds a real USDC→deposit allowance at the block; zero it so the
      // approve leg of the flow runs deterministically (approve iff allowance < usdcAmount).
      expectSuccess(
        await sendAs(
          fork,
          owner1,
          USDC,
          encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [DEPOSIT, 0n] }),
        ),
      );
      const quote = await getTopUpQuote(fork.publicClient, {
        owner: owner1,
        output: "EUR24",
        usdcAmount: USDC_5,
      });
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      let state = startTopUp({ owner: owner1, output: "EUR24", usdcAmount: USDC_5 });
      state = await resumed(advanceTopUp, deps, state);
      expect(state.step).toBe("quoted");
      state = await driveUntil(advanceTopUp, deps, state, mainReady);
      expect(state.txs.at(-1)).toStrictEqual({ purpose: "main", phase: "ready" });
      expect(state.txs.at(-2)).toMatchObject({ purpose: "approve", phase: "confirmed" });
      await expect(erc20Allowance(fork, USDC, owner1, DEPOSIT)).resolves.toBe(USDC_5);
      state = await driveUntil(advanceTopUp, deps, state, isConfirmed);
      expect(state.step).toBe("confirmed");
      expect(state.actual?.output).toBe(quote.outputAmount);
      expectSignerShape(sign);
    });

    test("output USD24 paused ⇒ persisted unavailable{token-paused}", async () => {
      expectSuccess(await unpause(fork, DEPOSIT));
      expectSuccess(await pause(fork, USD24));
      const sign = forkSigner(fork, owner1);
      const { deps, persisted } = makeDeps(fork, sign.signer);
      let state = startTopUp({ owner: owner1, output: "USD24", usdcAmount: USDC_5 });
      state = await resumed(advanceTopUp, deps, state);
      expect(state.step).toBe("unavailable");
      expect(state.reason).toBe("token-paused");
      expect(persisted.at(-1)).toBe(state);
    });

    test("usdcAmount below the minimum ⇒ below-minimum", async () => {
      expectSuccess(await unpause(fork, DEPOSIT));
      const sign = forkSigner(fork, owner1);
      const { deps } = makeDeps(fork, sign.signer);
      const state = startTopUp({ owner: owner1, output: "EUR24", usdcAmount: USDC_5 - 1n });
      const error = await expectErrorAsync(async () => advanceTopUp(deps, state), "below-minimum");
      expect(error.code).toBe("below-minimum");
      expect(sign.requests).toHaveLength(0);
    });
  });

  describe("unknown outcome", () => {
    test("broadcast-then-throw signer ⇒ unknown, then evidence ⇒ submitted ⇒ confirmed", async () => {
      const sign = forkSigner(fork, owner1, { kind: "broadcast-then-throw" });
      const { deps } = makeDeps(fork, sign.signer);
      let state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: 10n,
        to: { tokenId: LIVE_2 },
      });
      state = await resumed(advanceTransfer, deps, state);
      state = await resumed(advanceTransfer, deps, state);
      // The signer broadcast and threw: the tx is on-chain but the caller never saw the hash.
      expect(state.step).toBe("tx");
      expect(state.txs.at(-1)?.phase).toBe("unknown");
      expect(sign.broadcasts).toHaveLength(1);
      state = await resumed(advanceTransfer, deps, state);
      expect(state.step).toBe("tx");
      const record = state.txs.at(-1);
      expect(record?.phase).toBe("submitted");
      state = await driveUntil(advanceTransfer, deps, state, isConfirmed);
      expect(state.step).toBe("confirmed");
    });

    test("broadcast-then-throw on the exchange approve ⇒ evidence ⇒ confirmed", async () => {
      const sign = forkSigner(fork, owner1, { kind: "broadcast-then-throw" });
      const { deps } = makeDeps(fork, sign.signer);
      let state = startExchange({
        owner: owner1,
        side: "exact-out",
        from: "EUR24",
        to: "USD24",
        amount: 10_000n,
      });
      state = await resumed(advanceExchange, deps, state);
      state = await resumed(advanceExchange, deps, state);
      expect(state.step).toBe("tx");
      expect(state.txs.at(-1)?.phase).toBe("unknown");
      state = await resumed(advanceExchange, deps, state);
      expect(state.txs.at(-1)?.phase).toBe("submitted");
      state = await driveUntil(advanceExchange, deps, state, mainReady);
      expect(state.txs.at(-1)).toStrictEqual({ purpose: "main", phase: "ready" });
      expect(state.txs.at(-2)).toMatchObject({ purpose: "approve", phase: "confirmed" });
      await expect(erc20Allowance(fork, EUR24, owner1, DEPOSIT)).resolves.toBeGreaterThan(0n);
    });

    test("crash after persist ⇒ unknown; nonce unused ⇒ stays unknown; self-tx ⇒ unknown", async () => {
      const sign = forkSigner(fork, owner1, { kind: "throw-before-send" });
      const { deps } = makeDeps(fork, sign.signer);
      let state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: 10n,
        to: { tokenId: LIVE_2 },
      });
      state = await resumed(advanceTransfer, deps, state);
      state = await resumed(advanceTransfer, deps, state);
      expect(state.step).toBe("tx");
      expect(state.txs.at(-1)?.phase).toBe("unknown");
      const nonce = nonceOf(state);
      expect(sign.broadcasts).toHaveLength(0);
      // The recorded nonce is still unused ⇒ outcome stays unknown, never not-sent.
      state = await resumed(advanceTransfer, deps, state);
      expect(state.txs.at(-1)?.phase).toBe("unknown");
      // A wallet "cancel" self-transaction consumes the nonce but is not proof the
      // broadcast never happened — it is not the rebuilt call, so the record stays
      // `unknown` for the host to resolve, never `not-sent`.
      await fork.testClient.impersonateAccount({ address: owner1 });
      await fork.testClient.setBalance({ address: owner1, value: 10n ** 18n });
      const selfHash = await fork.walletClient.sendTransaction({
        account: owner1,
        chain: fork.publicClient.chain,
        to: owner1,
        value: 0n,
        nonce,
      });
      await fork.publicClient.waitForTransactionReceipt({ hash: selfHash });
      state = await resumed(advanceTransfer, deps, state);
      expect(state.step).toBe("tx");
      expect(state.txs.at(-1)?.phase).toBe("unknown");
    });

    test("speed-up with identical bytes ⇒ submitted{other hash} ⇒ confirmed", async () => {
      await fork.testClient.setAutomine(false);
      try {
        const sign = forkSigner(fork, owner1);
        const { deps } = makeDeps(fork, sign.signer);
        let state = startTransfer({
          owner: owner1,
          currency: "EUR24",
          amount: 10n,
          to: { tokenId: LIVE_2 },
        });
        state = await resumed(advanceTransfer, deps, state);
        state = await resumed(advanceTransfer, deps, state);
        expect(state.txs.at(-1)?.phase).toBe("submitted");
        const request = sign.requests.at(-1);
        const hashA = submittedHashOf(state);
        // The host re-sends the identical tx at the same nonce with a higher fee.
        const hashB = await fork.walletClient.sendTransaction({
          account: owner1,
          chain: fork.publicClient.chain,
          to: request?.to,
          data: request?.data,
          value: request?.value,
          nonce: request?.nonce,
          gasPrice: 2_000_000_000n,
        });
        await fork.testClient.mine({ blocks: 1 });
        state = await resumed(advanceTransfer, deps, state);
        expect(state.txs.at(-1)).toMatchObject({ phase: "submitted", hash: hashB });
        expect(hashB).not.toBe(hashA);
        state = await driveUntil(advanceTransfer, deps, state, isConfirmed);
        expect(state.step).toBe("confirmed");
      } finally {
        await fork.testClient.setAutomine(true);
      }
    });

    test("resume from a persisted sending state after a real broadcast ⇒ confirmed", async () => {
      const sign = forkSigner(fork, owner1);
      const { deps, persisted } = makeDeps(fork, sign.signer);
      let state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: 10n,
        to: { tokenId: LIVE_2 },
      });
      state = await resumed(advanceTransfer, deps, state);
      state = await resumed(advanceTransfer, deps, state);
      expect(state.step).toBe("tx");
      // The persisted `sending` snapshot covers the case where the process died before
      // the post-send persist — resuming it reconciles by evidence.
      const sendings = persisted.filter(isSendingTransfer);
      expect(sendings).toHaveLength(1);
      const sending = sendings.at(0);
      expect(sending).toBeDefined();
      let resumedState = sending as TransferState;
      resumedState = await resumed(advanceTransfer, deps, resumedState);
      expect(resumedState.txs.at(-1)?.phase).toBe("submitted");
      resumedState = await driveUntil(advanceTransfer, deps, resumedState, isConfirmed);
      expect(resumedState.step).toBe("confirmed");
    });
  });

  describe("drift (I5): mutated contract ⇒ contract-changed, signer never called", () => {
    /**
     * Drives `flow` to the state right before its first sending advance, applies `mutation`,
     * advances.
     */
    type Probe = (fork: Fork) => Promise<{
      readonly advance: () => Promise<FlowState>;
      readonly sign: ReturnType<typeof forkSigner>;
    }>;

    const transferProbe: Probe = async (f) => {
      const sign = forkSigner(f, owner1);
      const { deps } = makeDeps(f, sign.signer);
      const state = startTransfer({
        owner: owner1,
        currency: "EUR24",
        amount: 10n,
        to: { tokenId: LIVE_2 },
      });
      await Promise.resolve();
      return { sign, advance: async () => advanceTransfer(deps, state) }; // draft → guards next
    };

    const exchangeProbe: Probe = async (f) => {
      const sign = forkSigner(f, owner1);
      const { deps } = makeDeps(f, sign.signer);
      const state = startExchange({
        owner: owner1,
        side: "exact-in",
        from: "EUR24",
        to: "USD24",
        amount: 1000n,
      });
      await Promise.resolve();
      return { sign, advance: async () => advanceExchange(deps, state) }; // draft → quote next
    };

    const payoutProbe: Probe = async (f) => {
      const sign = forkSigner(f, owner1);
      const { deps } = makeDeps(f, sign.signer);
      const draft = startPayout({
        owner: owner1,
        tokenId: LIVE_1,
        currency: "EUR24",
        amount: eurMin,
        target: { kind: "contact", contactId: "EA-00000738" },
      });
      const state = await advancePayout(deps, draft); // draft → verified (draft is memory-only)
      return { sign, advance: async () => advancePayout(deps, state) };
    };

    const cardProbe: Probe = async (f) => {
      const sign = forkSigner(f, owner1);
      const session = cardSession(LIVE_1, () => []);
      const { deps } = makeDeps(f, sign.signer, { session });
      const state = startCardSetup({
        owner: owner1,
        tokenId: LIVE_1,
        cap: { currency: "EUR24", amount: 1000n },
      });
      await Promise.resolve();
      return { sign, advance: async () => advanceCard(deps, state) }; // ready → approve send
    };

    const onboardingProbe: Probe = async (f) => {
      const sign = forkSigner(f, FRESH_1);
      const { deps } = makeDeps(f, sign.signer, { api: API_COMPLETED });
      const state = startOnboarding({ owner: FRESH_1, tokenId: MINT_ID_1, payment: "f24" });
      await Promise.resolve();
      return { sign, advance: async () => advanceOnboarding(deps, state) }; // check → guards next
    };

    // The eth path puts f24Sales on the call path (the f24 path does not).
    const onboardingEthProbe: Probe = async (f) => {
      const sign = forkSigner(f, FRESH_1);
      const { deps } = makeDeps(f, sign.signer, { api: API_COMPLETED });
      const state = startOnboarding({ owner: FRESH_1, tokenId: MINT_ID_1, payment: "eth" });
      await Promise.resolve();
      return { sign, advance: async () => advanceOnboarding(deps, state) }; // check → guards next
    };

    const topupProbe: Probe = async (f) => {
      const sign = forkSigner(f, owner1);
      const { deps } = makeDeps(f, sign.signer);
      const state = startTopUp({ owner: owner1, output: "EUR24", usdcAmount: 5_000_000n });
      await Promise.resolve();
      return { sign, advance: async () => advanceTopUp(deps, state) }; // check → quote next
    };

    // Parks exchange at `main{ready}` (exact-out approve confirmed). Mutating an impl slot
    // breaks every delegated read on that proxy, so contract-changed for implementation
    // drift is only reachable when assertDeployment is the next I/O — i.e. here.
    const exchangeMainProbe: Probe = async (f) => {
      const sign = forkSigner(f, owner1);
      const { deps } = makeDeps(f, sign.signer);
      let state = startExchange({
        owner: owner1,
        side: "exact-out",
        from: "EUR24",
        to: "USD24",
        amount: 1000n,
      });
      state = await resumed(advanceExchange, deps, state);
      state = await driveUntil(advanceExchange, deps, state, mainReady);
      expect(state.txs.at(-1)).toStrictEqual({ purpose: "main", phase: "ready" });
      return { sign, advance: async () => advanceExchange(deps, state) };
    };

    const topupMainProbe: Probe = async (f) => {
      expectSuccess(await unpause(f, DEPOSIT));
      await mintUsdc(f, owner1, 10_000_000n);
      // The owner's real USDC→deposit allowance already covers the amount, so zero it first:
      // only then does the flow approve, and `main{ready}` exists to park on.
      expectSuccess(
        await sendAs(
          f,
          owner1,
          USDC,
          encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [DEPOSIT, 0n] }),
        ),
      );
      const sign = forkSigner(f, owner1);
      const { deps } = makeDeps(f, sign.signer);
      let state = startTopUp({ owner: owner1, output: "EUR24", usdcAmount: 5_000_000n });
      state = await resumed(advanceTopUp, deps, state); // check → quoted
      state = await driveUntil(advanceTopUp, deps, state, mainReady); // approve ⇒ main{ready}
      expect(state.txs.at(-1)).toStrictEqual({ purpose: "main", phase: "ready" });
      return { sign, advance: async () => advanceTopUp(deps, state) }; // main send next
    };

    const CASES: ReadonlyArray<{
      readonly flow: string;
      readonly probe: Probe;
      readonly mutations: ReadonlyArray<Mutation>;
    }> = [
      {
        flow: "transfer",
        probe: transferProbe,
        mutations: [
          implMut(EUR24),
          adminMut(EUR24),
          implMut(ACCOUNT),
          adminMut(ACCOUNT),
          ...ACCOUNT_WIRING,
        ],
      },
      {
        flow: "exchange",
        probe: exchangeProbe,
        mutations: [
          implMut(DEPOSIT),
          adminMut(DEPOSIT),
          implMut(EUR24),
          adminMut(EUR24),
          implMut(USD24),
          adminMut(USD24),
          implMut(ACCOUNT),
          adminMut(ACCOUNT),
          ...ACCOUNT_WIRING,
          DEPOSIT_USDC,
        ],
      },
      {
        flow: "exchange (main)",
        probe: exchangeMainProbe,
        mutations: [
          implMut(DEPOSIT),
          adminMut(DEPOSIT),
          implMut(EUR24),
          adminMut(EUR24),
          implMut(USD24),
          adminMut(USD24),
          implMut(ACCOUNT),
          adminMut(ACCOUNT),
          ...ACCOUNT_WIRING,
          DEPOSIT_USDC,
        ],
      },
      {
        flow: "payout",
        probe: payoutProbe,
        mutations: [
          implMut(EUR24),
          adminMut(EUR24),
          implMut(ACCOUNT),
          adminMut(ACCOUNT),
          ...ACCOUNT_WIRING,
        ],
      },
      {
        flow: "card",
        probe: cardProbe,
        mutations: [implMut(CARD), adminMut(CARD), implMut(EUR24), adminMut(EUR24)],
      },
      {
        flow: "onboarding (f24)",
        probe: onboardingProbe,
        mutations: [
          implMut(ACCOUNT),
          adminMut(ACCOUNT),
          implMut(PRICELIST),
          adminMut(PRICELIST),
          ...ACCOUNT_WIRING,
        ],
      },
      {
        // f24Sales is only on the eth path — the f24 path's call set cannot see it.
        flow: "onboarding (eth)",
        probe: onboardingEthProbe,
        mutations: [implMut(F24SALES), adminMut(F24SALES)],
      },
      {
        flow: "top-up",
        probe: topupProbe,
        mutations: [
          implMut(DEPOSIT),
          adminMut(DEPOSIT),
          implMut(EUR24),
          adminMut(EUR24),
          implMut(USD24),
          adminMut(USD24),
          implMut(ACCOUNT),
          adminMut(ACCOUNT),
          ...ACCOUNT_WIRING,
          DEPOSIT_USDC,
        ],
      },
      {
        flow: "top-up (main)",
        probe: topupMainProbe,
        mutations: [
          implMut(DEPOSIT),
          adminMut(DEPOSIT),
          implMut(EUR24),
          adminMut(EUR24),
          implMut(USD24),
          adminMut(USD24),
          implMut(ACCOUNT),
          adminMut(ACCOUNT),
          ...ACCOUNT_WIRING,
          DEPOSIT_USDC,
        ],
      },
    ];

    const DRIFT = CASES.flatMap(({ flow, probe, mutations }) =>
      mutations.map((mutation) => ({ flow, probe, mutation })),
    );

    test.each(DRIFT)(
      "$flow: mutated $mutation.name ⇒ contract-changed{$mutation.field}",
      async ({ probe, mutation }) => {
        const { advance, sign } = await probe(fork);
        // Main-probes already sent an approve through the signer; the drift must block only the
        // *next* request, so compare counts rather than requiring zero.
        const seen = sign.requests.length;
        await applyMutation(fork, mutation);
        const error = await expectErrorAsync(advance, "contract-changed");
        expect(error.detail.field).toBe(mutation.field);
        expect(sign.requests).toHaveLength(seen);
      },
    );
  });
});
