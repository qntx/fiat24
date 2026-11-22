import type { Address, Hex } from "viem";

import { Fiat24Error } from "../core/errors.ts";
import { MAX_UNITS } from "../core/money.ts";
import { CHAIN_ID, CURRENCIES } from "../core/types.ts";
import type { Asset, ContractName, Currency, Fiat24Intent } from "../core/types.ts";
import { arbitrum } from "../deployments/data.ts";
import type { Deployment } from "../deployments/deployment.ts";

/** A data-first write: bytes and the typed intent; only the injected signer broadcasts (I2). */
export type Fiat24Call = {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly intent: Fiat24Intent;
  readonly contracts: ReadonlyArray<ContractName>;
};

const CURRENCY_SET: ReadonlySet<string> = new Set(CURRENCIES);

function isCurrency(value: string): value is Currency {
  return CURRENCY_SET.has(value);
}

// Only the transfer intent carries a nested Recipient; exchange's `to` is a Currency string.
const freezeIntent = (intent: Fiat24Intent): Fiat24Intent =>
  "to" in intent && typeof intent.to === "object"
    ? Object.freeze({ ...intent, to: Object.freeze(intent.to) })
    : Object.freeze(intent);

/** Deep-freeze the call: the returned object is exactly the data the signer receives (I2). */
export function freezeCall(call: Fiat24Call): Fiat24Call {
  return Object.freeze({
    ...call,
    intent: freezeIntent(call.intent),
    contracts: Object.freeze(call.contracts),
  });
}

/** Layer-internal: every builder starts from the §4.1 pin and refuses any other chain (I21). */
export function checkedDeployment(deployment: Deployment | undefined): Deployment {
  const resolved = deployment ?? arbitrum;
  if (resolved.chainId !== CHAIN_ID) {
    throw new Fiat24Error("unsupported-chain", "unsupported chain");
  }
  return resolved;
}

/** Layer-internal: a JS caller can pass any string where a Currency union member is expected. */
export function checkedCurrency(currency: unknown): Currency {
  if (typeof currency !== "string" || !isCurrency(currency)) {
    throw new Fiat24Error("unsupported-currency", "unsupported currency");
  }
  return currency;
}

const ASSET_SET: ReadonlySet<string> = new Set([...CURRENCIES, "USDC", "F24"]);

function isAsset(value: string): value is Asset {
  return ASSET_SET.has(value);
}

/** Layer-internal: same guard for the wider Asset union (cash tokens + USDC + F24). */
export function checkedAsset(asset: unknown): Asset {
  if (typeof asset !== "string" || !isAsset(asset)) {
    throw new Fiat24Error("unsupported-currency", "unsupported currency");
  }
  return asset;
}

/** Layer-internal: the shared amount rule of §6.1 (1 <= amount < MAX_UNITS, no rounding). */
export function checkedAmount(amount: bigint): void {
  if (typeof amount !== "bigint" || amount < 1n) {
    throw new Fiat24Error("invalid-amount", "invalid amount");
  }
  if (amount >= MAX_UNITS) {
    throw new Fiat24Error("amount-out-of-range", "amount out of range");
  }
}
