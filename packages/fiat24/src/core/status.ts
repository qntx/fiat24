import { Fiat24Error } from "./errors.ts";
import type { AccountStatus } from "./types.ts";

// `enum Status { Na, SoftBlocked, Tourist, Blocked, Closed, Live }` — indexes
// 0..5 (Fiat24Account.sol:26).
const STATUSES: ReadonlyArray<AccountStatus> = [
  "na",
  "soft-blocked",
  "tourist",
  "blocked",
  "closed",
  "live",
];

export function accountStatusFromIndex(index: number): AccountStatus {
  // Array indexing also rejects negative, fractional and NaN indexes: they all
  // read `undefined`.
  const status = STATUSES[index];
  if (status === undefined) {
    throw new Fiat24Error("invalid-rpc-response", "account status index out of range");
  }
  return status;
}
