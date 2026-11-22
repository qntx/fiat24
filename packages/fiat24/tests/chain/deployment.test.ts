import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { assertDeployment, verifyDeployment } from "../../src/chain/index.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import type { PinnedProxy } from "../../src/deployments/index.ts";
import { B, B_HEX, expectErrorAsync, makeStub, wordWithAddress } from "./stub.ts";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;
const PRICELIST_SLOT = "0x167";
const F24_SLOT = "0x166";

const PROXIES: ReadonlyArray<PinnedProxy> = [
  C.account,
  C.tokens.USD24,
  C.tokens.EUR24,
  C.tokens.CHF24,
  C.tokens.CNH24,
  C.deposit,
  C.card,
  C.priceList,
  C.f24Sales,
];

const OTHER = "0x00000000000000000000000000000000000000dd" as Address;

/** The honest storage table: every proxy's impl+admin slots answer the pin. */
function honestStorage(): Map<string, Hex> {
  const table = new Map<string, Hex>();
  for (const pin of PROXIES) {
    table.set(`${pin.proxy.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(pin.implementation));
    table.set(`${pin.proxy.toLowerCase()}:${ADMIN_SLOT}`, wordWithAddress(pin.admin));
  }
  // Slot 359: bytes 0-19 priceList, byte 20 f24IsActive=1 (packed — no dirty-byte rule).
  const priceList = C.priceList.proxy.toLowerCase().slice(2);
  table.set(
    `${C.account.proxy.toLowerCase()}:${PRICELIST_SLOT}`,
    `0x${"0".repeat(22)}01${priceList}` as Hex,
  );
  // Slot 358: bytes 2-21 f24, byte 1 maxDigit=6, byte 0 minDigit=0.
  const f24 = C.f24.address.toLowerCase().slice(2);
  table.set(`${C.account.proxy.toLowerCase()}:${F24_SLOT}`, `0x${"0".repeat(20)}${f24}0600` as Hex);
  return table;
}

function honestStub(storage?: Map<string, Hex>) {
  return makeStub({
    blockNumber: B,
    storage: storage ?? honestStorage(),
    calls: new Map([
      [
        `${C.account.proxy.toLowerCase()}:F24SalesAddress`,
        { answer: { result: C.f24Sales.proxy } },
      ],
      [`${C.deposit.proxy.toLowerCase()}:usdc`, { answer: { result: C.usdc } }],
      [`${C.proxyAdmin.address.toLowerCase()}:owner`, { answer: { result: C.proxyAdmin.owner } }],
    ]),
  });
}

describe("verifyDeployment", () => {
  test("an honest node reports ok with no drift", async () => {
    const stub = honestStub();
    const check = await verifyDeployment(stub.client, { blockNumber: B });
    expect(check.ok).toBe(true);
    expect(check.drift).toStrictEqual([]);
    expect(check.proxyAdminOwner).toBe(getAddress(C.proxyAdmin.owner));
    expect(check.ownerChanged).toBe(false);
    expect(check.blockNumber).toBe(B);
    // 9 proxies × 2 slots + 2 account wiring slots + 3 calls.
    const storageReqs = stub.requests.filter((r) => r.method === "eth_getStorageAt");
    expect(storageReqs).toHaveLength(20);
    for (const r of storageReqs) {
      expect((r.params as string[])[2]).toBe(B_HEX);
    }
    for (const c of stub.calls) {
      expect(c.blockTag).toBe(B_HEX);
    }
    expect(
      stub.calls.map((c) => c.functionName).toSorted((a, b) => String(a).localeCompare(String(b))),
    ).toStrictEqual(["F24SalesAddress", "owner", "usdc"]);
  });

  test("each wiring field reports its own drift entry", async () => {
    const storage = honestStorage();
    storage.set(`${C.account.proxy.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(OTHER));
    storage.set(`${C.tokens.USD24.proxy.toLowerCase()}:${ADMIN_SLOT}`, wordWithAddress(OTHER));
    const priceList = OTHER.toLowerCase().slice(2);
    storage.set(
      `${C.account.proxy.toLowerCase()}:${PRICELIST_SLOT}`,
      `0x${"0".repeat(22)}01${priceList}` as Hex,
    );
    const f24 = OTHER.toLowerCase().slice(2);
    storage.set(
      `${C.account.proxy.toLowerCase()}:${F24_SLOT}`,
      `0x${"0".repeat(20)}${f24}0600` as Hex,
    );
    const stub = makeStub({
      blockNumber: B,
      storage,
      calls: new Map([
        [`${C.account.proxy.toLowerCase()}:F24SalesAddress`, { answer: { result: OTHER } }],
        [`${C.deposit.proxy.toLowerCase()}:usdc`, { answer: { result: OTHER } }],
        [`${C.proxyAdmin.address.toLowerCase()}:owner`, { answer: { result: C.proxyAdmin.owner } }],
      ]),
    });
    const check = await verifyDeployment(stub.client, { blockNumber: B });
    expect(check.ok).toBe(false);
    expect(check.drift.map((d) => `${d.contract}:${d.field}`)).toStrictEqual([
      "account:implementation",
      "account:priceList",
      "account:f24",
      "account:f24Sales",
      "USD24:admin",
      "deposit:usdc",
    ]);
    const impl = check.drift.find((d) => d.field === "implementation");
    expect(impl?.expected.toLowerCase()).toBe(C.account.implementation.toLowerCase());
    expect(impl?.actual).toBe(getAddress(OTHER));
  });

  test("dirty high bytes in an impl slot is invalid-rpc-response", async () => {
    expect.hasAssertions();
    const storage = honestStorage();
    storage.set(
      `${C.deposit.proxy.toLowerCase()}:${IMPL_SLOT}`,
      `0xff${"0".repeat(22)}${C.deposit.implementation.toLowerCase().slice(2)}` as Hex,
    );
    const stub = honestStub(storage);
    await expectErrorAsync(
      async () => verifyDeployment(stub.client, { blockNumber: B }),
      "invalid-rpc-response",
    );
  });

  test("ownerChanged is reported but never counted as drift", async () => {
    const stub = makeStub({
      blockNumber: B,
      storage: honestStorage(),
      calls: new Map([
        [
          `${C.account.proxy.toLowerCase()}:F24SalesAddress`,
          { answer: { result: C.f24Sales.proxy } },
        ],
        [`${C.deposit.proxy.toLowerCase()}:usdc`, { answer: { result: C.usdc } }],
        [`${C.proxyAdmin.address.toLowerCase()}:owner`, { answer: { result: OTHER } }],
      ]),
    });
    const check = await verifyDeployment(stub.client, { blockNumber: B });
    expect(check.ok).toBe(true);
    expect(check.ownerChanged).toBe(true);
    expect(check.proxyAdminOwner).toBe(getAddress(OTHER));
  });

  test("a contracts subset reads only those proxies; f24 reads nothing", async () => {
    const stub = honestStub();
    const check = await verifyDeployment(stub.client, {
      contracts: ["card", "f24"],
      blockNumber: B,
    });
    expect(check.ok).toBe(true);
    const storageReqs = stub.requests.filter((r) => r.method === "eth_getStorageAt");
    expect(storageReqs).toHaveLength(2);
    expect(stub.calls.map((c) => c.functionName)).toStrictEqual(["owner"]);
  });

  test("contract list validation", async () => {
    expect.hasAssertions();
    const stub = honestStub();
    await expectErrorAsync(
      async () => verifyDeployment(stub.client, { contracts: [], blockNumber: B }),
      "invalid-argument",
    );
    await expectErrorAsync(
      async () =>
        verifyDeployment(stub.client, {
          contracts: ["bogus" as never],
          blockNumber: B,
        }),
      "invalid-argument",
    );
    expect(stub.requests).toStrictEqual([]);
  });

  test("duplicates in the contracts list are deduplicated", async () => {
    const stub = honestStub();
    const check = await verifyDeployment(stub.client, {
      contracts: ["card", "card", "card"],
      blockNumber: B,
    });
    expect(check.ok).toBe(true);
    const storageReqs = stub.requests.filter((r) => r.method === "eth_getStorageAt");
    expect(storageReqs).toHaveLength(2);
  });
});

describe("assertDeployment", () => {
  test("returns B when the requested contracts are honest", async () => {
    const stub = honestStub();
    await expect(
      assertDeployment(stub.client, { contracts: ["card"], blockNumber: B }),
    ).resolves.toBe(B);
  });

  test("throws contract-changed with the first drift's detail", async () => {
    const storage = honestStorage();
    storage.set(`${C.card.proxy.toLowerCase()}:${ADMIN_SLOT}`, wordWithAddress(OTHER));
    const stub = honestStub(storage);
    const error = await expectErrorAsync(
      async () => assertDeployment(stub.client, { contracts: ["card"], blockNumber: B }),
      "contract-changed",
    );
    expect(error.detail).toStrictEqual({ contract: "card", field: "admin" });
  });
});
