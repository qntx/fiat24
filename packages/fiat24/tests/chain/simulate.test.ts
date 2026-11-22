import { encodeErrorResult } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { approveCall } from "../../src/calls/approve.ts";
import type { Fiat24Call } from "../../src/calls/types.ts";
import { simulateCall } from "../../src/chain/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { B, B_HEX, expectErrorAsync, makeStub, OWNER } from "./stub.ts";

const BUILT = approveCall({ asset: "EUR24", spender: "card", amount: 100n });

const valueCall: Fiat24Call = {
  ...BUILT,
  value: 7n,
};

describe("simulateCall", () => {
  test("issues eth_call with from/to/data/value at the block tag", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.EUR24.proxy.toLowerCase()}:approve`,
          { args: [C.card.proxy, 100n], answer: { result: true } },
        ],
      ]),
    });
    const out = await simulateCall(stub.client, {
      call: BUILT,
      from: OWNER,
      blockNumber: B,
    });
    expect(out).toBe(`0x${"0".repeat(63)}1`);
    const [call] = stub.calls;
    expect(call?.to).toBe(C.tokens.EUR24.proxy);
    expect(call?.from).toBe(OWNER);
    expect(call?.value).toBe(0n);
    expect(call?.blockTag).toBe(B_HEX);
    expect(call?.functionName).toBe("approve");
    expect(call?.args).toStrictEqual([C.card.proxy, 100n]);
  });

  test("call.value passes through", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [`${C.tokens.EUR24.proxy.toLowerCase()}:approve`, { answer: { result: true } }],
      ]),
    });
    await simulateCall(stub.client, { call: valueCall, from: OWNER, blockNumber: B });
    expect(stub.calls[0]?.value).toBe(7n);
  });

  test("an empty return decodes as 0x", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [`${C.tokens.EUR24.proxy.toLowerCase()}:approve`, { answer: { raw: "0x" as Hex } }],
      ]),
    });
    // viem `call` returns {data}; a raw "0x" still surfaces as data.
    const out = await simulateCall(stub.client, {
      call: BUILT,
      from: OWNER,
      blockNumber: B,
    });
    expect(out).toBe("0x");
  });

  test("a revert goes through the §6.3 table with reason", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.EUR24.proxy.toLowerCase()}:approve`,
          {
            answer: {
              revert: encodeErrorResult({
                abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }] as const,
                errorName: "Error",
                args: ["Fiat24Token: All account transfers are paused"],
              }),
            },
          },
        ],
      ]),
    });
    const error = await expectErrorAsync(
      async () =>
        simulateCall(stub.client, {
          call: BUILT,
          from: OWNER,
          blockNumber: B,
        }),
      "unavailable",
    );
    expect(error.detail.reason).toBe("account-paused");
    expect(error.detail.revert).toStrictEqual({
      kind: "error",
      reason: "Fiat24Token: All account transfers are paused",
    });
  });

  test("an unrecognised revert still yields contract-revert with kind unknown", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.EUR24.proxy.toLowerCase()}:approve`,
          { answer: { revert: "0xdeadbeef" as Hex } },
        ],
      ]),
    });
    const error = await expectErrorAsync(
      async () =>
        simulateCall(stub.client, {
          call: BUILT,
          from: OWNER,
          blockNumber: B,
        }),
      "contract-revert",
    );
    expect(error.detail.revert).toStrictEqual({ kind: "unknown" });
  });

  test("a code-3 revert without data still maps to contract-revert", async () => {
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.EUR24.proxy.toLowerCase()}:approve`,
          { answer: { thrown: { code: 3, message: "execution reverted" } } },
        ],
      ]),
    });
    const error = await expectErrorAsync(
      async () =>
        simulateCall(stub.client, {
          call: BUILT,
          from: OWNER,
          blockNumber: B,
        }),
      "contract-revert",
    );
    expect(error.detail.revert).toStrictEqual({ kind: "unknown" });
  });

  test("a transport failure is rpc-error", async () => {
    expect.hasAssertions();
    const stub = makeStub({
      blockNumber: B,
      calls: new Map([
        [
          `${C.tokens.EUR24.proxy.toLowerCase()}:approve`,
          { answer: { thrown: { code: -32000, message: "boom" } } },
        ],
      ]),
    });
    await expectErrorAsync(
      async () =>
        simulateCall(stub.client, {
          call: BUILT,
          from: OWNER,
          blockNumber: B,
        }),
      "rpc-error",
    );
  });

  test("validates from/blockNumber and the client chain before I/O", async () => {
    const stub = makeStub({ blockNumber: B });
    await expectErrorAsync(
      async () =>
        simulateCall(stub.client, {
          call: BUILT,
          from: "nope" as Address,
          blockNumber: B,
        }),
      "invalid-address",
    );
    await expectErrorAsync(
      async () =>
        simulateCall(stub.client, {
          call: BUILT,
          from: OWNER,
          blockNumber: -1n,
        }),
      "invalid-argument",
    );
    const wrongChain = makeStub({ blockNumber: B, chainId: 1 });
    await expectErrorAsync(
      async () =>
        simulateCall(wrongChain.client, {
          call: BUILT,
          from: OWNER,
          blockNumber: B,
        }),
      "unsupported-chain",
    );
    expect(stub.calls).toStrictEqual([]);
  });
});
