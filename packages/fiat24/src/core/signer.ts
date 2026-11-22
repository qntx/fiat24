import { isAddress } from "viem";
import type { Address, Hash, Hex } from "viem";

import type { Fiat24Intent } from "./types.ts";

// The seam of SPEC §10.9: the SDK never holds keys and never signs. Every
// signature goes through an injected Fiat24Signer; nothing broadcasts except
// through it.
export type Fiat24TransactionRequest = {
  readonly chainId: 42161;
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly nonce: number;
  readonly intent: Fiat24Intent;
};

export type Fiat24SessionGrant = {
  readonly chainId: 42161;
  readonly tokenId: bigint;
  readonly deadline: bigint;
  readonly hash: string;
  readonly message: string;
};

export type Fiat24Signer = {
  readonly address: Address;
  readonly sendTransaction: (request: Fiat24TransactionRequest) => Promise<Hash>;
  readonly signSessionGrant: (grant: Fiat24SessionGrant) => Promise<Hex>;
};

export type Fiat24SessionSigner = Pick<Fiat24Signer, "address" | "signSessionGrant">;

/**
 * Structural check on an injected signer (SPEC §10.9): a plain object carrying a valid `address`
 * and a callable broadcast hook. Kept beside the type so the check never drifts from the contract;
 * the static scan exempts this file, so the member names stay honest literals here.
 */
export function isFiat24Signer(candidate: unknown): candidate is Fiat24Signer {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "address" in candidate &&
    typeof candidate.address === "string" &&
    isAddress(candidate.address, { strict: false }) &&
    "sendTransaction" in candidate &&
    typeof candidate.sendTransaction === "function"
  );
}
