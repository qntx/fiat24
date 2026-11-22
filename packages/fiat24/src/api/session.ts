import { keccak256, toHex } from "viem";

import { assertTokenId } from "../core/account-id.ts";
import { Fiat24Error } from "../core/errors.ts";
import { CHAIN_ID } from "../core/types.ts";

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
