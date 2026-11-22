import type { Address, Client } from "viem";
import { getAddress, isAddress } from "viem";

import { accountAbi, depositAbi } from "../abi/index.ts";
import { topUpCall } from "../calls/topup.ts";
import { checkedAmount, checkedCurrency } from "../calls/types.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { Currency } from "../core/types.ts";
import type { ChainArgs } from "./context.ts";
import { readAt, snapshot } from "./context.ts";
import { assertDeployment } from "./deployment.ts";

type AnyClient = Client;

const invalidResponse = (): never => {
  throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
};

function asBigint(value: unknown): bigint {
  return typeof value === "bigint" ? value : invalidResponse();
}

function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalidResponse();
}

const SIDES: ReadonlySet<string> = new Set(["exact-in", "exact-out"]);

// XXX24_DIVISOR = USDC_DIVISOR = 10000 (Fiat24CryptoDeposit.sol:43-44).
const DIVISOR = 10_000n;

function checkedBigint(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  return value;
}

/**
 * SPEC §8.3, Fiat24CryptoDeposit.sol:376,393 — `amount * rate / 10000 * spread / 10000`, strictly
 * left to right with floor division. Which side `amount` is (input vs output) is the caller's
 * business: exact-in computes output, exact-out computes input.
 */
export function quoteExchange(args: {
  side: "exact-in" | "exact-out";
  amount: bigint;
  rate: bigint;
  spread: bigint;
}): bigint {
  if (typeof args.side !== "string" || !SIDES.has(args.side)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const amount = checkedBigint(args.amount);
  const rate = checkedBigint(args.rate);
  const spread = checkedBigint(args.spread);
  return (((amount * rate) / DIVISOR) * spread) / DIVISOR;
}

/** SPEC §3.6. */
export type ExchangeQuote = {
  readonly side: "exact-in" | "exact-out";
  readonly from: Currency;
  readonly to: Currency;
  readonly input: bigint;
  readonly output: bigint;
  readonly rate: bigint;
  readonly spread: bigint;
  readonly marketClosed: boolean;
  readonly blockNumber: bigint;
};

/**
 * SPEC §8.2: exact-in reads `getExchangeRate(from,to)` + `getSpread(from,to,false)`; exact-out
 * reads `getExchangeRate(to,from)` + `getSpread(to,from,true)` (§8.3 — the contract computes the
 * required input from the reverse rate). Plus `marketClosed()`, all in one round at B. A zero
 * result means the contract would take the input for nothing (or revert ValueZero) ⇒
 * `below-minimum`.
 */
export async function getExchangeQuote(
  client: AnyClient,
  args: ChainArgs & {
    side: "exact-in" | "exact-out";
    from: Currency;
    to: Currency;
    amount: bigint;
  },
): Promise<ExchangeQuote> {
  const { deployment, blockNumber: B } = await snapshot(client, args);
  const { side } = args;
  if (typeof side !== "string" || !SIDES.has(side)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const from = checkedCurrency(args.from);
  const to = checkedCurrency(args.to);
  if (from === to) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  checkedAmount(args.amount);
  const { amount } = args;

  const deposit = deployment.deposit.proxy;
  const fromToken = deployment.tokens[from].proxy;
  const toToken = deployment.tokens[to].proxy;
  // Exact-out reads the reverse pair (§8.3).
  const rateToken = side === "exact-in" ? fromToken : toToken;
  const spreadToken = side === "exact-in" ? toToken : fromToken;
  const exactOut = side === "exact-out";

  const [rate, spread, marketClosed] = await Promise.all([
    readAt(client, B, {
      address: deposit,
      abi: depositAbi,
      functionName: "getExchangeRate",
      args: [rateToken, spreadToken],
    }),
    readAt(client, B, {
      address: deposit,
      abi: depositAbi,
      functionName: "getSpread",
      args: [rateToken, spreadToken, exactOut],
    }),
    readAt(client, B, {
      address: deposit,
      abi: depositAbi,
      functionName: "marketClosed",
    }),
  ]);
  const result = quoteExchange({
    side,
    amount,
    rate: asBigint(rate),
    spread: asBigint(spread),
  });
  if (result === 0n) {
    throw new Fiat24Error("below-minimum", "below minimum");
  }
  return {
    side,
    from,
    to,
    input: exactOut ? result : amount,
    output: exactOut ? amount : result,
    rate: asBigint(rate),
    spread: asBigint(spread),
    marketClosed: asBoolean(marketClosed),
    blockNumber: B,
  };
}

/**
 * SPEC §8.3, Fiat24CryptoDeposit.sol:250,259-260 — the fee leg is skimmed off in USDC, converted at
 * `exchangeRates(USDC, USD24)`, then the USD24 leg exchanges like quoteExchange. All inputs bigint >=
 * 0 and `fee <= usdcAmount`.
 */
export function quoteTopUp(args: {
  usdcAmount: bigint;
  fee: bigint;
  usdcRate: bigint;
  rate: bigint;
  spread: bigint;
}): bigint {
  const usdcAmount = checkedBigint(args.usdcAmount);
  const fee = checkedBigint(args.fee);
  const usdcRate = checkedBigint(args.usdcRate);
  const rate = checkedBigint(args.rate);
  const spread = checkedBigint(args.spread);
  if (fee > usdcAmount) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const o = (((usdcAmount - fee) / DIVISOR) * usdcRate) / DIVISOR;
  return (((o * rate) / DIVISOR) * spread) / DIVISOR;
}

/** SPEC §3.6. */
export type TopUpQuote = {
  readonly output: Currency;
  readonly usdcAmount: bigint;
  readonly fee: bigint;
  readonly outputAmount: bigint;
  readonly min: bigint;
  readonly max: bigint;
  readonly paused: boolean;
  readonly blockNumber: bigint;
};

/**
 * SPEC §8.2: the deposit path is drift-verified first (I5 — topUpCall.contracts), then one round at
 * B: paused, min/max deposit bounds, historicOwnership(O), the USDC→USD24 rate and the USD24→output
 * rate/spread. Checks in order: no account ⇒ `no-account`, amount < min ⇒ `below-minimum`, > max ⇒
 * `above-maximum`; `getFee` is read afterwards (needs the resolved tokenId) and a fee above the
 * input is an RPC lie. `paused` is returned as data, never thrown.
 */
export async function getTopUpQuote(
  client: AnyClient,
  args: ChainArgs & { owner: Address; output: Currency; usdcAmount: bigint },
): Promise<TopUpQuote> {
  const { deployment, blockNumber: B } = await snapshot(client, args);
  const ownerRaw = args.owner;
  if (typeof ownerRaw !== "string" || !isAddress(ownerRaw, { strict: false })) {
    throw new Fiat24Error("invalid-address", "invalid address");
  }
  const owner = getAddress(ownerRaw);
  const output = checkedCurrency(args.output);
  const call = topUpCall({
    output,
    usdcAmount: args.usdcAmount,
    deployment,
  });
  await assertDeployment(client, {
    contracts: call.contracts,
    deployment,
    blockNumber: B,
  });

  const deposit = deployment.deposit.proxy;
  const outToken = deployment.tokens[output].proxy;
  const [paused, min, max, historic, usdcRate, rate, spread] = await Promise.all([
    readAt(client, B, { address: deposit, abi: depositAbi, functionName: "paused" }),
    readAt(client, B, {
      address: deposit,
      abi: depositAbi,
      functionName: "minUsdcDepositAmount",
    }),
    readAt(client, B, {
      address: deposit,
      abi: depositAbi,
      functionName: "maxUsdcDepositAmount",
    }),
    readAt(client, B, {
      address: deployment.account.proxy,
      abi: accountAbi,
      functionName: "historicOwnership",
      args: [owner],
    }),
    readAt(client, B, {
      address: deposit,
      abi: depositAbi,
      functionName: "exchangeRates",
      args: [deployment.usdc, deployment.tokens.USD24.proxy],
    }),
    readAt(client, B, {
      address: deposit,
      abi: depositAbi,
      functionName: "getExchangeRate",
      args: [deployment.tokens.USD24.proxy, outToken],
    }),
    readAt(client, B, {
      address: deposit,
      abi: depositAbi,
      functionName: "getSpread",
      args: [deployment.tokens.USD24.proxy, outToken, false],
    }),
  ]);

  const tokenId = asBigint(historic);
  if (tokenId === 0n) {
    throw new Fiat24Error("no-account", "no account");
  }
  const minB = asBigint(min);
  const maxB = asBigint(max);
  if (args.usdcAmount < minB) {
    throw new Fiat24Error("below-minimum", "below minimum");
  }
  if (args.usdcAmount > maxB) {
    throw new Fiat24Error("above-maximum", "above maximum");
  }
  const fee = asBigint(
    await readAt(client, B, {
      address: deposit,
      abi: depositAbi,
      functionName: "getFee",
      args: [tokenId, args.usdcAmount],
    }),
  );
  if (fee > args.usdcAmount) {
    invalidResponse();
  }
  const outputAmount = quoteTopUp({
    usdcAmount: args.usdcAmount,
    fee,
    usdcRate: asBigint(usdcRate),
    rate: asBigint(rate),
    spread: asBigint(spread),
  });
  return {
    output,
    usdcAmount: args.usdcAmount,
    fee,
    outputAmount,
    min: minB,
    max: maxB,
    paused: asBoolean(paused),
    blockNumber: B,
  };
}
