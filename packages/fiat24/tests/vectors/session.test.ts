import { hashMessage, recoverMessageAddress } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { sessionLabel, sessionMessage } from "../../src/api/index.ts";
import { fiat24ErrorCodes } from "../../src/core/index.ts";
import { errorCodeStrings, expectError, loadVector } from "../helpers.ts";

const vector = loadVector("vectors/api/session.json", "api.session");
const { cases } = vector;

function argsOf(c: Readonly<Record<string, unknown>>) {
  const args = c["args"] as Readonly<Record<string, unknown>>;
  return {
    chainId: Math.trunc(Number(String(args["chainId"]))) as 42161,
    tokenId: BigInt(String(args["tokenId"])),
    deadline: BigInt(String(args["deadline"])),
  };
}

describe("vectors/api/session.json", () => {
  test("envelope", () => {
    expect(vector.schema).toBe(1);
    expect(vector.capability).toBe("api.session");
    expect(cases.length).toBeGreaterThan(0);
  });

  test("every failure code is a Fiat24ErrorCode", () => {
    expect(errorCodeStrings(cases).every((code) => fiat24ErrorCodes.some((c) => c === code))).toBe(
      true,
    );
  });

  test.each(
    cases
      .filter((c) => "label" in c)
      .map(
        (c) => [`tokenId ${String((c["args"] as Record<string, unknown>)["tokenId"])}`, c] as const,
      ),
  )("§9.2 row %s", (_title, c) => {
    const args = argsOf(c);
    expect(sessionLabel(args)).toBe(c["label"]);
    expect(sessionMessage(args)).toBe(c["message"]);
    // EIP-191 of the message must equal the cast-recorded hash.
    expect(hashMessage(sessionMessage(args))).toBe(c["eip191Hash"]);
  });

  test.each(
    cases.filter((c) => "signature" in c).map((c) => [JSON.stringify(c["args"]), c] as const),
  )("signed row %s recovers the signer", async (_title, c) => {
    const recovered = await recoverMessageAddress({
      message: sessionMessage(argsOf(c)),
      signature: c["signature"] as `0x${string}`,
    });
    expect(recovered).toBe(c["signer"]);
  });

  test.each(cases.filter((c) => "error" in c).map((c) => [JSON.stringify(c["args"]), c] as const))(
    "refuses %s",
    (_title, c) => {
      expect.hasAssertions();
      expectError(() => sessionLabel(argsOf(c)), c["error"]);
      expectError(() => sessionMessage(argsOf(c)), c["error"]);
    },
  );
});
