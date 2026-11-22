import type { Client } from "viem";

import { accountAbi, f24SalesAbi, priceListAbi } from "../abi/index.ts";
import { mintAccountWithEthCall } from "../calls/account.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { ChainArgs } from "./context.ts";
import {
  asBigint,
  asBoolean,
  asUint8,
  invalidResponse,
  readAt,
  resolveDeployment,
  snapshot,
} from "./context.ts";
import { assertDeployment } from "./deployment.ts";

const WEI_PER_ETHER = 10n ** 18n;

// Standard minting needs the 6-digit sale space open (Fiat24Account.sol:118-120
// refuses above maxDigitForSale anyway; the SDK reports it as unavailable, §8.5).
const MIN_DIGITS_FOR_STANDARD_MINT = 6;

/**
 * SPEC §8.3, Fiat24Account.sol:102-107 — `quote < price ? (price / quote) * 10^18 : 10^18 / (quote
 * / price)`. Both inputs are F24-side amounts (price in F24 units, quotePerEther F24 per ETH) and
 * must be >= 1.
 */
export function mintPriceWei(args: { priceF24: bigint; quotePerEther: bigint }): bigint {
  const price = args.priceF24;
  const quote = args.quotePerEther;
  if (typeof price !== "bigint" || price < 1n || typeof quote !== "bigint" || quote < 1n) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  return quote < price ? (price / quote) * WEI_PER_ETHER : WEI_PER_ETHER / (quote / price);
}

/** SPEC §3.6. */
export type MintQuote = {
  readonly tokenId: bigint;
  readonly taken: boolean;
  readonly priceF24: bigint;
  readonly priceWei: bigint;
  readonly blockNumber: bigint;
};

/**
 * SPEC §8.2: refuses non-standard ids before any I/O (§5.2), then drift-verifies the mint path
 * (`mintAccountWithEthCall.contracts` — value is irrelevant to the path) and reads `exists`,
 * `priceList.getPrice`, `f24Sales.quotePerEther` and `maxDigitForSale` in one round at B.
 * `maxDigitForSale < 6` ⇒ `unavailable` `{contract: "account", reason: "mint-digits"}` (§8.5); a
 * zero price or quote is an RPC lie (priceList never prices standard ids at 0,
 * Fiat24PriceList.sol:20-41).
 */
export async function getMintQuote(
  client: Client,
  args: ChainArgs & { tokenId: bigint },
): Promise<MintQuote> {
  const deployment = resolveDeployment(client, args.deployment);
  const { tokenId } = args;
  // The builder's checkedMintId is the §8.2 `!isStandardMintId ⇒ invalid-account-id` refusal, before any I/O.
  const call = mintAccountWithEthCall({ tokenId, value: 1n, deployment });
  const { blockNumber: B } = await snapshot(client, args);
  await assertDeployment(client, {
    contracts: call.contracts,
    deployment,
    blockNumber: B,
  });

  const [exists, price, quote, maxDigitForSale] = await Promise.all([
    readAt(client, B, {
      address: deployment.account.proxy,
      abi: accountAbi,
      functionName: "exists",
      args: [tokenId],
    }),
    readAt(client, B, {
      address: deployment.priceList.proxy,
      abi: priceListAbi,
      functionName: "getPrice",
      args: [tokenId],
    }),
    readAt(client, B, {
      address: deployment.f24Sales.proxy,
      abi: f24SalesAbi,
      functionName: "quotePerEther",
    }),
    readAt(client, B, {
      address: deployment.account.proxy,
      abi: accountAbi,
      functionName: "maxDigitForSale",
    }),
  ]);

  if (asUint8(maxDigitForSale) < MIN_DIGITS_FOR_STANDARD_MINT) {
    throw new Fiat24Error("unavailable", "account mint unavailable", {
      contract: "account",
      reason: "mint-digits",
    });
  }
  const priceF24 = asBigint(price);
  const quotePerEther = asBigint(quote);
  if (priceF24 === 0n || quotePerEther === 0n) {
    invalidResponse();
  }
  return {
    tokenId,
    taken: asBoolean(exists),
    priceF24,
    priceWei: mintPriceWei({ priceF24, quotePerEther }),
    blockNumber: B,
  };
}
