import type { Address, Client, Hex } from "viem";
import { isAddress } from "viem";
import { call } from "viem/actions";

import type { Fiat24Call } from "../calls/types.ts";
import { Fiat24Error } from "../core/errors.ts";
import { throwMapped, resolveDeployment } from "./context.ts";

type AnyClient = Client;

/**
 * SPEC §8.2: `eth_call({from, to, data, value}, B)` — a dry run of a built call. Reverts go through
 * the §6.3 table with `detail.reason` for `unavailable` (the flow reads pause states off them);
 * everything else maps to rpc-error/invalid-rpc-response.
 */
export async function simulateCall(
  client: AnyClient,
  args: { call: Fiat24Call; from: Address; blockNumber: bigint },
): Promise<Hex> {
  resolveDeployment(client, undefined);
  if (typeof args.from !== "string" || !isAddress(args.from, { strict: false })) {
    throw new Fiat24Error("invalid-address", "invalid address");
  }
  if (typeof args.blockNumber !== "bigint" || args.blockNumber < 0n) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const built = args.call;
  try {
    const result = await call(client, {
      account: args.from,
      to: built.to,
      data: built.data,
      value: built.value,
      blockNumber: args.blockNumber,
    });
    return result.data ?? "0x";
  } catch (error) {
    return throwMapped(error);
  }
}
