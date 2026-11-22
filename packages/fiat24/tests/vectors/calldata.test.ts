import { describe, expect, test } from "vite-plus/test";

import {
  approveCall,
  exchangeCall,
  mintAccountCall,
  mintAccountWithEthCall,
  payoutCall,
  payoutRefCall,
  topUpCall,
  transferCall,
  transferToAccountCall,
} from "../../src/calls/index.ts";
import type { Fiat24Call } from "../../src/calls/index.ts";
import { fiat24ErrorCodes } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import type { Deployment } from "../../src/deployments/index.ts";
import { errorCodeStrings, expectError, loadVector } from "../helpers.ts";
import type { VectorCase } from "../helpers.ts";

const vector = loadVector("vectors/calls/calldata.json", "calls.calldata");
const { cases } = vector;

type CallArgs = Readonly<Record<string, unknown>>;

function deploymentOf(args: CallArgs): Deployment | undefined {
  const { chainId } = args;
  if (chainId === undefined) {
    return undefined;
  }
  // A foreign-chain deployment is constructed in-test to exercise the guard.
  // A foreign-chain deployment is constructed in-test to exercise the guard.
  return { ...arbitrum, chainId: Math.trunc(Number(String(chainId))) } as Deployment;
}

const big = (value: unknown): bigint => BigInt(String(value));

function run(c: VectorCase): Fiat24Call {
  const args = (c["args"] ?? {}) as CallArgs;
  const deployment = deploymentOf(args);
  const common = deployment === undefined ? {} : { deployment };
  const { op } = c;
  if (op === "transferCall") {
    return transferCall({
      currency: args["currency"] as never,
      to: args["to"] as never,
      amount: big(args["amount"]),
      ...common,
    });
  }
  if (op === "transferToAccountCall") {
    return transferToAccountCall({
      currency: args["currency"] as never,
      tokenId: big(args["tokenId"]),
      amount: big(args["amount"]),
      ...common,
    });
  }
  if (op === "exchangeCall") {
    return exchangeCall({
      side: args["side"] as never,
      from: args["from"] as never,
      to: args["to"] as never,
      amount: big(args["amount"]),
      ...common,
    });
  }
  if (op === "payoutCall") {
    return payoutCall({
      currency: args["currency"] as never,
      amount: big(args["amount"]),
      contactId: String(args["contactId"]),
      ...common,
    });
  }
  if (op === "payoutRefCall") {
    return payoutRefCall({
      currency: args["currency"] as never,
      amount: big(args["amount"]),
      contactId: String(args["contactId"]),
      purposeId: big(args["purposeId"]),
      ref: String(args["ref"]),
      tokenId: big(args["tokenId"]),
      ...common,
    });
  }
  if (op === "approveCall") {
    return approveCall({
      asset: args["asset"] as never,
      spender: args["spender"] as never,
      amount: big(args["amount"]),
      ...common,
    });
  }
  if (op === "mintAccountCall") {
    return mintAccountCall({ tokenId: big(args["tokenId"]), ...common });
  }
  if (op === "mintAccountWithEthCall") {
    return mintAccountWithEthCall({
      tokenId: big(args["tokenId"]),
      value: big(args["value"]),
      ...common,
    });
  }
  if (op === "topUpCall") {
    return topUpCall({
      output: args["output"] as never,
      usdcAmount: big(args["usdcAmount"]),
      ...common,
    });
  }
  throw new Error(`unknown op ${String(op)}`);
}

describe("vectors/calls/calldata.json", () => {
  test("envelope", () => {
    expect(vector.schema).toBe(1);
    expect(vector.capability).toBe("calls.calldata");
    expect(cases.length).toBeGreaterThan(0);
  });

  test("every failure code is a Fiat24ErrorCode", () => {
    expect(errorCodeStrings(cases).every((code) => fiat24ErrorCodes.some((c) => c === code))).toBe(
      true,
    );
  });

  test.each(
    cases
      .filter((c) => "output" in c)
      .map((c) => [`${String(c["op"])} ${JSON.stringify(c["args"]).slice(0, 70)}`, c] as const),
  )("builds %s", (_title, c) => {
    const call = run(c);
    const expected = c["output"] as Readonly<Record<string, unknown>>;
    expect(call.to).toBe(expected["to"]);
    expect(call.data).toBe(expected["data"]);
    expect(call.value.toString()).toBe(expected["value"]);
    expect(call.contracts).toStrictEqual(expected["contracts"]);
  });

  test.each(
    cases
      .filter((c) => "error" in c)
      .map((c) => [`${String(c["op"])} ${JSON.stringify(c["args"]).slice(0, 70)}`, c] as const),
  )("refuses %s", (_title, c) => {
    expect.hasAssertions();
    expectError(() => run(c), c["error"]);
  });
});
