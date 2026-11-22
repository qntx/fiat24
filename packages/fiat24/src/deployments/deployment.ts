import type { Address, Hex } from "viem";

import { CHAIN_ID, CURRENCIES } from "../core/types.ts";
import type { ContractName, Currency } from "../core/types.ts";
import { arbitrum } from "./data.ts";

/**
 * A §4.1-pinned transparent proxy: the user-facing `proxy` address, the pinned `implementation` it
 * must still delegate to, the implementation's runtime code keccak and the ProxyAdmin from its
 * EIP-1967 admin slot. `codeHash` is asserted only by scripts/deployments/verify.ts (implementation
 * code is immutable — I5), never per write.
 */
export type PinnedProxy = {
  readonly proxy: Address;
  readonly implementation: Address;
  readonly codeHash: Hex;
  readonly admin: Address;
};

export type Deployment = {
  readonly chainId: 42161;
  readonly block: bigint;
  readonly account: PinnedProxy;
  readonly tokens: Readonly<Record<Currency, PinnedProxy>>;
  readonly deposit: PinnedProxy;
  readonly card: PinnedProxy;
  readonly priceList: PinnedProxy;
  readonly f24Sales: PinnedProxy;
  readonly f24: { readonly address: Address; readonly codeHash: Hex };
  readonly usdc: Address;
  readonly proxyAdmin: { readonly address: Address; readonly owner: Address };
};

/** The deployment for `chainId`, or `undefined` when the chain has none. */
export function getDeployment(chainId: number): Deployment | undefined {
  return chainId === CHAIN_ID ? arbitrum : undefined;
}

/** The user-facing address of a contract: the proxy, or the non-proxy F24 address. */
export function contractAddress(deployment: Deployment, name: ContractName): Address {
  switch (name) {
    case "f24":
      return deployment.f24.address;
    case "USD24":
    case "EUR24":
    case "CHF24":
    case "CNH24":
      return deployment.tokens[name].proxy;
    default:
      return deployment[name].proxy;
  }
}

const CONTRACT_NAMES: ReadonlyArray<ContractName> = [
  "account",
  ...CURRENCIES,
  "deposit",
  "card",
  "priceList",
  "f24Sales",
  "f24",
];

/**
 * Reverse lookup: which pinned contract is `address`, case-insensitively. Only proxies and F24
 * resolve — usdc, proxyAdmin and the implementation addresses are not call targets and return
 * `undefined`.
 */
export function contractOf(deployment: Deployment, address: Address): ContractName | undefined {
  const candidate = address.toLowerCase();
  for (const name of CONTRACT_NAMES) {
    if (contractAddress(deployment, name).toLowerCase() === candidate) {
      return name;
    }
  }
  return undefined;
}
