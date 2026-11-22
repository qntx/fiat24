import { erc20Abi, getAddress, isAddress } from "viem";
import type { Abi, Address, Client } from "viem";

import { f24Abi, tokenAbi } from "../abi/index.ts";
import { checkedAsset } from "../calls/types.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { ApprovalSpender, Asset, Currency } from "../core/types.ts";
import { CURRENCIES } from "../core/types.ts";
import type { Deployment } from "../deployments/deployment.ts";
import type { ChainArgs } from "./context.ts";
import { readAt, snapshot } from "./context.ts";

type AnyClient = Client;

const invalidResponse = (): never => {
  throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
};

function asBigint(value: unknown): bigint {
  return typeof value === "bigint" ? value : invalidResponse();
}

function checkedOwner(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Fiat24Error("invalid-address", "invalid address");
  }
  return getAddress(value);
}

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
  client: AnyClient,
  args: ChainArgs & { owner: Address },
): Promise<{
  readonly balances: Readonly<Record<Currency, bigint>>;
  readonly blockNumber: bigint;
}> {
  const { deployment, blockNumber: B } = await snapshot(client, args);
  const owner = checkedOwner(args.owner);
  const [usd24, eur24, chf24, cnh24] = await Promise.all(
    CURRENCIES.map(async (currency) =>
      readAt(client, B, {
        address: deployment.tokens[currency].proxy,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [owner],
      }),
    ),
  );
  const balances = {
    USD24: asBigint(usd24),
    EUR24: asBigint(eur24),
    CHF24: asBigint(chf24),
    CNH24: asBigint(cnh24),
  };
  return { balances, blockNumber: B };
}

/** `allowance(O, spender)` on the asset contract for one allowed pair (SPEC §8.2). */
export async function getAllowance(
  client: AnyClient,
  args: ChainArgs & { owner: Address; asset: Asset; spender: ApprovalSpender },
): Promise<bigint> {
  const { deployment, blockNumber: B } = await snapshot(client, args);
  const owner = checkedOwner(args.owner);
  const asset = checkedAsset(args.asset);
  const { spender } = args;
  if (typeof spender !== "string" || !SPENDERS.has(spender)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const target = allowanceTarget(deployment, asset, spender);
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
  client: AnyClient,
  args: ChainArgs & { owner: Address },
): Promise<Allowances> {
  const { deployment, blockNumber: B } = await snapshot(client, args);
  const owner = checkedOwner(args.owner);

  type Job = { address: Address; abi: Abi; spender: Address };
  const cardJobs = CURRENCIES.map((currency): Job => ({
    address: deployment.tokens[currency].proxy,
    abi: tokenAbi,
    spender: deployment.card.proxy,
  }));
  const depositJobs = CURRENCIES.map((currency): Job => ({
    address: deployment.tokens[currency].proxy,
    abi: tokenAbi,
    spender: deployment.deposit.proxy,
  }));
  const usdcJob: Job = {
    address: deployment.usdc,
    abi: erc20Abi,
    spender: deployment.deposit.proxy,
  };
  const f24Job: Job = {
    address: deployment.f24.address,
    abi: f24Abi,
    spender: deployment.account.proxy,
  };

  const results = await Promise.all(
    [...cardJobs, ...depositJobs, usdcJob, f24Job].map(async (job) =>
      readAt(client, B, {
        address: job.address,
        abi: job.abi,
        functionName: "allowance",
        args: [owner, job.spender],
      }),
    ),
  );

  const [cu, ce, cc, cn, du, de, dc, dn, usdc, f24] = results;
  return {
    card: {
      USD24: asBigint(cu),
      EUR24: asBigint(ce),
      CHF24: asBigint(cc),
      CNH24: asBigint(cn),
    },
    deposit: {
      USD24: asBigint(du),
      EUR24: asBigint(de),
      CHF24: asBigint(dc),
      CNH24: asBigint(dn),
      USDC: asBigint(usdc),
    },
    account: { F24: asBigint(f24) },
    blockNumber: B,
  };
}
