/**
 * Re-reads every value `data/deployments.json` pins (SPEC §4.1) plus the §4.2 chain constants
 * embedded in `packages/fiat24/src`, all at one block, and prints one `ok`/`DRIFT` line each. Exits
 * 1 on any mismatch. RPC: `--rpc` ?? `FIAT24_RPC` ?? the public Tenderly archive gateway.
 *
 * Bun scripts/deployments/verify.ts [--block <decimal>] [--rpc <url>]
 *
 * Slot numbering is little-endian (byte N = Nth byte from the right): account slot 359 bytes 0-19 =
 * priceList proxy, byte 20 = f24IsActive (informational only); account slot 358 bytes 2-21 = the
 * F24 token address (Fiat24Account storage layout).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Abi, Address, Hex, PublicClient } from "viem";
import { createPublicClient, erc20Abi, getAddress, http, keccak256, parseAbi } from "viem";
import { arbitrum } from "viem/chains";

import { accountAbi, depositAbi, f24Abi, tokenAbi } from "../../packages/fiat24/src/abi/index.ts";
import { INTERNAL_ACCOUNTS } from "../../packages/fiat24/src/core/account-id.ts";
import { DECIMALS } from "../../packages/fiat24/src/core/money.ts";

const CHAIN_ID = 42161;
const IMPL_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT: Hex = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const OWNER_ABI = parseAbi(["function owner() view returns (address)"]);

export type PinnedProxy = {
  proxy: string;
  implementation: string;
  codeHash: string;
  admin: string;
};
export type DeploymentsData = {
  chainId: number;
  proxies: Record<string, PinnedProxy>;
  f24: { address: string; codeHash: string };
  proxyAdmin: { address: string; codeHash: string; owner: string };
  usdc: string;
  monitor: {
    depositUsdcDepositAddress: string;
    sanctionCheck: Record<string, boolean>;
    sanctionContract: Record<string, string>;
  };
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function loadDeployments(path: string): DeploymentsData {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) {
    throw new Error(`${path}: not an object`);
  }
  return raw as unknown as DeploymentsData;
}

/** `bytes[from..to]` of a bytes32, little-endian numbering (byte 0 = rightmost). */
function slotBytes(word: Hex, from: number, to: number): Hex {
  const h = word.slice(2);
  return `0x${h.slice(64 - 2 * (to + 1), 64 - 2 * from)}`;
}

const eqAddr = (expected: string, actual: string): boolean =>
  expected.toLowerCase() === actual.toLowerCase();

const showAddr = (actual: string): string => {
  try {
    return getAddress(actual);
  } catch {
    return actual;
  }
};

/** EIP-1967 slot: `ok` only when the 12 high bytes are zero. */
function slotAddress(word: Hex): { address: string; clean: boolean } {
  const h = word.slice(2);
  return { address: `0x${h.slice(24)}`, clean: /^0{24}$/.test(h.slice(0, 24)) };
}

type Check = {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
  info?: boolean;
};

export type VerifyResult = {
  lines: string[];
  okCount: number;
  driftCount: number;
};

export async function verify(
  client: PublicClient,
  deployments: DeploymentsData,
  block: bigint,
): Promise<VerifyResult> {
  const checks: Check[] = [];
  const check = (name: string, expected: string, actual: string, ok: boolean): void => {
    checks.push({ name, expected, actual, ok });
  };
  const info = (name: string, actual: string): void => {
    checks.push({ name, expected: "-", actual, ok: true, info: true });
  };

  const chainId = await client.getChainId();
  check("rpc.chainId", `${CHAIN_ID}`, `${chainId}`, chainId === CHAIN_ID);
  check(
    "deployments.chainId",
    `${CHAIN_ID}`,
    `${deployments.chainId}`,
    deployments.chainId === CHAIN_ID,
  );
  if (chainId !== CHAIN_ID || deployments.chainId !== CHAIN_ID) {
    return format(checks);
  }

  const storage = async (address: string, slot: Hex): Promise<Hex | undefined> => {
    try {
      return await client.getStorageAt({ address: address as Address, slot, blockNumber: block });
    } catch {
      return undefined;
    }
  };
  const code = async (address: string): Promise<Hex | undefined> => {
    try {
      return await client.getCode({ address: address as Address, blockNumber: block });
    } catch {
      return undefined;
    }
  };
  const read = async <T>(
    abi: Abi | ReadonlyArray<unknown>,
    address: string,
    functionName: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<T | undefined> => {
    try {
      return (await client.readContract({
        abi: abi as Abi,
        address: address as Address,
        functionName,
        args,
        blockNumber: block,
      })) as T;
    } catch {
      return undefined;
    }
  };
  const missing = "<error>";

  const hashCheck = async (name: string, address: string, expected: string): Promise<void> => {
    const bytecode = await code(address);
    const actual = bytecode === undefined ? missing : keccak256(bytecode);
    check(name, expected, actual, actual.toLowerCase() === expected.toLowerCase());
  };

  for (const [name, pinned] of Object.entries(deployments.proxies)) {
    const implWord = await storage(pinned.proxy, IMPL_SLOT);
    const impl = implWord === undefined ? undefined : slotAddress(implWord);
    const implActual = impl === undefined ? missing : showAddr(impl.address);
    check(
      `${name}.implementation`,
      pinned.implementation,
      implActual,
      impl !== undefined && impl.clean && eqAddr(pinned.implementation, impl.address),
    );
    const adminWord = await storage(pinned.proxy, ADMIN_SLOT);
    const admin = adminWord === undefined ? undefined : slotAddress(adminWord);
    const adminActual = admin === undefined ? missing : showAddr(admin.address);
    check(
      `${name}.admin`,
      pinned.admin,
      adminActual,
      admin !== undefined && admin.clean && eqAddr(pinned.admin, admin.address),
    );
    await hashCheck(`${name}.codeHash`, pinned.implementation, pinned.codeHash);
  }

  await hashCheck("f24.codeHash", deployments.f24.address, deployments.f24.codeHash);
  await hashCheck(
    "proxyAdmin.codeHash",
    deployments.proxyAdmin.address,
    deployments.proxyAdmin.codeHash,
  );
  const owner = await read<Address>(OWNER_ABI, deployments.proxyAdmin.address, "owner");
  check(
    "proxyAdmin.owner",
    deployments.proxyAdmin.owner,
    owner === undefined ? missing : getAddress(owner),
    owner !== undefined && eqAddr(deployments.proxyAdmin.owner, owner),
  );

  const { account, priceList, deposit, f24Sales } = deployments.proxies;
  if (account === undefined || priceList === undefined || deposit === undefined) {
    throw new Error("deployments.json: missing account/priceList/deposit proxies");
  }

  const s359 = await storage(account.proxy, "0x167");
  const s359pl = s359 === undefined ? undefined : slotBytes(s359, 0, 19);
  check(
    "account.priceList",
    priceList.proxy,
    s359pl === undefined ? missing : showAddr(s359pl),
    s359pl !== undefined && eqAddr(priceList.proxy, s359pl),
  );
  info("account.f24IsActive", s359 === undefined ? missing : slotBytes(s359, 20, 20));
  const s358 = await storage(account.proxy, "0x166");
  const s358f24 = s358 === undefined ? undefined : slotBytes(s358, 2, 21);
  check(
    "account.f24",
    deployments.f24.address,
    s358f24 === undefined ? missing : showAddr(s358f24),
    s358f24 !== undefined && eqAddr(deployments.f24.address, s358f24),
  );
  const sales = await read<Address>(accountAbi, account.proxy, "F24SalesAddress");
  check(
    "account.F24SalesAddress",
    f24Sales?.proxy ?? "",
    sales === undefined ? missing : getAddress(sales),
    sales !== undefined && f24Sales !== undefined && eqAddr(f24Sales.proxy, sales),
  );
  const usdc = await read<Address>(depositAbi, deposit.proxy, "usdc");
  check(
    "deposit.usdc",
    deployments.usdc,
    usdc === undefined ? missing : getAddress(usdc),
    usdc !== undefined && eqAddr(deployments.usdc, usdc),
  );

  const desk = await read<Address>(depositAbi, deposit.proxy, "usdcDepositAddress");
  check(
    "monitor.depositUsdcDepositAddress",
    deployments.monitor.depositUsdcDepositAddress,
    desk === undefined ? missing : getAddress(desk),
    desk !== undefined && eqAddr(deployments.monitor.depositUsdcDepositAddress, desk),
  );
  for (const [token, expectedCheck] of Object.entries(deployments.monitor.sanctionCheck)) {
    const proxy = deployments.proxies[token]?.proxy;
    if (proxy === undefined) {
      check(`${token}.sanctionCheck`, String(expectedCheck), "<no proxy>", false);
      continue;
    }
    const sc = await read<boolean>(tokenAbi, proxy, "sanctionCheck");
    check(
      `${token}.sanctionCheck`,
      String(expectedCheck),
      sc === undefined ? missing : String(sc),
      sc === expectedCheck,
    );
    const expectedContract = deployments.monitor.sanctionContract[token] ?? "";
    const contract = await read<Address>(tokenAbi, proxy, "sanctionContract");
    check(
      `${token}.sanctionContract`,
      expectedContract,
      contract === undefined ? missing : getAddress(contract),
      contract !== undefined && eqAddr(expectedContract, contract),
    );
  }

  for (const token of ["USD24", "EUR24", "CHF24", "CNH24"] as const) {
    const proxy = deployments.proxies[token]?.proxy;
    const d = proxy === undefined ? undefined : await read<number>(tokenAbi, proxy, "decimals");
    check(
      `${token}.decimals`,
      `${DECIMALS[token]}`,
      d === undefined ? missing : String(d),
      d === DECIMALS[token],
    );
  }
  const dF24 = await read<number>(f24Abi, deployments.f24.address, "decimals");
  check(
    "F24.decimals",
    `${DECIMALS["F24"]}`,
    dF24 === undefined ? missing : String(dF24),
    dF24 === DECIMALS["F24"],
  );
  const dUsdc = await read<number>(erc20Abi, deployments.usdc, "decimals");
  check(
    "USDC.decimals",
    `${DECIMALS["USDC"]}`,
    dUsdc === undefined ? missing : String(dUsdc),
    dUsdc === DECIMALS["USDC"],
  );

  const thirtyDays = await read<bigint>(accountAbi, account.proxy, "THIRTYDAYS");
  check(
    "account.THIRTYDAYS",
    "2592000",
    thirtyDays === undefined ? missing : String(thirtyDays),
    thirtyDays === 2592000n,
  );
  const internalDigit = await read<number>(accountAbi, account.proxy, "INTERNALDIGIT");
  check(
    "account.INTERNALDIGIT",
    "9",
    internalDigit === undefined ? missing : String(internalDigit),
    internalDigit === 9,
  );
  const merchantDigit = await read<number>(accountAbi, account.proxy, "MERCHANTDIGIT");
  check(
    "account.MERCHANTDIGIT",
    "8",
    merchantDigit === undefined ? missing : String(merchantDigit),
    merchantDigit === 8,
  );
  const xxx = await read<bigint>(depositAbi, deposit.proxy, "XXX24_DIVISOR");
  check(
    "deposit.XXX24_DIVISOR",
    "10000",
    xxx === undefined ? missing : String(xxx),
    xxx === 10000n,
  );
  const usd = await read<bigint>(depositAbi, deposit.proxy, "USDC_DIVISOR");
  check("deposit.USDC_DIVISOR", "10000", usd === undefined ? missing : String(usd), usd === 10000n);
  const maxDigits = await read<bigint>(depositAbi, deposit.proxy, "MAX_DIGITS");
  check(
    "deposit.MAX_DIGITS",
    "5",
    maxDigits === undefined ? missing : String(maxDigits),
    maxDigits === 5n,
  );

  for (const [name, id] of Object.entries(INTERNAL_ACCOUNTS)) {
    const exists = await read<boolean>(accountAbi, account.proxy, "exists", [id]);
    check(
      `account.exists.${name}`,
      "true",
      exists === undefined ? missing : String(exists),
      exists === true,
    );
  }

  return format(checks);
}

function format(checks: Check[]): VerifyResult {
  const lines: string[] = [];
  let okCount = 0;
  let driftCount = 0;
  for (const c of checks) {
    if (c.info === true) {
      lines.push(`info ${c.name} actual=${c.actual}`);
      continue;
    }
    if (c.ok) {
      okCount += 1;
      lines.push(`ok ${c.name} expected=${c.expected} actual=${c.actual}`);
    } else {
      driftCount += 1;
      lines.push(`DRIFT ${c.name} expected=${c.expected} actual=${c.actual}`);
    }
  }
  return { lines, okCount, driftCount };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const rpc = flag("rpc") ?? process.env["FIAT24_RPC"] ?? "https://arbitrum.gateway.tenderly.co";
  const client = createPublicClient({ chain: arbitrum, transport: http(rpc) });
  const blockArg = flag("block");
  const block = blockArg === undefined ? await client.getBlockNumber() : BigInt(blockArg);
  const deployments = loadDeployments(join(import.meta.dirname, "../../data/deployments.json"));
  const { lines, okCount, driftCount } = await verify(client, deployments, block);
  for (const line of lines) {
    console.log(line);
  }
  // Host only: a keyed RPC URL (FIAT24_RPC secret in drift.yml) must never reach the log.
  console.log(
    `verify: ${okCount} ok, ${driftCount} drift at block ${block} via ${new URL(rpc).host}`,
  );
  if (driftCount > 0) {
    process.exitCode = 1;
  }
}
