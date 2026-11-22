import type { Hash } from "viem";

import type { Fiat24SessionSigner } from "../core/signer.ts";
import type { Currency, PayoutCurrency } from "../core/types.ts";

type FiatCode = "EUR" | "USD" | "CHF" | "CNH";
type TransactionType = "P2P" | "FRX" | "CTU" | "CRD" | "CDP" | "CWD";
type CardDeviceToken = {
  readonly id: string;
  readonly type: string;
  readonly createdAt: bigint /* ms */;
};

export type Fiat24ApiOptions = {
  readonly fetch?: typeof fetch | undefined;
  readonly now: () => number /* ms */;
};

export type Countries = {
  readonly eligibleDomiciles: ReadonlyArray<string>;
  readonly eligibleDomicilesForCards: ReadonlyArray<string>;
  readonly lowLimitDomiciles: ReadonlyArray<string>;
  readonly blacklistNationalities: ReadonlyArray<string>;
};

export type RatePair =
  | "USDEUR"
  | "USDCHF"
  | "USDCNH"
  | "EURUSD"
  | "EURCHF"
  | "EURCNH"
  | "CHFUSD"
  | "CHFEUR"
  | "CHFCNH"
  | "CNHUSD"
  | "CNHEUR"
  | "CNHCHF";

// Display only (I4): a JSON float in currency units, never a decision input.
export type Rate = {
  readonly rate: number;
  readonly bid: number;
  readonly ask: number;
  readonly lastUpdateAt: bigint /* ms */;
};

export type PaymentPurpose = { readonly value: bigint; readonly name: string };

export type Bank = {
  readonly name: string;
  readonly bic: string;
  readonly country: string;
  readonly bankCode: string;
};

export type Banks = {
  readonly lastUpdateAt: bigint;
  readonly banks: Readonly<Record<string, ReadonlyArray<Bank>>>;
};

export type CountryCities = {
  readonly lastUpdateAt: bigint;
  readonly countries: Readonly<
    Record<
      string,
      {
        readonly name: string;
        readonly postalCodeRegEx: string;
        readonly cities: ReadonlyArray<string>;
      }
    >
  >;
};

export type KycStatus =
  | "not-started"
  | "pending-scan"
  | "processing"
  | "action-required"
  | "manual-review"
  | "completed"
  | "rejected"
  | "error"
  | "unknown";

export type Profile = {
  readonly tokenId: bigint;
  readonly name: string;
  readonly email: string;
  readonly mobile: string;
  readonly address: {
    readonly street: string;
    readonly postalCode: string;
    readonly city: string;
    readonly country: string;
  };
  readonly contacts: Readonly<
    Partial<
      Record<
        FiatCode,
        ReadonlyArray<{
          readonly id: string;
          readonly name: string;
          readonly account: string;
          readonly bank: string;
          readonly country: string;
        }>
      >
    >
  >;
  readonly isCardEligible: boolean;
  // Display only (I4): an API number in currency units, never a decision input.
  readonly cardActivation?: { readonly amount: string; readonly currency: FiatCode };
};

export type Card = {
  readonly externalId: string;
  readonly status: "active" | "blocked" | "expired" | "unknown";
  readonly currency: Currency;
  readonly currencies: ReadonlyArray<FiatCode>;
  readonly last4: string;
  readonly activeTokens: ReadonlyArray<CardDeviceToken>;
  readonly inactiveTokens: ReadonlyArray<CardDeviceToken>;
};

export type TransactionQuery = {
  readonly currency: FiatCode | "ALL";
  readonly fromRecord?: bigint;
  readonly recordsCount?: bigint;
  readonly fromTimestamp?: bigint /* ms */;
  readonly toTimestamp?: bigint /* ms */;
  readonly direction?: "IN" | "OUT" | "ALL";
  readonly types?: ReadonlyArray<TransactionType>;
};

export type TransactionPage = {
  readonly count: bigint;
  readonly transactions: ReadonlyArray<{
    readonly title: string;
    readonly subtitle: string;
    readonly amount: string;
    readonly timestamp: bigint /* ms */;
    readonly txId?: Hash;
    readonly from?: bigint;
    readonly to?: bigint;
    readonly blockNumber?: bigint;
  }>;
};

export type BankPaymentRequest = {
  readonly account: string;
  readonly bankName: string;
  readonly bic: string;
  readonly purpose: bigint;
  readonly reference?: string;
  readonly creditor:
    | "BR"
    | {
        readonly name: string;
        readonly street: string;
        readonly city: string;
        readonly zip: string;
        readonly country: string;
      };
};

export type VerifiedPayout = {
  readonly contactId: string;
  readonly purposeId: bigint;
  readonly ref: string;
};

export type VerifiedQrPayout = VerifiedPayout & {
  readonly currency: PayoutCurrency;
  readonly amount: bigint;
  readonly account: string;
  readonly creditor: { readonly name: string };
  readonly reference?: string;
};

export type SwissQr = {
  readonly account: string;
  readonly amount: bigint;
  readonly currency: "CHF" | "EUR";
};

export type Fiat24Api = {
  readonly timestamp: () => Promise<bigint> /* ms */;
  readonly countries: () => Promise<Countries>;
  readonly rates: () => Promise<Readonly<Partial<Record<RatePair, Rate>>>>;
  readonly paymentPurposes: () => Promise<ReadonlyArray<PaymentPurpose>>;
  readonly banks: () => Promise<Banks>;
  readonly bankByIban: (iban: string) => Promise<Bank>;
  readonly countryCities: () => Promise<CountryCities>;
  readonly kycStatus: (tokenId: bigint) => Promise<KycStatus>;
  readonly openSession: (args: { tokenId: bigint; signer: Fiat24SessionSigner }) => Fiat24Session;
};

export type Fiat24Session = {
  readonly tokenId: bigint;
  readonly profile: () => Promise<Profile>;
  readonly cards: () => Promise<ReadonlyArray<Card>>;
  // 5-min Marqeta display secret for the host's fiat24card.js widget (§9.4).
  readonly cardDisplayToken: (externalId: string) => Promise<string>;
  readonly transactions: (query: TransactionQuery) => Promise<TransactionPage>;
  readonly verifyBankPayment: (request: BankPaymentRequest) => Promise<VerifiedPayout>;
  readonly verifySwissQr: (qr: string) => Promise<VerifiedQrPayout>;
  readonly createCard: () => Promise<void>;
  readonly setCardStatus: (args: {
    externalId: string;
    status: "block" | "unblock";
  }) => Promise<void>;
  readonly setCardCurrency: (args: {
    externalId: string;
    currency: "EUR" | "USD" | "CHF" | "CNH";
  }) => Promise<void>;
  readonly setDeviceToken: (args: {
    externalId: string;
    cardTokenId: string;
    status: "activate" | "deactivate";
  }) => Promise<void>;
  readonly end: () => void;
};
