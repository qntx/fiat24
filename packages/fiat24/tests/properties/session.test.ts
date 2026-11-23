import * as fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { sessionLabel } from "../../src/api/index.ts";

const MAX_UINT256 = 2n ** 256n - 1n;

const tokenId = () => fc.bigInt({ min: 1n, max: MAX_UINT256 });
const deadline = () => fc.bigInt({ min: 1n, max: MAX_UINT256 });

// The server recomputes keccak256(hash + deadline) from separate headers and never parses the
// label, so every split of the signed preimage into (hash, all-digit tail) is a grant for the
// tail's deadline. With the `;` terminator every all-digit suffix of `label || deadline` is a
// suffix of the deadline's own digits and therefore numerically <= deadline — the signed text
// can never be re-split into a later deadline than the signer saw.
function splits(s: string): Array<{ index: number; digits: string }> {
  const out: Array<{ index: number; digits: string }> = [];
  for (let i = 0; i < s.length; i += 1) {
    const digits = s.slice(i);
    if (/^[0-9]+$/.test(digits)) {
      out.push({ index: i, digits });
    }
  }
  return out;
}

describe("session label terminator", () => {
  test("no re-split of label || deadline exceeds the signed deadline", () => {
    fc.assert(
      fc.property(tokenId(), deadline(), (id, dl) => {
        const args = { chainId: 42161 as const, tokenId: id, deadline: dl };
        const label = sessionLabel(args);
        const parts = splits(`${label}${dl}`);
        expect(parts.length).toBeGreaterThan(0);
        for (const { digits } of parts) {
          expect(BigInt(digits)).toBeLessThanOrEqual(dl);
        }
        // The honest split sits at the label boundary and decodes to the deadline itself.
        const honest = parts.filter((p) => p.index === label.length);
        expect(honest).toHaveLength(1);
        for (const { digits } of honest) {
          expect(BigInt(digits)).toBe(dl);
        }
      }),
      { numRuns: 1000 },
    );
  });

  test("regression: the digit-terminated label re-split counterexample is gone", () => {
    const args = { chainId: 42161 as const, tokenId: 123456n, deadline: 1795278000n };
    const label = sessionLabel(args);
    expect(label).toBe("fiat24-session-v1:42161:123456:1795278000;");
    const parts = splits(`${label}${args.deadline}`);
    // With the old label the same text also decoded as deadline 17952780001795278000.
    expect(parts.some((p) => p.digits === "17952780001795278000")).toBe(false);
    for (const { digits } of parts) {
      expect(BigInt(digits)).toBeLessThanOrEqual(args.deadline);
    }
  });
});
