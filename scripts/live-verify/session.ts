import { isAddressEqual, recoverMessageAddress } from "viem";
import type { Address, Hex } from "viem";

import { sessionLabel, sessionMessage } from "../../packages/fiat24/src/api/session.ts";
import type {
  SessionArgs,
  SessionCore,
  SessionHeaders,
} from "../../packages/fiat24/src/api/session.ts";
import { CHAIN_ID } from "../../packages/fiat24/src/core/types.ts";

// The SDK itself grants 600 s; the server's minimum is undocumented, so this script asks for the
// shortest deadline that is practical for a human Ledger approval plus three GETs: 180 s by
// default, bounded to the documented 60..600 window.
const MIN_TTL = 60n;
const MAX_TTL = 600n;
const DEFAULT_TTL = 180n;

// Never send a grant this close to its deadline: it could expire in flight.
const EXPIRY_MARGIN_SECONDS = 15n;

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/** The §9.2 grant material for one run: deadline, the `hash` header (label) and the signed text. */
export function buildGrant(args: { tokenId: bigint; serverMs: bigint; ttl?: bigint }): {
  deadline: bigint;
  hash: string;
  message: string;
} {
  const ttl = args.ttl ?? DEFAULT_TTL;
  if (ttl < MIN_TTL || ttl > MAX_TTL) {
    throw new Error("ttl must be 60..600 seconds");
  }
  const deadline = args.serverMs / 1000n + ttl;
  const grantArgs: SessionArgs = { chainId: CHAIN_ID, tokenId: args.tokenId, deadline };
  return {
    deadline,
    hash: sessionLabel(grantArgs),
    message: sessionMessage(grantArgs),
  };
}

/**
 * Self-check the pasted/cast signature exactly as the SDK's session does: a 65-byte hex string that
 * personal_sign-recovers to the account owner. Errors never include the signature.
 */
export async function checkSignature(args: {
  message: string;
  signature: string;
  owner: Address;
}): Promise<Hex> {
  const { message, signature, owner } = args;
  if (!SIGNATURE.test(signature)) {
    throw new Error("signature is not a 65-byte hex string");
  }
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message, signature: signature as Hex });
  } catch {
    throw new Error("signature could not be verified");
  }
  if (!isAddressEqual(recovered, owner)) {
    throw new Error("signature does not recover to the account owner");
  }
  return signature as Hex;
}

/**
 * A `SessionCore` over an already-minted grant: `read` attaches the headers unless the session
 * ended or the grant expires within 15 s. There is no re-grant on 401 — a 401 propagates, because
 * it is precisely the answer to "does the server accept this label?". `write` always rejects
 * without touching `run`: the script is read-only by construction.
 */
export function readOnlySession(args: {
  headers: SessionHeaders;
  deadline: bigint;
  nowSeconds: () => bigint;
}): SessionCore {
  const { deadline, nowSeconds } = args;
  let headers: SessionHeaders | undefined = args.headers;
  return Object.freeze({
    read: async <T>(run: (h: SessionHeaders) => Promise<T>): Promise<T> => {
      if (headers === undefined) {
        throw new Error("session ended");
      }
      if (nowSeconds() >= deadline - EXPIRY_MARGIN_SECONDS) {
        throw new Error("grant expires within 15 s; refusing to send it");
      }
      return run(headers);
    },
    write: async <T>(): Promise<T> =>
      new Promise<T>((_resolve, reject) => {
        reject(new Error("live-verify is read-only"));
      }),
    end: () => {
      headers = undefined;
    },
  });
}
