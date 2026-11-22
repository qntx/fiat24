import type { Address, Hash, Hex } from "viem";

import type { Currency } from "../core/types.ts";

/** The untrusted log shape a host hands in (viem `Log` minus the fields the decoder never reads). */
export type RawLog = {
  readonly address: Address;
  readonly topics: ReadonlyArray<Hex>;
  readonly data: Hex;
  // oxlint-disable-next-line typescript/no-restricted-types -- receipt JSON carries null on pending logs; the decoder refuses it
  readonly blockNumber: bigint | null;
  // oxlint-disable-next-line typescript/no-restricted-types -- receipt JSON carries null on pending logs; the decoder refuses it
  readonly transactionHash: Hash | null;
  // oxlint-disable-next-line typescript/no-restricted-types -- receipt JSON carries null on pending logs; the decoder refuses it
  readonly logIndex: number | null;
};

type Base = {
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
  readonly logIndex: number;
};

/** The §7.1 decoded set; field mapping is documented per event in `decode.ts`. */
export type Fiat24Event = Base &
  (
    | {
        readonly kind: "transfer";
        readonly currency: Currency;
        readonly from: Address;
        readonly to: Address;
        readonly amount: bigint;
      }
    | {
        readonly kind: "approval";
        readonly currency: Currency;
        readonly owner: Address;
        readonly spender: Address;
        readonly amount: bigint;
      }
    | {
        readonly kind: "payout";
        readonly currency: Currency;
        readonly tokenId: bigint;
        readonly sender: Address;
        readonly payoutAccount: bigint;
        readonly amount: bigint;
        readonly contactId: string;
        readonly txid: string;
      }
    | {
        readonly kind: "payout-ref";
        readonly currency: Currency;
        readonly tokenId: bigint;
        readonly sender: Address;
        readonly payoutAccount: bigint;
        readonly amount: bigint;
        readonly contactId: string;
        readonly txid: string;
        readonly purposeId: bigint;
        readonly ref: string;
      }
    | {
        readonly kind: "cash-deposit";
        readonly currency: Currency;
        readonly tokenId: bigint;
        readonly recipient: Address;
        readonly depositAccount: bigint;
      }
    | {
        readonly kind: "cash-deposit-rejected";
        readonly currency: Currency;
        readonly tokenId: bigint;
        readonly depositAccount: bigint;
      }
    | {
        readonly kind: "cash-payout";
        readonly currency: Currency;
        readonly tokenId: bigint;
        readonly sender: Address;
        readonly payoutAccount: bigint;
        readonly settlement: "settled" | "rejected" | "unknown";
        readonly bankId: string;
        readonly trxId: string;
      }
    | {
        readonly kind: "exchange";
        readonly side: "exact-in" | "exact-out";
        readonly sender: Address;
        readonly inputToken: Address;
        readonly outputToken: Address;
        readonly input?: Currency;
        readonly output?: Currency;
        readonly inputAmount: bigint;
        readonly outputAmount: bigint;
      }
    | {
        readonly kind: "top-up";
        readonly via: "usdc" | "eth" | "token-via-eth";
        readonly sender: Address;
        readonly inputToken: Address;
        readonly outputToken: Address;
        readonly output?: Currency;
        readonly inputAmount: bigint;
        readonly outputAmount: bigint;
      }
    | {
        readonly kind: "top-up-by-wallet";
        readonly tokenId: bigint;
        readonly client: Address;
        readonly walletId: bigint;
        readonly wallet: Address;
        readonly outputToken: Address;
        readonly output?: Currency;
        readonly usdcAmount: bigint;
      }
    | {
        readonly kind: "card-authorized" | "card-incremented";
        readonly tokenId: bigint;
        readonly sender: Address;
        readonly cardId: string;
        readonly authorizationToken: string;
        readonly token: Address;
        readonly currency?: Currency;
        readonly amount: bigint;
      }
    | {
        readonly kind: "card-refund" | "card-reversal";
        readonly tokenId: bigint;
        readonly sender: Address;
        readonly cardId: string;
        readonly adviceToken: string;
        readonly originalAuthorizationToken: string;
        readonly token: Address;
        readonly currency?: Currency;
        readonly amount: bigint;
      }
    | {
        readonly kind: "account-transfer";
        readonly from: Address;
        readonly to: Address;
        readonly tokenId: bigint;
      }
  );
