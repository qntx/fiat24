import type { Abi, Address, Client } from "viem";

import { accountAbi, cardAbi, depositAbi, f24SalesAbi, tokenAbi } from "../abi/index.ts";
import type { Currency } from "../core/types.ts";
import type { ChainArgs } from "./context.ts";
import {
  asBoolean,
  asUint8,
  invalidResponse,
  PRICELIST_SLOT,
  readAt,
  slotByte,
  snapshot,
  storageAt,
} from "./context.ts";

/** SPEC §3.6. */
export type Availability = {
  readonly account: {
    readonly paused: boolean;
    readonly f24Active: boolean;
    readonly maxDigitForSale: number;
  };
  readonly tokens: Readonly<Record<Currency, { readonly paused: boolean }>>;
  readonly deposit: { readonly paused: boolean; readonly marketClosed: boolean };
  readonly card: { readonly paused: boolean };
  readonly f24Sales: { readonly paused: boolean };
  readonly blockNumber: bigint;
};

/**
 * SPEC §8.2: one round at B — `paused()` on account, the 4 tokens, deposit, card and f24Sales;
 * `deposit.marketClosed()`; `account.maxDigitForSale()`; and `f24IsActive` from slot 359 byte 20
 * (verified storageLayout; the byte must be 0 or 1).
 */
export async function getAvailability(client: Client, args: ChainArgs = {}): Promise<Availability> {
  const { deployment, blockNumber: B } = await snapshot(client, args);

  const pausedOf = async (address: Address, abi: Abi) =>
    readAt(client, B, { address, abi, functionName: "paused" });

  const [
    accountPaused,
    usd24,
    eur24,
    chf24,
    cnh24,
    depositPaused,
    marketClosed,
    cardPaused,
    f24SalesPaused,
    maxDigitForSale,
    slot359,
  ] = await Promise.all([
    pausedOf(deployment.account.proxy, accountAbi),
    pausedOf(deployment.tokens.USD24.proxy, tokenAbi),
    pausedOf(deployment.tokens.EUR24.proxy, tokenAbi),
    pausedOf(deployment.tokens.CHF24.proxy, tokenAbi),
    pausedOf(deployment.tokens.CNH24.proxy, tokenAbi),
    pausedOf(deployment.deposit.proxy, depositAbi),
    readAt(client, B, {
      address: deployment.deposit.proxy,
      abi: depositAbi,
      functionName: "marketClosed",
    }),
    pausedOf(deployment.card.proxy, cardAbi),
    pausedOf(deployment.f24Sales.proxy, f24SalesAbi),
    readAt(client, B, {
      address: deployment.account.proxy,
      abi: accountAbi,
      functionName: "maxDigitForSale",
    }),
    storageAt(client, B, deployment.account.proxy, PRICELIST_SLOT),
  ]);

  if (typeof slot359 !== "string") {
    invalidResponse();
  }
  const f24ActiveByte = slotByte(slot359, 20);
  if (f24ActiveByte !== 0 && f24ActiveByte !== 1) {
    invalidResponse();
  }
  return {
    account: {
      paused: asBoolean(accountPaused),
      f24Active: f24ActiveByte === 1,
      maxDigitForSale: asUint8(maxDigitForSale),
    },
    tokens: {
      USD24: { paused: asBoolean(usd24) },
      EUR24: { paused: asBoolean(eur24) },
      CHF24: { paused: asBoolean(chf24) },
      CNH24: { paused: asBoolean(cnh24) },
    },
    deposit: {
      paused: asBoolean(depositPaused),
      marketClosed: asBoolean(marketClosed),
    },
    card: { paused: asBoolean(cardPaused) },
    f24Sales: { paused: asBoolean(f24SalesPaused) },
    blockNumber: B,
  };
}
