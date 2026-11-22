import { Fiat24Error } from "./errors.ts";
import { freeze } from "./freeze.ts";

const MAX_TOKEN_ID: bigint = 2n ** 256n;

/** `tokenId` is an ERC-721 id and the Fiat24 account number: valid range 1..2^256-1 (SPEC §5.2). */
export function assertTokenId(tokenId: bigint): void {
  if (tokenId < 1n || tokenId >= MAX_TOKEN_ID) {
    throw new Fiat24Error("invalid-account-id", `invalid account id ${tokenId}`);
  }
}

// Internal accounts are the operator desks the contract treats specially:
// `tokenId >= 9100 && tokenId <= 9299` (Fiat24Account.sol:299,318).
export function isInternalAccount(tokenId: bigint): boolean {
  return tokenId >= 9100n && tokenId <= 9299n;
}

// The nine internal desks that exist on chain today (SPEC §4.2): treasury,
// cash desk, payout desk, sundry, payout burn (Fiat24Token.sol:66,71,114,144,
// 233), crypto desk and fee desk (Fiat24CryptoDeposit.sol:47-49), card booked
// (Fiat24CardAuthorizationMarqeta.sol:29-31), closed collector
// (Fiat24Account.sol:162).
export const INTERNAL_ACCOUNTS: Readonly<{
  treasury: 9100n;
  cashDesk: 9101n;
  payoutDesk: 9102n;
  sundry: 9103n;
  payoutBurn: 9104n;
  cryptoDesk: 9105n;
  closedCollector: 9106n;
  cardBooked: 9110n;
  feeDesk: 9203n;
}> = /* @__PURE__ */ freeze({
  treasury: 9100n,
  cashDesk: 9101n,
  payoutDesk: 9102n,
  sundry: 9103n,
  payoutBurn: 9104n,
  cryptoDesk: 9105n,
  closedCollector: 9106n,
  cardBooked: 9110n,
  feeDesk: 9203n,
});

// Ids a retail client can mint at the standard price: six digits, first digit
// 1-7 (INTERNALDIGIT 9 and MERCHANTDIGIT 8 prefixes are reserved,
// Fiat24Account.sol:33-34). The contract also sells shorter and 8-prefixed ids
// at premium prices (Fiat24PriceList.sol:20-41); the SDK refuses those.
export function isStandardMintId(tokenId: bigint): boolean {
  return tokenId >= 100000n && tokenId <= 799999n;
}
