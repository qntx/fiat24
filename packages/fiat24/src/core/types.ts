import type { Address } from "viem";

import { freeze } from "./freeze.ts";

/** Arbitrum One — the only chain the protocol is deployed on. */
export const CHAIN_ID = 42161;

export type Currency = "USD24" | "EUR24" | "CHF24" | "CNH24";
export type Asset = Currency | "USDC" | "F24";

export const CURRENCIES: ReadonlyArray<Currency> = /* @__PURE__ */ freeze([
  "USD24",
  "EUR24",
  "CHF24",
  "CNH24",
]);

/** Fiat24Account `Status` enum indexes 0–5 as kebab-case (`Fiat24Account.sol:26`). */
export type AccountStatus = "na" | "soft-blocked" | "tourist" | "blocked" | "closed" | "live";

/** The contracts a call path or a drift check can name (§4.1 pins; f24 is not a proxy). */
export type ContractName =
  | "account"
  | Currency
  | "deposit"
  | "card"
  | "priceList"
  | "f24Sales"
  | "f24";

export type Recipient = { readonly address: Address } | { readonly tokenId: bigint };

export type ApprovalSpender = "card" | "deposit" | "account";

export type PayoutCurrency = "EUR24" | "CHF24";

// Declared in core (not calls) so api and flows can name intents without a
// `core -> calls` edge; calls re-exports the same types (SPEC §3.8).
export type Fiat24Intent =
  | {
      readonly kind: "transfer";
      readonly currency: Currency;
      readonly amount: bigint;
      readonly to: Recipient;
    }
  | {
      readonly kind: "exchange";
      readonly side: "exact-in" | "exact-out";
      readonly from: Currency;
      readonly to: Currency;
      readonly amount: bigint;
    }
  | {
      readonly kind: "payout";
      readonly currency: PayoutCurrency;
      readonly amount: bigint;
      readonly contactId: string;
      readonly purposeId?: bigint;
      readonly ref?: string;
      readonly payee: "off-chain";
    }
  | {
      readonly kind: "approve";
      readonly asset: Asset;
      readonly spender: ApprovalSpender;
      readonly amount: bigint;
    }
  | { readonly kind: "mint"; readonly tokenId: bigint; readonly payment: "f24" | "eth" }
  | { readonly kind: "top-up"; readonly output: Currency; readonly usdcAmount: bigint };
