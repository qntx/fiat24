import { encodeErrorResult } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { getBalances } from "../../src/chain/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { B, B_HEX, expectErrorAsync, makeStub, OWNER } from "./stub.ts";

const C = arbitrum;

function balancesCalls(value: bigint) {
  const table = new Map();
  for (const currency of ["USD24", "EUR24", "CHF24", "CNH24"] as const) {
    table.set(`${C.tokens[currency].proxy.toLowerCase()}:balanceOf`, {
      args: [OWNER],
      answer: { result: value },
    });
  }
  return table;
}

describe("resolveDeployment", () => {
  test("client.chain undefined rejects even when a deployment is passed (I21)", async () => {
    expect.hasAssertions();
    const { client } = makeStub({ blockNumber: B, calls: balancesCalls(1n) });
    const chainless = { ...client, chain: undefined };
    await expectErrorAsync(
      async () => getBalances(chainless, { owner: OWNER, deployment: arbitrum }),
      "unsupported-chain",
    );
  });

  test("wrong chain id rejects", async () => {
    expect.hasAssertions();
    const { client } = makeStub({ blockNumber: B, chainId: 1 });
    await expectErrorAsync(async () => getBalances(client, { owner: OWNER }), "unsupported-chain");
  });

  test("a deployment with another chainId rejects", async () => {
    expect.hasAssertions();
    const { client } = makeStub({ blockNumber: B, calls: balancesCalls(1n) });
    const foreign = { ...arbitrum, chainId: 1 } as unknown as typeof arbitrum;
    await expectErrorAsync(
      async () => getBalances(client, { owner: OWNER, deployment: foreign }),
      "unsupported-chain",
    );
  });
});

describe("snapshot", () => {
  test("explicit blockNumber pins every request's block tag, no eth_blockNumber", async () => {
    const stub = makeStub({ blockNumber: B, calls: balancesCalls(7n) });
    const result = await getBalances(stub.client, { owner: OWNER, blockNumber: B });
    expect(result.blockNumber).toBe(B);
    expect(stub.requests.map((r) => r.method)).toStrictEqual([
      "eth_call",
      "eth_call",
      "eth_call",
      "eth_call",
    ]);
    for (const call of stub.calls) {
      expect(call.blockTag).toBe(B_HEX);
    }
  });

  test("no blockNumber issues a fresh eth_blockNumber first (C2)", async () => {
    const stub = makeStub({ blockNumber: B, calls: balancesCalls(7n) });
    const result = await getBalances(stub.client, { owner: OWNER });
    expect(result.blockNumber).toBe(B);
    expect(stub.requests[0]?.method).toBe("eth_blockNumber");
    for (const call of stub.calls) {
      expect(call.blockTag).toBe(B_HEX);
    }
  });

  test("invalid blockNumber rejects before any I/O", async () => {
    const stub = makeStub({ blockNumber: B, calls: balancesCalls(1n) });
    await expectErrorAsync(
      async () => getBalances(stub.client, { owner: OWNER, blockNumber: -1n }),
      "invalid-argument",
    );
    expect(stub.requests).toStrictEqual([]);
    await expectErrorAsync(
      async () =>
        getBalances(stub.client, {
          owner: OWNER,
          blockNumber: 12 as unknown as bigint,
        }),
      "invalid-argument",
    );
  });

  test("eth_blockNumber failure maps to rpc-error", async () => {
    expect.hasAssertions();
    const stub = makeStub({
      onRequest: () => {
        throw new Error("down");
      },
    });
    await expectErrorAsync(async () => getBalances(stub.client, { owner: OWNER }), "rpc-error");
  });
});

describe("readAt error mapping", () => {
  test("revert data maps to contract-revert with the decoded reason", async () => {
    const revertData = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }] as const,
      errorName: "Error",
      args: ["Fiat24Token: all account transfers are paused"],
    });
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [`${C.tokens.USD24.proxy.toLowerCase()}:balanceOf`, { answer: { revert: revertData } }],
        [`${C.tokens.EUR24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CHF24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CNH24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
      ]),
    });
    const error = await expectErrorAsync(
      async () => getBalances(stub.client, { owner: OWNER, blockNumber: B }),
      "contract-revert",
    );
    expect(error.detail.revert).toStrictEqual({
      kind: "error",
      reason: "Fiat24Token: all account transfers are paused",
    });
  });

  test("revert data nested as {data:{data}} still maps to contract-revert", async () => {
    const revertData = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }] as const,
      errorName: "Error",
      args: ["Fiat24Token: all account transfers are paused"],
    });
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.USD24.proxy.toLowerCase()}:balanceOf`,
          { answer: { thrown: { code: 3, data: { data: revertData } } } },
        ],
        [`${C.tokens.EUR24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CHF24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CNH24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
      ]),
    });
    const error = await expectErrorAsync(
      async () => getBalances(stub.client, { owner: OWNER, blockNumber: B }),
      "contract-revert",
    );
    expect(error.detail.revert).toStrictEqual({
      kind: "error",
      reason: "Fiat24Token: all account transfers are paused",
    });
  });

  test("revert without data maps to contract-revert { kind: 'unknown' }", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.USD24.proxy.toLowerCase()}:balanceOf`,
          { answer: { thrown: { code: 3, message: "execution reverted" } } },
        ],
        [`${C.tokens.EUR24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CHF24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CNH24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
      ]),
    });
    const error = await expectErrorAsync(
      async () => getBalances(stub.client, { owner: OWNER, blockNumber: B }),
      "contract-revert",
    );
    expect(error.detail.revert).toStrictEqual({ kind: "unknown" });
  });

  test("malformed return bytes map to invalid-rpc-response, not contract-revert", async () => {
    expect.hasAssertions();
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [`${C.tokens.USD24.proxy.toLowerCase()}:balanceOf`, { answer: { raw: "0xdead" } }],
        [`${C.tokens.EUR24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CHF24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CNH24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
      ]),
    });
    await expectErrorAsync(
      async () => getBalances(stub.client, { owner: OWNER, blockNumber: B }),
      "invalid-rpc-response",
    );
  });

  test("a transport failure maps to rpc-error", async () => {
    expect.hasAssertions();
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.USD24.proxy.toLowerCase()}:balanceOf`,
          { answer: { thrown: new Error("socket hangup") } },
        ],
        [`${C.tokens.EUR24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CHF24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CNH24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
      ]),
    });
    await expectErrorAsync(
      async () => getBalances(stub.client, { owner: OWNER, blockNumber: B }),
      "rpc-error",
    );
  });

  test("an out-of-domain decoded value maps to invalid-rpc-response", async () => {
    expect.hasAssertions();
    // balanceOf returns the wrong shape via a raw word the decoder accepts but
    // the action's own guard then refuses — using a string where a bigint is due.
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.USD24.proxy.toLowerCase()}:balanceOf`,
          // "0x" is not decodable as uint256 → viem decode error → invalid-rpc-response
          { answer: { raw: "0x" } },
        ],
        [`${C.tokens.EUR24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CHF24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
        [`${C.tokens.CNH24.proxy.toLowerCase()}:balanceOf`, { answer: { result: 0n } }],
      ]),
    });
    await expectErrorAsync(
      async () => getBalances(stub.client, { owner: OWNER, blockNumber: B }),
      "invalid-rpc-response",
    );
  });
});
