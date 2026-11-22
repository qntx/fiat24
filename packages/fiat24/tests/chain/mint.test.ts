import type { Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { getMintQuote, mintPriceWei } from "../../src/chain/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { expectError } from "../helpers.ts";
import { B, expectErrorAsync, makeStub, wordWithAddress } from "./stub.ts";
import type { CallTable } from "./stub.ts";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const MINT_ID = 402001n;
const OTHER = "0x00000000000000000000000000000000000000dd";

/** Honest storage for the mint path (account, priceList, f24Sales + wiring slots). */
function mintStorage(): Map<string, Hex> {
  const table = new Map<string, Hex>();
  for (const pin of [C.account, C.priceList, C.f24Sales]) {
    table.set(`${pin.proxy.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(pin.implementation));
    table.set(`${pin.proxy.toLowerCase()}:${ADMIN_SLOT}`, wordWithAddress(pin.admin));
  }
  const priceList = C.priceList.proxy.toLowerCase().slice(2);
  table.set(`${C.account.proxy.toLowerCase()}:0x167`, `0x${"0".repeat(22)}01${priceList}` as Hex);
  const f24 = C.f24.address.toLowerCase().slice(2);
  table.set(`${C.account.proxy.toLowerCase()}:0x166`, `0x${"0".repeat(20)}${f24}0600` as Hex);
  return table;
}

function mintStub(opts: {
  readonly exists?: boolean;
  readonly price?: bigint;
  readonly quote?: bigint;
  readonly maxDigit?: number;
  readonly storage?: Map<string, Hex>;
}) {
  const calls = new Map([
    [`${C.account.proxy.toLowerCase()}:F24SalesAddress`, { answer: { result: C.f24Sales.proxy } }],
    [`${C.proxyAdmin.address.toLowerCase()}:owner`, { answer: { result: C.proxyAdmin.owner } }],
    [
      `${C.account.proxy.toLowerCase()}:exists`,
      { args: [MINT_ID], answer: { result: opts.exists ?? false } },
    ],
    [
      `${C.priceList.proxy.toLowerCase()}:getPrice`,
      { args: [MINT_ID], answer: { result: opts.price ?? 100n } },
    ],
    [
      `${C.f24Sales.proxy.toLowerCase()}:quotePerEther`,
      { answer: { result: opts.quote ?? 200_000n } },
    ],
    [
      `${C.account.proxy.toLowerCase()}:maxDigitForSale`,
      { answer: { result: opts.maxDigit ?? 6 } },
    ],
  ]) as CallTable;
  return makeStub({
    blockNumber: B,
    calls,
    storage: opts.storage ?? mintStorage(),
  });
}

describe("mintPriceWei (pure)", () => {
  // Fiat24Account.sol:102-107 — quote < price ? (price/quote)*1e18 : 1e18/(quote/price).
  test("the contract formula both branches", () => {
    expect(mintPriceWei({ priceF24: 2n, quotePerEther: 1n })).toBe(2n * 10n ** 18n);
    expect(mintPriceWei({ priceF24: 5n, quotePerEther: 10n })).toBe(5n * 10n ** 17n);
    expect(mintPriceWei({ priceF24: 3n, quotePerEther: 3n })).toBe(10n ** 18n / 1n);
  });

  test("zero or non-bigint inputs are invalid-argument", () => {
    expect.hasAssertions();
    expectError(() => mintPriceWei({ priceF24: 0n, quotePerEther: 1n }), "invalid-argument");
    expectError(() => mintPriceWei({ priceF24: 1n, quotePerEther: 0n }), "invalid-argument");
    expectError(() => mintPriceWei({ priceF24: -1n, quotePerEther: 1n }), "invalid-argument");
  });
});

describe("getMintQuote", () => {
  test("happy path: drift check first, then the four-read round at B", async () => {
    const stub = mintStub({ price: 100n, quote: 200_000n });
    const quote = await getMintQuote(stub.client, { tokenId: MINT_ID, blockNumber: B });
    // 200000/100=2000 → 1e18/2000 = 5e14 wei.
    expect(quote).toStrictEqual({
      tokenId: MINT_ID,
      taken: false,
      priceF24: 100n,
      priceWei: 5n * 10n ** 14n,
      blockNumber: B,
    });
    // Storage reads of the drift check all carry the block tag.
    const storageReqs = stub.requests.filter((r) => r.method === "eth_getStorageAt");
    expect(storageReqs).toHaveLength(8);
    const existsCall = stub.calls.find((c) => c.functionName === "exists");
    expect(existsCall?.args).toStrictEqual([MINT_ID]);
    const priceCall = stub.calls.find((c) => c.functionName === "getPrice");
    expect(priceCall?.to).toBe(C.priceList.proxy);
    const quoteCall = stub.calls.find((c) => c.functionName === "quotePerEther");
    expect(quoteCall?.to).toBe(C.f24Sales.proxy);
  });

  test("taken ids report taken: true", async () => {
    const stub = mintStub({ exists: true });
    const quote = await getMintQuote(stub.client, { tokenId: MINT_ID, blockNumber: B });
    expect(quote.taken).toBe(true);
  });

  test("maxDigitForSale < 6 is unavailable with reason mint-digits", async () => {
    const stub = mintStub({ maxDigit: 5 });
    const error = await expectErrorAsync(
      async () => getMintQuote(stub.client, { tokenId: MINT_ID, blockNumber: B }),
      "unavailable",
    );
    expect(error.detail).toStrictEqual({ contract: "account", reason: "mint-digits" });
  });

  test("a zero price or quote is invalid-rpc-response", async () => {
    expect.hasAssertions();
    const zeroPrice = mintStub({ price: 0n });
    await expectErrorAsync(
      async () => getMintQuote(zeroPrice.client, { tokenId: MINT_ID, blockNumber: B }),
      "invalid-rpc-response",
    );
    const zeroQuote = mintStub({ quote: 0n });
    await expectErrorAsync(
      async () => getMintQuote(zeroQuote.client, { tokenId: MINT_ID, blockNumber: B }),
      "invalid-rpc-response",
    );
  });

  test("non-standard ids are invalid-account-id before any I/O", async () => {
    const stub = mintStub({});
    await Promise.all(
      [0n, 99_999n, 800_000n, 9103n].map(async (id) =>
        expectErrorAsync(
          async () => getMintQuote(stub.client, { tokenId: id, blockNumber: B }),
          "invalid-account-id",
        ),
      ),
    );
    expect(stub.calls).toStrictEqual([]);
    expect(stub.requests).toStrictEqual([]);
  });

  test("a drifted priceList implementation is contract-changed before the round", async () => {
    const storage = mintStorage();
    storage.set(`${C.priceList.proxy.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(OTHER));
    const stub = mintStub({ storage });
    const error = await expectErrorAsync(
      async () => getMintQuote(stub.client, { tokenId: MINT_ID, blockNumber: B }),
      "contract-changed",
    );
    expect(error.detail).toStrictEqual({ contract: "priceList", field: "implementation" });
    expect(stub.calls.find((c) => c.functionName === "getPrice")).toBeUndefined();
  });
});
