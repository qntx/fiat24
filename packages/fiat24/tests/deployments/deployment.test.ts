import { describe, expect, test } from "vite-plus/test";

import type { ContractName } from "../../src/core/index.ts";
import {
  arbitrum,
  contractAddress,
  contractOf,
  getDeployment,
} from "../../src/deployments/index.ts";

const PROXIES = {
  account: "0x133CAEecA096cA54889db71956c7f75862Ead7A0",
  USD24: "0xbE00f3db78688d9704BCb4e0a827aea3a9Cc0D62",
  EUR24: "0x2c5d06f591D0d8cd43Ac232c2B654475a142c7DA",
  CHF24: "0xd41F1f0cf89fD239ca4c1F8E8ADA46345c86b0a4",
  CNH24: "0x7288Ac74d211735374A23707D1518DCbbc0144fd",
  deposit: "0x4582f67698843Dfb6A9F195C0dDee05B0A8C973F",
  card: "0xe2e3B88B9893e18D0867c08f9cA93f8aB5935b14",
  priceList: "0xafE30f42b1c28f7C0514e4A197407570D88044Ae",
  f24Sales: "0x6b7188D78832208B33a557a82A9F46171c16f3f2",
} as const;
const F24 = "0x22043fDdF353308B4F2e7dA2e5284E4D087449e1";

describe("arbitrum deployment", () => {
  test("pins chain 42161 at block 526365924", () => {
    expect(arbitrum.chainId).toBe(42161);
    expect(arbitrum.block).toBe(526365924n);
  });

  test("every proxy shares the same admin and pins an implementation", () => {
    const admin = "0x50873C8501143e55349f9938795f69A2BB64b6ca";
    const pinned = [
      arbitrum.account,
      arbitrum.deposit,
      arbitrum.card,
      arbitrum.priceList,
      arbitrum.f24Sales,
      ...Object.values(arbitrum.tokens),
    ];
    for (const entry of pinned) {
      expect(entry.admin).toBe(admin);
      expect(entry.implementation).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(entry.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect(arbitrum.proxyAdmin.address).toBe(admin);
    expect(arbitrum.proxyAdmin.owner).toBe("0x1272c99bEFa7a70f935Edca81BF9a6E85C6D9D59");
    expect(arbitrum.usdc).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  });
});

describe("getDeployment", () => {
  test("returns arbitrum only for 42161", () => {
    expect(getDeployment(42161)).toBe(arbitrum);
    expect(getDeployment(1)).toBeUndefined();
    expect(getDeployment(5000)).toBeUndefined();
    expect(getDeployment(0)).toBeUndefined();
  });
});

describe("contractAddress", () => {
  test.each(Object.entries(PROXIES) as Array<[ContractName, string]>)(
    "resolves %s to its proxy",
    (name, proxy) => {
      expect(contractAddress(arbitrum, name)).toBe(proxy);
    },
  );

  test("resolves f24 to the non-proxy address", () => {
    expect(contractAddress(arbitrum, "f24")).toBe(F24);
  });
});

describe("contractOf", () => {
  test.each([...Object.entries(PROXIES), ["f24", F24]] as Array<[ContractName, string]>)(
    "identifies %s case-insensitively",
    (name, address) => {
      expect(contractOf(arbitrum, address as `0x${string}`)).toBe(name);
      expect(contractOf(arbitrum, address.toLowerCase() as `0x${string}`)).toBe(name);
      expect(contractOf(arbitrum, address.toUpperCase().replace("0X", "0x") as `0x${string}`)).toBe(
        name,
      );
    },
  );

  test.each([
    ["usdc", arbitrum.usdc],
    ["proxyAdmin", arbitrum.proxyAdmin.address],
    ["proxyAdmin owner", arbitrum.proxyAdmin.owner],
    ["account implementation", arbitrum.account.implementation],
    ["USD24 implementation", arbitrum.tokens.USD24.implementation],
    ["zero address", "0x0000000000000000000000000000000000000000"],
    ["random address", "0x0000000000000000000000000000000000000001"],
  ] as const)("does not resolve %s", (_label, address) => {
    expect(contractOf(arbitrum, address)).toBeUndefined();
  });
});

describe("pin immutability", () => {
  const frozen = [
    arbitrum,
    arbitrum.account,
    arbitrum.tokens,
    arbitrum.tokens.USD24,
    arbitrum.tokens.EUR24,
    arbitrum.tokens.CHF24,
    arbitrum.tokens.CNH24,
    arbitrum.deposit,
    arbitrum.card,
    arbitrum.priceList,
    arbitrum.f24Sales,
    arbitrum.f24,
    arbitrum.proxyAdmin,
  ];

  test.each(frozen.map((entry, index) => [index, entry] as const))(
    "entry %i is frozen",
    (_index, entry) => {
      expect(Object.isFrozen(entry)).toBe(true);
    },
  );

  test("writes throw in strict mode", () => {
    const mutate = (): void => {
      (arbitrum as { chainId: number }).chainId = 1;
    };
    expect(mutate).toThrow(TypeError);
  });
});
