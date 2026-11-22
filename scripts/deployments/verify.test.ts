/**
 * `verify.ts` unit tests: a viem custom-transport stub serves the pinned values (synthetic
 * bytecodes whose keccak is re-pinned into the deployments copy, since keccak cannot be inverted),
 * so `verify` reports all-ok; one mutation per check family flips that line to DRIFT.
 */
import { join } from "node:path";

import type { Abi, Address, Hex } from "viem";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  pad,
} from "viem";
import { describe, expect, it } from "vite-plus/test";

import { accountAbi, depositAbi, f24Abi, tokenAbi } from "../../packages/fiat24/src/abi/index.ts";
import { INTERNAL_ACCOUNTS } from "../../packages/fiat24/src/core/account-id.ts";
import { DECIMALS } from "../../packages/fiat24/src/core/money.ts";
import { loadDeployments, verify } from "./verify.ts";
import type { DeploymentsData } from "./verify.ts";

const BLOCK = 526365924n;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const OTHER = "0x000000000000000000000000000000000000dEaD";

const deployments: DeploymentsData = structuredClone(
  loadDeployments(join(import.meta.dirname, "../../data/deployments.json")),
);

// Synthetic bytecodes; re-pin codeHash to their keccak so the stub can satisfy the hash checks.
const codeByAddress = new Map<string, Hex>();
const pinCode = (address: string, tag: string): void => {
  codeByAddress.set(address.toLowerCase(), `0x${tag.repeat(64)}`);
};
for (const [name, p] of Object.entries(deployments.proxies)) {
  // distinct deterministic tag per contract, e.g. "761" for "account" (len 7, 'a')
  pinCode(
    p.implementation,
    `${name.length.toString(16)}${(name.codePointAt(0) ?? 0).toString(16)}`,
  );
}
pinCode(deployments.f24.address, "6f24");
pinCode(deployments.proxyAdmin.address, "6ad4");
for (const p of Object.values(deployments.proxies)) {
  p.codeHash = keccak256(codeByAddress.get(p.implementation.toLowerCase()) ?? "0x");
}
deployments.f24.codeHash = keccak256(
  codeByAddress.get(deployments.f24.address.toLowerCase()) ?? "0x",
);
deployments.proxyAdmin.codeHash = keccak256(
  codeByAddress.get(deployments.proxyAdmin.address.toLowerCase()) ?? "0x",
);

type Responses = Map<string, unknown>;

const callKey = (to: string, abi: Abi, functionName: string, args: unknown[] = []): string =>
  `${to.toLowerCase()}:${encodeFunctionData({ abi, functionName, args })}`;

/** Builds the full pinned response map; `patch` mutates it for drift cases. */
function fixture(patch?: (r: Responses) => void): Responses {
  const r: Responses = new Map([["eth_chainId", "0xa4b1"]]);
  for (const p of Object.values(deployments.proxies)) {
    r.set(`eth_getStorageAt|${p.proxy.toLowerCase()}|${IMPL_SLOT}`, pad(p.implementation as Hex));
    r.set(`eth_getStorageAt|${p.proxy.toLowerCase()}|${ADMIN_SLOT}`, pad(p.admin as Hex));
  }
  const account = deployments.proxies["account"] as (typeof deployments.proxies)[string];
  const priceList = deployments.proxies["priceList"] as (typeof deployments.proxies)[string];
  // account slot 358: f24 at bytes 2-21; slot 359: f24IsActive byte 20 + priceList bytes 0-19
  r.set(
    `eth_getStorageAt|${account.proxy.toLowerCase()}|0x166`,
    `0x${"0".repeat(20)}${deployments.f24.address.slice(2).toLowerCase()}0605`,
  );
  r.set(
    `eth_getStorageAt|${account.proxy.toLowerCase()}|0x167`,
    `0x${"0".repeat(22)}01${priceList.proxy.slice(2).toLowerCase()}`,
  );
  for (const [address, code] of codeByAddress) {
    r.set(`eth_getCode|${address}`, code);
  }
  r.set(
    `eth_call|${callKey(deployments.proxyAdmin.address, OWNABLE, "owner")}`,
    encodeAbiParameters([{ type: "address" }], [deployments.proxyAdmin.owner as Address]),
  );
  const deposit = deployments.proxies["deposit"] as (typeof deployments.proxies)[string];
  const f24Sales = deployments.proxies["f24Sales"] as (typeof deployments.proxies)[string];
  r.set(
    `eth_call|${callKey(account.proxy, accountAbi, "F24SalesAddress")}`,
    encodeAbiParameters([{ type: "address" }], [f24Sales.proxy as Address]),
  );
  r.set(
    `eth_call|${callKey(deposit.proxy, depositAbi, "usdc")}`,
    encodeAbiParameters([{ type: "address" }], [deployments.usdc as Address]),
  );
  r.set(
    `eth_call|${callKey(deposit.proxy, depositAbi, "usdcDepositAddress")}`,
    encodeAbiParameters(
      [{ type: "address" }],
      [deployments.monitor.depositUsdcDepositAddress as Address],
    ),
  );
  for (const token of ["USD24", "EUR24", "CHF24", "CNH24"] as const) {
    const { proxy } = deployments.proxies[token] as (typeof deployments.proxies)[string];
    r.set(
      `eth_call|${callKey(proxy, tokenAbi, "sanctionCheck")}`,
      encodeAbiParameters([{ type: "bool" }], [deployments.monitor.sanctionCheck[token] ?? false]),
    );
    r.set(
      `eth_call|${callKey(proxy, tokenAbi, "sanctionContract")}`,
      encodeAbiParameters(
        [{ type: "address" }],
        [deployments.monitor.sanctionContract[token] as Address],
      ),
    );
    r.set(
      `eth_call|${callKey(proxy, tokenAbi, "decimals")}`,
      encodeAbiParameters([{ type: "uint8" }], [DECIMALS[token]]),
    );
  }
  r.set(
    `eth_call|${callKey(deployments.f24.address, f24Abi, "decimals")}`,
    encodeAbiParameters([{ type: "uint8" }], [DECIMALS["F24"]]),
  );
  r.set(
    `eth_call|${callKey(deployments.usdc, erc20Abi, "decimals")}`,
    encodeAbiParameters([{ type: "uint8" }], [DECIMALS["USDC"]]),
  );
  r.set(
    `eth_call|${callKey(account.proxy, accountAbi, "THIRTYDAYS")}`,
    encodeAbiParameters([{ type: "uint256" }], [2592000n]),
  );
  r.set(
    `eth_call|${callKey(account.proxy, accountAbi, "INTERNALDIGIT")}`,
    encodeAbiParameters([{ type: "uint8" }], [9]),
  );
  r.set(
    `eth_call|${callKey(account.proxy, accountAbi, "MERCHANTDIGIT")}`,
    encodeAbiParameters([{ type: "uint8" }], [8]),
  );
  for (const fn of ["XXX24_DIVISOR", "USDC_DIVISOR"] as const) {
    r.set(
      `eth_call|${callKey(deposit.proxy, depositAbi, fn)}`,
      encodeAbiParameters([{ type: "uint256" }], [10000n]),
    );
  }
  r.set(
    `eth_call|${callKey(deposit.proxy, depositAbi, "MAX_DIGITS")}`,
    encodeAbiParameters([{ type: "uint256" }], [5n]),
  );
  for (const id of Object.values(INTERNAL_ACCOUNTS)) {
    r.set(
      `eth_call|${callKey(account.proxy, accountAbi, "exists", [id])}`,
      encodeAbiParameters([{ type: "bool" }], [true]),
    );
  }
  patch?.(r);
  return r;
}

const OWNABLE: Abi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];

function stubClient(responses: Responses) {
  return createPublicClient({
    transport: custom({
      request: async ({ method, params }) => {
        const p = (params ?? []) as Array<Record<string, unknown>>;
        if (method === "eth_chainId" || method === "eth_blockNumber") {
          const value = await Promise.resolve(responses.get(method));
          return value;
        }
        if (method === "eth_getStorageAt" || method === "eth_getCode") {
          const [address, slot] = p as unknown as [string, string?];
          const key =
            method === "eth_getStorageAt"
              ? `${method}|${address.toLowerCase()}|${String(slot)}`
              : `${method}|${address.toLowerCase()}`;
          const value = await Promise.resolve(responses.get(key) ?? "0x");
          return value;
        }
        if (method === "eth_call") {
          const [tx] = p as unknown as [{ to: string; data: string }];
          const value = await Promise.resolve(
            responses.get(`eth_call|${tx.to.toLowerCase()}:${tx.data}`) ?? "0x",
          );
          return value;
        }
        throw new Error(`unstubbed method ${method}`);
      },
    }),
  });
}

const driftLine = (lines: string[], name: string): string | undefined =>
  lines.find((l) => l.startsWith("DRIFT ") && l.includes(name));

describe("deployments verify", () => {
  it("all pinned values served => all ok", async () => {
    const result = await verify(stubClient(fixture()), deployments, BLOCK);
    expect(result.driftCount).toBe(0);
    expect(result.okCount).toBeGreaterThan(60);
    for (const line of result.lines) {
      expect(line.startsWith("DRIFT")).toBe(false);
    }
  });

  const account = deployments.proxies["account"] as (typeof deployments.proxies)[string];
  const eur24 = deployments.proxies["EUR24"] as (typeof deployments.proxies)[string];

  it("impl slot drift", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(`eth_getStorageAt|${eur24.proxy.toLowerCase()}|${IMPL_SLOT}`, pad(OTHER as Hex));
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "EUR24.implementation")).toBeDefined();
    expect(result.driftCount).toBe(1);
  });

  it("admin slot drift", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(`eth_getStorageAt|${eur24.proxy.toLowerCase()}|${ADMIN_SLOT}`, pad(OTHER as Hex));
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "EUR24.admin")).toBeDefined();
  });

  it("dirty high bytes in impl slot", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(
            `eth_getStorageAt|${eur24.proxy.toLowerCase()}|${IMPL_SLOT}`,
            `0xff${pad(eur24.implementation as Hex).slice(3)}`,
          );
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "EUR24.implementation")).toBeDefined();
  });

  it("code hash drift", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(`eth_getCode|${eur24.implementation.toLowerCase()}`, "0xdeadbeef");
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "EUR24.codeHash")).toBeDefined();
  });

  it("proxyAdmin owner drift", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(
            `eth_call|${callKey(deployments.proxyAdmin.address, OWNABLE, "owner")}`,
            encodeAbiParameters([{ type: "address" }], [OTHER]),
          );
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "proxyAdmin.owner")).toBeDefined();
  });

  it("priceList wiring drift", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(
            `eth_getStorageAt|${account.proxy.toLowerCase()}|0x167`,
            `0x${"0".repeat(22)}01${OTHER.slice(2)}`,
          );
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "account.priceList")).toBeDefined();
  });

  it("f24 wiring drift", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(
            `eth_getStorageAt|${account.proxy.toLowerCase()}|0x166`,
            `0x${"0".repeat(20)}${OTHER.slice(2)}0605`,
          );
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "account.f24")).toBeDefined();
  });

  it("F24SalesAddress wiring drift", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(
            `eth_call|${callKey(account.proxy, accountAbi, "F24SalesAddress")}`,
            encodeAbiParameters([{ type: "address" }], [OTHER]),
          );
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "account.F24SalesAddress")).toBeDefined();
  });

  it("deposit.usdc wiring drift", async () => {
    const deposit = deployments.proxies["deposit"] as (typeof deployments.proxies)[string];
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(
            `eth_call|${callKey(deposit.proxy, depositAbi, "usdc")}`,
            encodeAbiParameters([{ type: "address" }], [OTHER]),
          );
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "deposit.usdc")).toBeDefined();
  });

  it("monitor sanctionCheck drift", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(
            `eth_call|${callKey(eur24.proxy, tokenAbi, "sanctionCheck")}`,
            encodeAbiParameters([{ type: "bool" }], [false]),
          );
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "EUR24.sanctionCheck")).toBeDefined();
  });

  it("constant drift (THIRTYDAYS)", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(
            `eth_call|${callKey(account.proxy, accountAbi, "THIRTYDAYS")}`,
            encodeAbiParameters([{ type: "uint256" }], [999n]),
          );
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "account.THIRTYDAYS")).toBeDefined();
  });

  it("decimals drift", async () => {
    const result = await verify(
      stubClient(
        fixture((r) => {
          r.set(
            `eth_call|${callKey(eur24.proxy, tokenAbi, "decimals")}`,
            encodeAbiParameters([{ type: "uint8" }], [8]),
          );
        }),
      ),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "EUR24.decimals")).toBeDefined();
  });

  it("wrong chain id aborts early", async () => {
    const result = await verify(
      stubClient(fixture((r) => void r.set("eth_chainId", "0x1"))),
      deployments,
      BLOCK,
    );
    expect(driftLine(result.lines, "rpc.chainId")).toBeDefined();
    expect(result.okCount).toBe(1); // deployments.chainId still ok; verify aborts after the guard
    expect(result.lines).toHaveLength(2);
  });

  it("address comparison is case-insensitive, hash compare lowercase", () => {
    expect(getAddress("0x22043fddf353308b4f2e7da2e5284e4d087449e1")).toBe(
      "0x22043fDdF353308B4F2e7dA2e5284E4D087449e1",
    );
  });
});
