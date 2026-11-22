import { cast } from "./lib.ts";
import type { VectorSource } from "./lib.ts";

// Public Foundry/anvil test key 0 (hardhat/anvil account, never real funds).
const ANVIL_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDRESS0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// The three §9.2 rows: chainId, tokenId, deadline (canonical decimals).
const ROWS = [
  { chainId: "42161", tokenId: "123456", deadline: "1795278000" },
  { chainId: "42161", tokenId: "1", deadline: "1795305600" },
  { chainId: "42161", tokenId: "9007199254740993", deadline: "4102444800" },
] as const;

export function build(): {
  capability: string;
  source: Omit<VectorSource, "generator">;
  cases: unknown[];
} {
  const cases: unknown[] = [];
  for (const [index, row] of ROWS.entries()) {
    const label = `fiat24-session-v1:${row.chainId}:${row.tokenId}:${row.deadline};`;
    const preimage = `${label}${row.deadline}`;
    const digest = cast(["keccak", preimage]);
    const message = `I agree to access my profile. ${digest}`;
    const eip191Hash = cast(["hash-message", message]);
    const out: Record<string, unknown> = {
      args: { ...row },
      label,
      preimage,
      digest,
      message,
      eip191Hash,
    };
    if (index === 0) {
      out["signer"] = ANVIL_ADDRESS0;
      out["signature"] = cast(["wallet", "sign", "--private-key", ANVIL_KEY0, message]);
    }
    cases.push(out);
  }
  cases.push(
    {
      args: { chainId: "1", tokenId: "123456", deadline: "1795278000" },
      error: "unsupported-chain",
    },
    {
      args: { chainId: "42161", tokenId: "0", deadline: "1795278000" },
      error: "invalid-account-id",
    },
    {
      args: { chainId: "42161", tokenId: "123456", deadline: "0" },
      error: "invalid-argument",
    },
  );
  return {
    capability: "api.session",
    source: {
      kind: "reference",
      name: "cast",
      version: "1.10.0",
      evidence:
        "SPEC §9.2 table with the `;` label terminator; digest via `cast keccak`, EIP-191 hash via `cast hash-message`, row-1 signature via `cast wallet sign` (public anvil test key 0)",
    },
    cases,
  };
}
