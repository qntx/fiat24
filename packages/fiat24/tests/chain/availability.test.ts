import type { Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { getAvailability } from "../../src/chain/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { B, B_HEX, expectErrorAsync, makeStub } from "./stub.ts";

const PAUSED_TARGETS: ReadonlyArray<{ address: string; abi: string }> = [
  { address: C.account.proxy, abi: "account" },
  { address: C.tokens.USD24.proxy, abi: "token" },
  { address: C.tokens.EUR24.proxy, abi: "token" },
  { address: C.tokens.CHF24.proxy, abi: "token" },
  { address: C.tokens.CNH24.proxy, abi: "token" },
  { address: C.deposit.proxy, abi: "deposit" },
  { address: C.card.proxy, abi: "card" },
  { address: C.f24Sales.proxy, abi: "f24sales" },
];

/** Storage slot 359 with priceList in bytes 0-19 and f24IsActive in byte 20. */
function slot359(active: string): Hex {
  return `0x${"0".repeat(22)}${active}${C.priceList.proxy.toLowerCase().slice(2)}` as Hex;
}

function availabilityStub(opts: {
  paused?: boolean;
  marketClosed?: boolean;
  maxDigitForSale?: number;
  f24Active?: "00" | "01";
  slot359?: Hex;
  onRequest?: (method: string, params: unknown) => unknown;
}) {
  const paused = opts.paused ?? false;
  const calls = new Map();
  for (const target of PAUSED_TARGETS) {
    calls.set(`${target.address.toLowerCase()}:paused`, { answer: { result: paused } });
  }
  calls.set(`${C.deposit.proxy.toLowerCase()}:marketClosed`, {
    answer: { result: opts.marketClosed ?? false },
  });
  calls.set(`${C.account.proxy.toLowerCase()}:maxDigitForSale`, {
    answer: { result: opts.maxDigitForSale ?? 6 },
  });
  const storage = new Map<string, Hex>([
    [`${C.account.proxy.toLowerCase()}:0x167`, opts.slot359 ?? slot359(opts.f24Active ?? "01")],
  ]);
  return makeStub({
    blockNumber: B,
    calls,
    storage,
    ...(opts.onRequest === undefined ? {} : { onRequest: opts.onRequest }),
  });
}

const nonStringStorage = (method: string): unknown =>
  method === "eth_getStorageAt" ? 42 : undefined;

describe("getAvailability", () => {
  test("reads every flag in one round at B", async () => {
    const stub = availabilityStub({});
    const availability = await getAvailability(stub.client, { blockNumber: B });
    expect(availability).toStrictEqual({
      account: { paused: false, f24Active: true, maxDigitForSale: 6 },
      tokens: {
        USD24: { paused: false },
        EUR24: { paused: false },
        CHF24: { paused: false },
        CNH24: { paused: false },
      },
      deposit: { paused: false, marketClosed: false },
      card: { paused: false },
      f24Sales: { paused: false },
      blockNumber: B,
    });
    // 8 paused() + marketClosed + maxDigitForSale = 10 calls, 1 storage read.
    expect(stub.calls).toHaveLength(10);
    const storageReqs = stub.requests.filter((r) => r.method === "eth_getStorageAt");
    expect(storageReqs).toStrictEqual([
      {
        method: "eth_getStorageAt",
        params: [C.account.proxy, "0x167", B_HEX],
      },
    ]);
    for (const call of stub.calls) {
      expect(call.blockTag).toBe(B_HEX);
    }
  });

  test("paused and marketClosed flags propagate; f24IsActive=0 ⇒ f24Active false", async () => {
    const stub = availabilityStub({
      paused: true,
      marketClosed: true,
      f24Active: "00",
      maxDigitForSale: 9,
    });
    const availability = await getAvailability(stub.client, { blockNumber: B });
    expect(availability.account.paused).toBe(true);
    expect(availability.account.f24Active).toBe(false);
    expect(availability.account.maxDigitForSale).toBe(9);
    expect(availability.deposit.paused).toBe(true);
    expect(availability.deposit.marketClosed).toBe(true);
    expect(availability.tokens.EUR24.paused).toBe(true);
  });

  test("a byte-20 value other than 00/01 is invalid-rpc-response", async () => {
    expect.hasAssertions();
    const stub = availabilityStub({ slot359: slot359("02") });
    await expectErrorAsync(
      async () => getAvailability(stub.client, { blockNumber: B }),
      "invalid-rpc-response",
    );
  });

  test("a malformed storage word is invalid-rpc-response", async () => {
    expect.hasAssertions();
    const stub = availabilityStub({ slot359: "0x1234" });
    await expectErrorAsync(
      async () => getAvailability(stub.client, { blockNumber: B }),
      "invalid-rpc-response",
    );
  });

  test("a non-string storage result is invalid-rpc-response", async () => {
    expect.hasAssertions();
    const stub = availabilityStub({ onRequest: nonStringStorage });
    await expectErrorAsync(
      async () => getAvailability(stub.client, { blockNumber: B }),
      "invalid-rpc-response",
    );
  });
});
