import { isAddressEqual, keccak256, recoverMessageAddress, toHex } from "viem";
import type { Address, Hex } from "viem";

import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error, isFiat24Error } from "../core/errors.ts";
import type { Fiat24SessionGrant, Fiat24SessionSigner } from "../core/signer.ts";
import { CHAIN_ID } from "../core/types.ts";
import { apiError } from "./http.ts";

type SessionArgs = { chainId: 42161; tokenId: bigint; deadline: bigint };

function checked(args: SessionArgs): SessionArgs {
  if (args.chainId !== CHAIN_ID) {
    throw new Fiat24Error("unsupported-chain", "unsupported chain");
  }
  assertTokenId(args.tokenId);
  if (typeof args.deadline !== "bigint" || args.deadline < 1n) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  return args;
}

/**
 * §9.2 `label = "fiat24-session-v1:" chainId ":" tokenId ":" deadline` — canonical decimals, no
 * host fields (I19: the wallet rebuilds the same bytes from the three inputs).
 */
export function sessionLabel(args: SessionArgs): string {
  const { chainId, tokenId, deadline } = checked(args);
  return `fiat24-session-v1:${chainId}:${tokenId}:${deadline}`;
}

/**
 * §9.2 `message = "I agree to access my profile. " || keccak256(utf8(label || deadline))` — the
 * preimage repeats `deadline` after the label, exactly as the server documents `keccak256(hash +
 * deadline)` (digest is lowercase hex, signed with personal_sign).
 */
export function sessionMessage(args: SessionArgs): string {
  const { deadline } = checked(args);
  const label = sessionLabel(args);
  const digest = keccak256(toHex(`${label}${deadline}`));
  return `I agree to access my profile. ${digest}`;
}

export type SessionHeaders = Readonly<Record<"tokenid" | "hash" | "deadline" | "sign", string>>;

export type SessionCore = {
  readonly read: <T>(run: (headers: SessionHeaders) => Promise<T>) => Promise<T>;
  readonly write: <T>(run: (headers: SessionHeaders) => Promise<T>) => Promise<T>;
  readonly end: () => void;
};

type Grant = {
  readonly headers: SessionHeaders;
  readonly deadline: bigint; // seconds
  readonly offset: bigint; // serverMs - localMs at mint time (ms)
};

// The `sign` header carries exactly a 65-byte hex signature, independent of the other signature
// forms viem's recovery accepts.
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
// The fixed 600 s grant lifetime stays under the documented 1200 s server cap (§9.3).
const GRANT_SECONDS = 600n;
const REUSE_MARGIN_MS = 60_000n;
const MAX_SKEW_MS = 300_000n;

function isUnauthorized(error: unknown): boolean {
  return isFiat24Error(error) && error.code === "unauthorized";
}

/**
 * The §9.3 grant lifecycle. `openSession` is lazy: the first secured call reads `GET /timestamp`,
 * offsets the local clock (|offset| > 300 s ⇒ `invalid-response`, so a hostile clock cannot stretch
 * a bearer grant), mints `deadline = floor(serverMs/1000) + 600`, asks the signer for one
 * personal_sign and self-checks the recovered address. Reads re-grant at most once per session on a
 * 401; a write 401 drops the grant and never retries. `end()` is terminal and checked after every
 * `await`, so a grant resolving after `end()` is discarded. Closure state only — nothing is
 * persisted, logged or put in an error.
 */
export function createSession(args: {
  tokenId: bigint;
  signer: Fiat24SessionSigner;
  now: () => number;
  timestamp: () => Promise<bigint>;
}): SessionCore {
  const { tokenId, signer, now, timestamp } = args;
  let ended = false;
  let grant: Grant | undefined;
  let pending: Promise<Grant> | undefined;
  let regranted = false;

  const alive = (): void => {
    if (ended) {
      throw new Fiat24Error("session-required", "session ended");
    }
  };

  const nowMs = (): bigint => {
    const ms = now();
    if (!Number.isFinite(ms)) {
      throw new Fiat24Error("invalid-argument", "invalid argument");
    }
    return BigInt(Math.floor(ms));
  };

  const mint = async (): Promise<Grant> => {
    const serverMs = await timestamp();
    alive();
    const offset = serverMs - nowMs();
    if (offset > MAX_SKEW_MS || offset < -MAX_SKEW_MS) {
      throw apiError("invalid-response", "GET /timestamp");
    }
    const deadline = serverMs / 1000n + GRANT_SECONDS;
    const grantData: Fiat24SessionGrant = Object.freeze({
      chainId: CHAIN_ID,
      tokenId,
      deadline,
      hash: sessionLabel({ chainId: CHAIN_ID, tokenId, deadline }),
      message: sessionMessage({ chainId: CHAIN_ID, tokenId, deadline }),
    });
    let signature: Hex;
    try {
      signature = await signer.signSessionGrant(grantData);
    } catch (error) {
      if (isFiat24Error(error)) {
        throw error;
      }
      throw new Fiat24Error("signer-rejected", "session grant rejected");
    }
    alive();
    // A JS signer can return anything; only a 65-byte hex signature may proceed (§9.2).
    if (typeof signature !== "string" || !SIGNATURE.test(signature)) {
      throw new Fiat24Error("invalid-response", "invalid session signature");
    }
    let recovered: Address;
    try {
      recovered = await recoverMessageAddress({ message: grantData.message, signature });
    } catch {
      throw new Fiat24Error("invalid-response", "invalid session signature");
    }
    alive();
    if (!isAddressEqual(recovered, signer.address)) {
      throw new Fiat24Error("invalid-response", "invalid session signature");
    }
    const fresh: Grant = Object.freeze({
      headers: Object.freeze({
        tokenid: tokenId.toString(),
        hash: grantData.hash,
        deadline: deadline.toString(),
        sign: signature,
      }),
      deadline,
      offset,
    });
    grant = fresh;
    return fresh;
  };

  const acquire = async (): Promise<Grant> => {
    alive();
    if (grant !== undefined && nowMs() + grant.offset < grant.deadline * 1000n - REUSE_MARGIN_MS) {
      return grant;
    }
    grant = undefined;
    pending ??= (async () => {
      try {
        return await mint();
      } finally {
        pending = undefined;
      }
    })();
    const fresh = await pending;
    alive();
    return fresh;
  };

  return Object.freeze({
    read: async <T>(run: (headers: SessionHeaders) => Promise<T>): Promise<T> => {
      let current = await acquire();
      let result: T;
      try {
        result = await run(current.headers);
      } catch (error) {
        if (!isUnauthorized(error)) {
          throw error;
        }
        alive();
        // At most one 401-triggered re-grant per session: after it is used a further 401 is
        // `unauthorized`, so a hostile API cannot turn every read into two prompts (§9.3).
        if (regranted) {
          throw error;
        }
        regranted = true;
        if (grant === current) {
          grant = undefined;
        }
        current = await acquire();
        result = await run(current.headers);
      }
      alive();
      return result;
    },
    write: async <T>(run: (headers: SessionHeaders) => Promise<T>): Promise<T> => {
      const current = await acquire();
      let result: T;
      try {
        result = await run(current.headers);
      } catch (error) {
        if (isUnauthorized(error) && grant === current) {
          grant = undefined;
        }
        throw error;
      }
      alive();
      return result;
    },
    end: () => {
      ended = true;
      grant = undefined;
      pending = undefined;
    },
  });
}
