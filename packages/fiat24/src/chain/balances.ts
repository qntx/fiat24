import { erc20Abi } from "viem";
import type { Abi, Address, Client } from "viem";

import { f24Abi, tokenAbi } from "../abi/index.ts";
import { checkedAsset } from "../calls/types.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { ApprovalSpender, Asset, Currency } from "../core/types.ts";
import { CURRENCIES } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import type { ChainArgs } from "./context.ts";
import { asBigint, checkedAddress, readAt, resolveDeployment, snapshot } from "./context.ts";

const SPENDERS: ReadonlySet<string> = new Set(["card", "deposit", "account"]);
const CASH: ReadonlySet<string> = new Set(CURRENCIES);

function spenderProxy(deployment: Deployment, spender: ApprovalSpender): Address {
  return spender === "card"
    ? deployment.card.proxy
    : spender === "deposit"
      ? deployment.deposit.proxy
      : deployment.account.proxy;
}

// The §6.1 approve pairs: which (asset, spender) combos exist and where the
// allowance lives (token proxy / usdc / f24 with its own ABI).
function allowanceTarget(
  deployment: Deployment,
  asset: Asset,
  spender: ApprovalSpender,
): { address: Address; abi: Abi } {
  const isCash = CASH.has(asset);
  const allowed =
    (isCash && (spender === "card" || spender === "deposit")) ||
    (asset === "USDC" && spender === "deposit") ||
    (asset === "F24" && spender === "account");
  if (!allowed) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  if (asset === "USDC") {
    return { address: deployment.usdc, abi: erc20Abi };
  }
  if (asset === "F24") {
    return { address: deployment.f24.address, abi: f24Abi };
  }
  return { address: deployment.tokens[asset].proxy, abi: tokenAbi };
}

/** `balanceOf(O)` on the four cash tokens, one round at B (SPEC §8.2). */
export async function getBalances(
  client: Client,
  args: ChainArgs & { owner: Address },
): Promise<{
  readonly balances: Readonly<Record<Currency, bigint>>;
  readonly blockNumber: bigint;
}> {
  resolveDeployment(client, args.deployment);
  const owner = checkedAddress(args.owner);
  const { deployment, blockNumber: B } = await snapshot(client, args);
  // Each balance is stored under its own currency key: result assembly never
  // depends on the CURRENCIES table's order (R-06).
  const balances: Record<Currency, bigint> = { USD24: 0n, EUR24: 0n, CHF24: 0n, CNH24: 0n };
  await Promise.all(
    CURRENCIES.map(async (currency) => {
      balances[currency] = asBigint(
        await readAt(client, B, {
          address: deployment.tokens[currency].proxy,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [owner],
        }),
      );
    }),
  );
  return { balances, blockNumber: B };
}

/** `allowance(O, spender)` on the asset contract for one allowed pair (SPEC §8.2). */
export async function getAllowance(
  client: Client,
  args: ChainArgs & { owner: Address; asset: Asset; spender: ApprovalSpender },
): Promise<bigint> {
  const deployment = resolveDeployment(client, args.deployment);
  const owner = checkedAddress(args.owner);
  const asset = checkedAsset(args.asset);
  const { spender } = args;
  if (typeof spender !== "string" || !SPENDERS.has(spender)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const target = allowanceTarget(deployment, asset, spender);
  const { blockNumber: B } = await snapshot(client, args);
  return asBigint(
    await readAt(client, B, {
      address: target.address,
      abi: target.abi,
      functionName: "allowance",
      args: [owner, spenderProxy(deployment, spender)],
    }),
  );
}

/** SPEC §3.6 — every §6.1 approve pair: cash×card, cash×deposit, USDC×deposit, F24×account. */
export type Allowances = {
  readonly card: Readonly<Record<Currency, bigint>>;
  readonly deposit: Readonly<Record<Currency | "USDC", bigint>>;
  readonly account: { readonly F24: bigint };
  readonly blockNumber: bigint;
};

/** All ten allowance pairs in one round (SPEC §8.2). */
export async function getAllowances(
  client: Client,
  args: ChainArgs & { owner: Address },
): Promise<Allowances> {
  resolveDeployment(client, args.deployment);
  const owner = checkedAddress(args.owner);
  const { deployment, blockNumber: B } = await snapshot(client, args);

  // Each allowance is stored under its own key: result assembly never depends
  // on job order (R-06).
  const card: Record<Currency, bigint> = { USD24: 0n, EUR24: 0n, CHF24: 0n, CNH24: 0n };
  const deposit: Record<Currency | "USDC", bigint> = {
    USD24: 0n,
    EUR24: 0n,
    CHF24: 0n,
    CNH24: 0n,
    USDC: 0n,
  };
  const account: { F24: bigint } = { F24: 0n };

  type Job = {
    readonly into: Record<string, bigint>;
    readonly key: string;
    readonly address: Address;
    readonly abi: Abi;
    readonly spender: Address;
  };
  const cardJobs = CURRENCIES.map((currency): Job => ({
    into: card,
    key: currency,
    address: deployment.tokens[currency].proxy,
    abi: tokenAbi,
    spender: deployment.card.proxy,
  }));
  const depositJobs = CURRENCIES.map((currency): Job => ({
    into: deposit,
    key: currency,
    address: deployment.tokens[currency].proxy,
    abi: tokenAbi,
    spender: deployment.deposit.proxy,
  }));
  const usdcJob: Job = {
    into: deposit,
    key: "USDC",
    address: deployment.usdc,
    abi: erc20Abi,
    spender: deployment.deposit.proxy,
  };
  const f24Job: Job = {
    into: account,
    key: "F24",
    address: deployment.f24.address,
    abi: f24Abi,
    spender: deployment.account.proxy,
  };

  await Promise.all(
    [...cardJobs, ...depositJobs, usdcJob, f24Job].map(async (job) => {
      job.into[job.key] = asBigint(
        await readAt(client, B, {
          address: job.address,
          abi: job.abi,
          functionName: "allowance",
          args: [owner, job.spender],
        }),
      );
    }),
  );
  return { card, deposit, account, blockNumber: B };
}
