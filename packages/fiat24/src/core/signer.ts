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
