import type { Address, Client, Hash } from "viem";

import type { BankPaymentRequest, Fiat24Api, Fiat24Session, KycStatus } from "../api/types.ts";
import type { Fiat24Account } from "../chain/account.ts";
import type { Availability } from "../chain/availability.ts";
import type { Allowances } from "../chain/balances.ts";
import type { Fiat24ErrorCode, UnavailableReason } from "../core/errors.ts";
import type { Fiat24Signer } from "../core/signer.ts";
import type { AccountStatus, Currency, PayoutCurrency, Recipient } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";

// SPEC §3.9/§10.2 — every injectable dependency of a flow. `now` is ms for
// ordering/display only; it never feeds a chain decision.
export type FlowDeps = {
  readonly client: Client;
  readonly signer: Fiat24Signer;
  readonly persist: (state: FlowState) => Promise<void>;
  readonly session?: Fiat24Session;
  readonly api?: Fiat24Api;
  readonly now: () => number;
  readonly deployment?: Deployment;
};

export type TxPhase =
  | "ready"
  | "sending"
  | "submitted"
  | "confirmed"
  | "failed"
  | "unknown"
  | "not-sent";

/** The first binding field that differed between the mined transaction and the rebuilt call. */
export type TxMismatch = "from" | "nonce" | "to" | "input" | "value";

/**
 * SPEC §10.1. The call is never stored — it is rebuilt from the flow's intent fields each advance
 * (I20); `nonce` is chosen by the SDK and passed to the signer, which must sign with exactly that
 * nonce or throw (§10.9). `mismatch` is legal only on `unknown{hash, unknown-outcome}`: the mined
 * transaction under that hash is not ours — the field says where it diverged. Nothing persisted may
 * depend on the L2 block a receipt was first seen in — a `confirmed` record is re-checked against a
 * fresh receipt on every advance (R-12).
 */
export type TxRecord = {
  readonly purpose: "approve" | "main";
  readonly phase: TxPhase;
  readonly fromBlock?: bigint;
  readonly nonce?: number;
  readonly hash?: Hash;
  readonly mismatch?: TxMismatch;
  readonly error?: Fiat24ErrorCode;
};

type Common = {
  readonly version: 1;
  readonly owner: Address;
  readonly txs: ReadonlyArray<TxRecord>;
};

export type TransferState = Common & {
  readonly flow: "transfer";
  readonly step: "draft" | "ready" | "tx" | "confirmed" | "failed" | "not-sent";
  readonly currency: Currency;
  readonly amount: bigint;
  readonly to: Recipient;
};

export type ExchangeState = Common & {
  readonly flow: "exchange";
  readonly step: "draft" | "quoted" | "tx" | "confirmed" | "failed" | "not-sent";
  readonly side: "exact-in" | "exact-out";
  readonly from: Currency;
  readonly to: Currency;
  readonly amount: bigint;
  readonly quote?: {
    readonly input: bigint;
    readonly output: bigint;
    readonly rate: bigint;
    readonly spread: bigint;
    readonly blockNumber: bigint;
  };
  readonly actual?: { readonly input: bigint; readonly output: bigint };
};

export type PayoutTarget =
  | { readonly kind: "contact"; readonly contactId: string }
  | { readonly kind: "bank"; readonly request: BankPaymentRequest }
  | { readonly kind: "swiss-qr"; readonly qr: string };

// In memory only: the unverified target holds payee PII, so a PayoutDraft is
// never persisted and `encodeFlowState` refuses it (§10.2, §10.6).
export type PayoutDraft = {
  readonly flow: "payout";
  readonly step: "draft";
  readonly owner: Address;
  readonly tokenId: bigint;
  readonly currency: PayoutCurrency;
  readonly amount: bigint;
  readonly target: PayoutTarget;
};

export type PayoutState = Common & {
  readonly flow: "payout";
  readonly step: "verified" | "tx" | "confirmed" | "failed" | "not-sent";
  readonly tokenId: bigint;
  readonly currency: PayoutCurrency;
  readonly amount: bigint;
  readonly contactId: string;
  readonly purposeId?: bigint;
  readonly ref?: string;
};

export type CardCurrency = "EUR" | "USD" | "CHF" | "CNH";

export type CardOperation =
  | { readonly kind: "set-cap"; readonly currency: Currency; readonly amount: bigint }
  | { readonly kind: "create" }
  | { readonly kind: "block" | "unblock"; readonly externalId: string }
  | {
      readonly kind: "set-currency";
      readonly externalId: string;
      readonly currency: CardCurrency;
    }
  | {
      readonly kind: "device-token";
      readonly externalId: string;
      readonly cardTokenId: string;
      readonly status: "activate" | "deactivate";
    };

export type CardState = Common & {
  readonly flow: "card";
  readonly step: "ready" | "tx" | "confirmed" | "failed" | "not-sent";
  readonly tokenId: bigint;
  readonly operation: CardOperation;
  // Setup only: the approve-to-cap that precedes `create`.
  readonly cap?: { readonly currency: Currency; readonly amount: bigint };
};

export type OnboardingState = Common & {
  readonly flow: "onboarding";
  readonly step:
    | "check"
    | "ready"
    | "tx"
    | "tourist"
    | "kyc"
    | "live"
    | "rejected"
    | "failed"
    | "not-sent";
  readonly tokenId: bigint;
  readonly payment: "f24" | "eth";
  // price: F24 units (f24) or wei (eth).
  readonly quote?: { readonly input: bigint; readonly blockNumber: bigint };
  readonly kyc?: KycStatus;
};

export type TopUpState = Common & {
  readonly flow: "top-up";
  readonly step: "check" | "quoted" | "tx" | "confirmed" | "unavailable" | "failed" | "not-sent";
  readonly output: Currency;
  readonly usdcAmount: bigint;
  // input = usdcAmount, output = outputAmount.
  readonly quote?: {
    readonly input: bigint;
    readonly output: bigint;
    readonly blockNumber: bigint;
  };
  readonly reason?: UnavailableReason;
  readonly actual?: { readonly input: bigint; readonly output: bigint };
};

export type FlowState =
  | TransferState
  | ExchangeState
  | PayoutState
  | CardState
  | OnboardingState
  | TopUpState;

// SPEC §10.3 — the read model; nothing is persisted.
export type AccountView =
  | { readonly step: "no-account" }
  | {
      readonly step: AccountStatus | "stale";
      readonly account: Fiat24Account;
      readonly balances: Readonly<Record<Currency, bigint>>;
      readonly iban: string | undefined;
      readonly availability: Availability;
      readonly allowances: Allowances;
    };
