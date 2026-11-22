import { decodeAbiParameters, encodeFunctionData, toHex } from "viem";
import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { accountAbi, tokenAbi } from "../../src/abi/index.ts";
import { approveCall, mintAccountWithEthCall } from "../../src/calls/index.ts";
import {
  getAccount,
  getAllowance,
  getAllowances,
  getBalances,
  getExchangeQuote,
  getMintQuote,
  getPayoutMinimum,
  getTopUpQuote,
  simulateCall,
  verifyDeployment,
} from "../../src/chain/index.ts";
import type { Fiat24Account } from "../../src/chain/index.ts";
import type { Currency } from "../../src/core/index.ts";
import { CURRENCIES, Fiat24Error } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { required } from "../helpers.ts";
import {
  FORK_BLOCK,
  FORK_ENABLED,
  LIVE_1,
  LIVE_2,
  OPERATOR,
  castCall,
  castStorage,
  castTimestamp,
  expectSuccess,
  fund,
  mintUsdc,
  ownerOf,
  sendOk,
  setClientLimit,
  startFork,
  unpause,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

const PIN = FORK_BLOCK.toString();
const ACCOUNT = arbitrum.account.proxy;
const DEPOSIT = arbitrum.deposit.proxy;
const DEPOSIT_ALLOWANCE = 999_999_999_999_999_999n; // record-quote.sh setup.depositAllowance
const FRESH: Address = "0x10000000000000000000000000000000000000e7";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
// `cast sig 'Fiat24CryptoDeposit__ValueZero()'` — verified against the deposit ABI.
const VALUE_ZERO = "0x02aeee40";
// Fiat24AccountStatus ordinals (status(uint256)).
const STATUS_LABELS = ["na", "soft-blocked", "tourist", "blocked", "closed", "live"] as const;

/** Cast 1.10 decorates numbers as `98692 [9.869e4]` — strip every `[...]` note. */
function stripAnnotation(text: string): string {
  return text.replaceAll(/\[[^\]]*\]/g, "").trim();
}

/** A cast uint256/uintN reply → bigint. */
function castUint(text: string): bigint {
  return BigInt(stripAnnotation(text));
}

function tuple3(text: string): readonly [bigint, bigint, bigint] {
  const parts = (stripAnnotation(text).match(/\d+/g) ?? []).map(BigInt);
  if (parts.length !== 3) {
    throw new Error(`cast tuple ${text}`);
  }
  return [required(parts[0]), required(parts[1]), required(parts[2])];
}

const BLOCK_TAGS = new Set(["earliest", "latest", "pending", "safe", "finalized"]);

/** `eth_call` wants hex block numbers or a named tag; cast accepts decimal — callers pass PIN. */
function ethBlock(block: string): string {
  return BLOCK_TAGS.has(block) ? block : toHex(BigInt(block));
}

/** Raw `eth_call` JSON-RPC against the fork — returns result hex or the revert payload. */
async function ethCallRaw(
  fork: Fork,
  tx: { from?: Address; to: Address; data: Hex; value?: bigint },
  block: string,
): Promise<{ result: Hex } | { revert: Hex }> {
  const res = await fetch(fork.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          ...(tx.from === undefined ? {} : { from: tx.from }),
          to: tx.to,
          data: tx.data,
          ...(tx.value === undefined || tx.value === 0n ? {} : { value: toHex(tx.value) }),
          gasPrice: "0x0",
        },
        ethBlock(block),
      ],
    }),
  });
  const body: unknown = await res.json();
  if (typeof body === "object" && body !== null) {
    if ("result" in body && typeof body["result"] === "string") {
      return { result: body["result"] as Hex };
    }
    if ("error" in body && typeof body["error"] === "object" && body["error"] !== null) {
      const error = body["error"] as Record<string, unknown>;
      if (typeof error["data"] === "string") {
        return { revert: error["data"] as Hex };
      }
    }
  }
  throw new Error(`bad eth_call response ${JSON.stringify(body)}`);
}

function uint256Call(
  name: string,
  argTypes: ReadonlyArray<string>,
): (...args: ReadonlyArray<Address | bigint | boolean>) => Hex {
  return (...args) =>
    encodeFunctionData({
      abi: [
        {
          type: "function",
          name,
          inputs: argTypes.map((type) => ({ type })),
          outputs: [{ type: "uint256" }],
          stateMutability: "view",
        },
      ],
      functionName: name,
      args,
    });
}

/** `eth_call` expected to return a uint256 — throws when it reverts instead. */
async function oracleUint(
  fork: Fork,
  tx: { from?: Address; to: Address; data: Hex; value?: bigint },
  block: string,
): Promise<bigint> {
  const out = await ethCallRaw(fork, tx, block);
  if ("result" in out) {
    return BigInt(out.result);
  }
  throw new Error(`oracle eth_call reverted ${out.revert}`);
}

/** The Fiat24Error code the promise rejects with, "non-fiat24" for other throws. */
async function errorCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Fiat24Error ? error.code : "non-fiat24";
  }
}

/** Low 20 bytes of the storage word, lowercased. */
async function low20(fork: Fork, address: Address, slot: string): Promise<string> {
  const word = await castStorage(fork, address, slot, PIN);
  return word.slice(-40).toLowerCase();
}

// ——— getAccount oracle ———

function statusLabel(index: string): string {
  return STATUS_LABELS[Number(index)] ?? `index-${index}`;
}

/** A finished 30-day period zeroes `used` (Fiat24Account.sol:304,306). */
function expectedUsed(periodEnd: bigint, timestamp: bigint, raw: bigint): bigint {
  return periodEnd < timestamp ? 0n : raw;
}

type AccountOracle = {
  readonly owner: string;
  readonly status: string;
  readonly max: bigint;
  readonly start: bigint;
  readonly end: bigint;
  readonly used: bigint;
  readonly walletProvider: bigint;
};

async function accountOracle(fork: Fork, id: bigint): Promise<AccountOracle> {
  const [owner, status, limitRaw, walletProvider, timestamp] = await Promise.all([
    castCall(fork, [ACCOUNT, "ownerOf(uint256)(address)", String(id)], PIN),
    castCall(fork, [ACCOUNT, "status(uint256)(uint8)", String(id)], PIN),
    castCall(fork, [ACCOUNT, "limit(uint256)(uint256,uint256,uint256)", String(id)], PIN),
    castCall(fork, [ACCOUNT, "walletProvider(uint256)(uint256)", String(id)], PIN),
    castTimestamp(fork, PIN),
  ]);
  const [usedRaw, max, start] = tuple3(limitRaw);
  const end = start + 2_592_000n;
  return {
    owner: owner.toLowerCase(),
    status: statusLabel(stripAnnotation(status)),
    max,
    start,
    end,
    used: expectedUsed(end, timestamp, usedRaw),
    walletProvider: castUint(walletProvider),
  };
}

function accountShape(a: Fiat24Account | undefined): AccountOracle & { iban: boolean } {
  return a === undefined
    ? {
        owner: "undefined",
        status: "undefined",
        max: 0n,
        start: 0n,
        end: 0n,
        used: 0n,
        walletProvider: 0n,
        iban: false,
      }
    : {
        owner: a.owner.toLowerCase(),
        status: a.status,
        max: a.limit.max,
        start: a.limit.periodStart,
        end: a.limit.periodEnd,
        used: a.limit.used,
        walletProvider: a.walletProvider,
        iban: a.iban !== undefined,
      };
}

// ——— fx differential oracles ———

type Diff = {
  readonly side: "exact-in" | "exact-out";
  readonly from: Currency;
  readonly to: Currency;
  readonly amount: bigint;
};

function fxDiffs(balance: (currency: Currency) => bigint): Diff[] {
  const out: Diff[] = [];
  for (const from of CURRENCIES) {
    for (const to of CURRENCIES) {
      if (from === to) {
        continue;
      }
      for (const side of ["exact-in", "exact-out"] as const) {
        for (const amount of [1n, 99n, 1000n, 123_456n, balance(from)]) {
          out.push({ side, from, to, amount });
        }
      }
    }
  }
  return out;
}

type Quoted = { readonly output: bigint; readonly input: bigint } | string;

async function quoted(fork: Fork, d: Diff): Promise<Quoted> {
  try {
    const q = await getExchangeQuote(fork.publicClient, {
      side: d.side,
      from: d.from,
      to: d.to,
      amount: d.amount,
    });
    return { output: q.output, input: q.input };
  } catch (error) {
    if (error instanceof Fiat24Error) {
      return error.code;
    }
    throw error;
  }
}

/** Canonical outcome for the SDK side — exact-out inputs above the funded balance are "stf". */
function sdkOutcome(sdk: Quoted, d: Diff, fromBalance: bigint): string {
  if (sdk === "below-minimum") {
    return "below-minimum";
  }
  if (typeof sdk === "string") {
    return `sdk-error:${sdk}`;
  }
  const value = d.side === "exact-in" ? sdk.output : sdk.input;
  if (d.side === "exact-out" && value > fromBalance) {
    return "stf";
  }
  return `out:${value}`;
}

/** The reason of an `Error(string)` payload; the raw hex when it is anything else. */
function revertReason(data: Hex): string {
  if (!data.startsWith("0x08c379a0")) {
    return data;
  }
  try {
    const [reason] = decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}`);
    return reason;
  } catch {
    return data;
  }
}

/**
 * Canonical outcome for the contract side — 0 / ValueZero revert mean below-minimum; only a revert
 * that decodes to exactly `STF` is a leg failure, anything else must not pass.
 */
function oracleOutcome(out: { result: Hex } | { revert: Hex }): string {
  if ("result" in out) {
    const value = BigInt(out.result);
    return value === 0n ? "below-minimum" : `out:${value}`;
  }
  if (out.revert.startsWith(VALUE_ZERO)) {
    return "below-minimum";
  }
  const reason = revertReason(out.revert);
  return reason === "STF" ? "stf" : `revert:${reason}`;
}

/** One differential case: SDK quote vs raw eth_call of the same exchange. */
async function fxCase(
  fork: Fork,
  sender: Address,
  d: Diff,
  fromBalance: bigint,
): Promise<{ sdk: string; oracle: string }> {
  const fn = uint256Call(d.side === "exact-in" ? "moneyExchangeExactIn" : "moneyExchangeExactOut", [
    "address",
    "address",
    "uint256",
  ]);
  const [sdk, oracle] = await Promise.all([
    quoted(fork, d),
    ethCallRaw(
      fork,
      {
        from: sender,
        to: DEPOSIT,
        data: fn(arbitrum.tokens[d.from].proxy, arbitrum.tokens[d.to].proxy, d.amount),
      },
      "latest",
    ),
  ]);
  return { sdk: sdkOutcome(sdk, d, fromBalance), oracle: oracleOutcome(oracle) };
}

/** The desk among ownerOf(9100..9105) holding the most of `token` (record-quote.sh). */
async function richestDesk(fork: Fork, token: Address): Promise<Address> {
  const desks = await Promise.all(
    [9100n, 9101n, 9102n, 9103n, 9104n, 9105n].map(async (id) => ownerOf(fork, id)),
  );
  const balances = await Promise.all(
    desks.map(async (owner) =>
      fork.publicClient.readContract({
        address: token,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [owner],
      }),
    ),
  );
  let best = required(desks[0]);
  let bestBalance = -1n;
  for (const [i, owner] of desks.entries()) {
    const balance = required(balances[i]);
    if (balance > bestBalance) {
      best = owner;
      bestBalance = balance;
    }
  }
  return best;
}

const FUND = 10_000_000n;

describe.skipIf(!FORK_ENABLED)("fork: reads", () => {
  let fork: Fork;
  let snapshot: Hex;
  let owner1: Address;

  beforeAll(async () => {
    fork = await startFork();
    owner1 = await ownerOf(fork, LIVE_1);
  }, 120_000);

  beforeEach(async () => {
    snapshot = await fork.testClient.snapshot();
  });

  afterEach(async () => {
    await fork.testClient.revert({ id: snapshot });
  });

  afterAll(() => {
    fork.stop();
  });

  test.each([[LIVE_1], [LIVE_2]])("getAccount %s matches cast", async (id) => {
    const owner = await ownerOf(fork, id);
    const [byId, byOwner, oracle] = await Promise.all([
      getAccount(fork.publicClient, { tokenId: id, blockNumber: FORK_BLOCK }),
      getAccount(fork.publicClient, { owner, blockNumber: FORK_BLOCK }),
      accountOracle(fork, id),
    ]);
    const expected = { ...oracle, iban: true };
    expect(accountShape(byId)).toStrictEqual(expected);
    expect(accountShape(byOwner)).toStrictEqual(expected);
    expect(required(byId).tokenId).toBe(id);
    expect(required(byOwner).tokenId).toBe(id);
  });

  test("getAccount resolves nothing for a fresh address and a nonexistent id", async () => {
    const [fresh, ghost, exists] = await Promise.all([
      getAccount(fork.publicClient, { owner: FRESH, blockNumber: FORK_BLOCK }),
      getAccount(fork.publicClient, { tokenId: 900_000n, blockNumber: FORK_BLOCK }),
      castCall(fork, [ACCOUNT, "exists(uint256)(bool)", "900000"], PIN),
    ]);
    expect(fresh).toBeUndefined();
    expect(ghost).toBeUndefined();
    expect(exists).toBe("false");
  });

  test("getBalances matches cast balanceOf for every currency", async () => {
    const [{ balances }, castBalances] = await Promise.all([
      getBalances(fork.publicClient, { owner: owner1, blockNumber: FORK_BLOCK }),
      Promise.all(
        CURRENCIES.map(async (currency) =>
          castUint(
            await castCall(
              fork,
              [arbitrum.tokens[currency].proxy, "balanceOf(address)(uint256)", owner1],
              PIN,
            ),
          ),
        ),
      ),
    ]);
    expect(CURRENCIES.map((currency) => balances[currency])).toStrictEqual(castBalances);
  });

  test("getAllowances matches cast allowance for every pair", async () => {
    const [allowances, card, deposit, usdcDeposit, f24Account] = await Promise.all([
      getAllowances(fork.publicClient, { owner: owner1, blockNumber: FORK_BLOCK }),
      Promise.all(
        CURRENCIES.map(async (currency) =>
          castUint(
            await castCall(
              fork,
              [
                arbitrum.tokens[currency].proxy,
                "allowance(address,address)(uint256)",
                owner1,
                arbitrum.card.proxy,
              ],
              PIN,
            ),
          ),
        ),
      ),
      Promise.all(
        CURRENCIES.map(async (currency) =>
          castUint(
            await castCall(
              fork,
              [
                arbitrum.tokens[currency].proxy,
                "allowance(address,address)(uint256)",
                owner1,
                arbitrum.deposit.proxy,
              ],
              PIN,
            ),
          ),
        ),
      ),
      castCall(
        fork,
        [arbitrum.usdc, "allowance(address,address)(uint256)", owner1, arbitrum.deposit.proxy],
        PIN,
      ).then(castUint),
      castCall(
        fork,
        [
          arbitrum.f24.address,
          "allowance(address,address)(uint256)",
          owner1,
          arbitrum.account.proxy,
        ],
        PIN,
      ).then(castUint),
    ]);
    expect(CURRENCIES.map((currency) => allowances.card[currency])).toStrictEqual(card);
    expect(CURRENCIES.map((currency) => allowances.deposit[currency])).toStrictEqual(deposit);
    expect(allowances.deposit.USDC).toBe(usdcDeposit);
    expect(allowances.account.F24).toBe(f24Account);
  });

  test("getAllowance for each pair kind matches cast", async () => {
    const allowance = async (
      asset: "EUR24" | "USDC" | "F24",
      spender: "card" | "deposit" | "account",
    ) =>
      getAllowance(fork.publicClient, { owner: owner1, asset, spender, blockNumber: FORK_BLOCK });
    const eur = arbitrum.tokens.EUR24.proxy;
    await expect(allowance("EUR24", "card")).resolves.toBe(
      castUint(
        await castCall(
          fork,
          [eur, "allowance(address,address)(uint256)", owner1, arbitrum.card.proxy],
          PIN,
        ),
      ),
    );
    await expect(allowance("EUR24", "deposit")).resolves.toBe(
      castUint(
        await castCall(
          fork,
          [eur, "allowance(address,address)(uint256)", owner1, arbitrum.deposit.proxy],
          PIN,
        ),
      ),
    );
    await expect(allowance("USDC", "deposit")).resolves.toBe(
      castUint(
        await castCall(
          fork,
          [arbitrum.usdc, "allowance(address,address)(uint256)", owner1, arbitrum.deposit.proxy],
          PIN,
        ),
      ),
    );
    await expect(allowance("F24", "account")).resolves.toBe(
      castUint(
        await castCall(
          fork,
          [
            arbitrum.f24.address,
            "allowance(address,address)(uint256)",
            owner1,
            arbitrum.account.proxy,
          ],
          PIN,
        ),
      ),
    );
  });

  test("verifyDeployment impl/admin match cast storage; owner is the pin", async () => {
    const check = await verifyDeployment(fork.publicClient, { blockNumber: FORK_BLOCK });
    const pins = [
      arbitrum.account,
      arbitrum.tokens.USD24,
      arbitrum.tokens.EUR24,
      arbitrum.tokens.CHF24,
      arbitrum.tokens.CNH24,
      arbitrum.deposit,
      arbitrum.card,
      arbitrum.priceList,
      arbitrum.f24Sales,
    ];
    const [impls, admins] = await Promise.all([
      Promise.all(pins.map(async (pin) => low20(fork, pin.proxy, IMPL_SLOT))),
      Promise.all(pins.map(async (pin) => low20(fork, pin.proxy, ADMIN_SLOT))),
    ]);
    expect(check.ok).toBe(true);
    expect(check.drift).toStrictEqual([]);
    expect(check.ownerChanged).toBe(false);
    expect(check.proxyAdminOwner.toLowerCase()).toBe(OPERATOR.toLowerCase());
    expect(impls).toStrictEqual(pins.map((pin) => pin.implementation.slice(2).toLowerCase()));
    expect(admins).toStrictEqual(pins.map((pin) => pin.admin.slice(2).toLowerCase()));
  });

  test.each(["EUR24", "CHF24"] as const)(
    "getPayoutMinimum %s matches cast minimalPayoutAmount",
    async (currency) => {
      const [sdk, cast] = await Promise.all([
        getPayoutMinimum(fork.publicClient, { currency, blockNumber: FORK_BLOCK }),
        castCall(
          fork,
          [arbitrum.tokens[currency].proxy, "minimalPayoutAmount()(uint256)"],
          PIN,
        ).then(castUint),
      ]);
      expect(sdk).toBe(cast);
    },
  );

  test("getMintQuote: 734519 open at 100 F24 / 10^16 wei; LIVE_1 taken", async () => {
    const [open, taken, existsOpen, existsTaken, price, quotePerEther] = await Promise.all([
      getMintQuote(fork.publicClient, { tokenId: 734_519n, blockNumber: FORK_BLOCK }),
      getMintQuote(fork.publicClient, { tokenId: LIVE_1, blockNumber: FORK_BLOCK }),
      castCall(fork, [ACCOUNT, "exists(uint256)(bool)", "734519"], PIN),
      castCall(fork, [ACCOUNT, "exists(uint256)(bool)", String(LIVE_1)], PIN),
      castCall(fork, [arbitrum.priceList.proxy, "getPrice(uint256)(uint256)", "734519"], PIN).then(
        BigInt,
      ),
      castCall(fork, [arbitrum.f24Sales.proxy, "quotePerEther()(uint256)"], PIN).then(castUint),
    ]);
    expect(open.taken).toBe(false);
    expect(taken.taken).toBe(true);
    expect(existsOpen).toBe("false");
    expect(existsTaken).toBe("true");
    expect(open.priceF24).toBe(100n);
    expect(open.priceWei).toBe(10n ** 16n);
    expect(open.priceF24).toBe(price);
    expect(open.priceWei).toBe(mintPriceWei(price, quotePerEther));
  });

  test("getExchangeQuote exact-in EUR24->USD24 matches cast + eth_call oracle", async () => {
    const eur = arbitrum.tokens.EUR24.proxy;
    const usd = arbitrum.tokens.USD24.proxy;
    const [quote, rate, spread, marketClosed, output] = await Promise.all([
      getExchangeQuote(fork.publicClient, {
        side: "exact-in",
        from: "EUR24",
        to: "USD24",
        amount: 1000n,
        blockNumber: FORK_BLOCK,
      }),
      castCall(fork, [DEPOSIT, "getExchangeRate(address,address)(uint256)", eur, usd], PIN).then(
        castUint,
      ),
      castCall(
        fork,
        [DEPOSIT, "getSpread(address,address,bool)(uint256)", eur, usd, "false"],
        PIN,
      ).then(castUint),
      castCall(fork, [DEPOSIT, "marketClosed()(bool)"], PIN),
      oracleUint(
        fork,
        {
          from: owner1,
          to: DEPOSIT,
          data: uint256Call("moneyExchangeExactIn", ["address", "address", "uint256"])(
            eur,
            usd,
            1000n,
          ),
        },
        PIN,
      ),
    ]);
    expect(quote.rate).toBe(rate);
    expect(quote.spread).toBe(spread);
    expect(quote.marketClosed).toBe(marketClosed === "true");
    expect(quote.marketClosed).toBe(true);
    expect(quote.output).toBe(output);
  });

  test("getExchangeQuote exact-out EUR24->USD24 matches cast + eth_call oracle", async () => {
    const eur = arbitrum.tokens.EUR24.proxy;
    const usd = arbitrum.tokens.USD24.proxy;
    const [quote, rate, spread, input] = await Promise.all([
      getExchangeQuote(fork.publicClient, {
        side: "exact-out",
        from: "EUR24",
        to: "USD24",
        amount: 1000n,
        blockNumber: FORK_BLOCK,
      }),
      castCall(fork, [DEPOSIT, "getExchangeRate(address,address)(uint256)", usd, eur], PIN).then(
        BigInt,
      ),
      castCall(
        fork,
        [DEPOSIT, "getSpread(address,address,bool)(uint256)", usd, eur, "true"],
        PIN,
      ).then(castUint),
      oracleUint(
        fork,
        {
          from: owner1,
          to: DEPOSIT,
          data: uint256Call("moneyExchangeExactOut", ["address", "address", "uint256"])(
            eur,
            usd,
            1000n,
          ),
        },
        PIN,
      ),
    ]);
    expect(quote.rate).toBe(rate);
    expect(quote.spread).toBe(spread);
    expect(quote.input).toBe(input);
  });

  test("getTopUpQuote at the pin matches cast (deposit paused)", async () => {
    const usd = arbitrum.tokens.USD24.proxy;
    const eur = arbitrum.tokens.EUR24.proxy;
    const [quote, min, max, fee, usdcRate, rate, spread] = await Promise.all([
      getTopUpQuote(fork.publicClient, {
        owner: owner1,
        output: "EUR24",
        usdcAmount: 5_000_000n,
        blockNumber: FORK_BLOCK,
      }),
      castCall(fork, [DEPOSIT, "minUsdcDepositAmount()(uint256)"], PIN).then(castUint),
      castCall(fork, [DEPOSIT, "maxUsdcDepositAmount()(uint256)"], PIN).then(castUint),
      castCall(
        fork,
        [DEPOSIT, "getFee(uint256,uint256)(uint256)", String(LIVE_1), "5000000"],
        PIN,
      ).then(castUint),
      castCall(
        fork,
        [DEPOSIT, "exchangeRates(address,address)(uint256)", arbitrum.usdc, usd],
        PIN,
      ).then(castUint),
      castCall(fork, [DEPOSIT, "getExchangeRate(address,address)(uint256)", usd, eur], PIN).then(
        BigInt,
      ),
      castCall(
        fork,
        [DEPOSIT, "getSpread(address,address,bool)(uint256)", usd, eur, "false"],
        PIN,
      ).then(castUint),
    ]);
    expect(quote.paused).toBe(true);
    expect(quote.min).toBe(min);
    expect(quote.max).toBe(max);
    expect(quote.fee).toBe(fee);
    expect(quote.outputAmount).toBe(expectedTopUp(5_000_000n, fee, usdcRate, rate, spread));
  });
});

/** SPEC §8.3, Fiat24Account.sol:102-107 — same formula, recomputed on cast-read inputs. */
function mintPriceWei(priceF24: bigint, quotePerEther: bigint): bigint {
  return quotePerEther < priceF24
    ? (priceF24 / quotePerEther) * 10n ** 18n
    : 10n ** 18n / (quotePerEther / priceF24);
}

/** SPEC §8.3, Fiat24CryptoDeposit.sol:250,259-260 — recomputed on cast-read inputs. */
function expectedTopUp(
  usdcAmount: bigint,
  fee: bigint,
  usdcRate: bigint,
  rate: bigint,
  spread: bigint,
): bigint {
  const o = (((usdcAmount - fee) / 10_000n) * usdcRate) / 10_000n;
  return (((o * rate) / 10_000n) * spread) / 10_000n;
}

describe.skipIf(!FORK_ENABLED)("fork: fx differential", () => {
  let fork: Fork;
  let snapshot: Hex;
  let owner1: Address;

  beforeAll(async () => {
    fork = await startFork();
    owner1 = await ownerOf(fork, LIVE_1);
    // record-quote.sh set-up: OPERATOR lifts the client limit, funds the sender
    // 10_000_000 of each currency from the richest internal desk, approves deposit.
    expectSuccess(await setClientLimit(fork, LIVE_1, 10n ** 15n));
    await Promise.all(
      CURRENCIES.map(async (currency) => {
        const token = arbitrum.tokens[currency].proxy;
        expectSuccess(await fund(fork, token, await richestDesk(fork, token), owner1, FUND));
        expectSuccess(
          await sendOk(
            fork,
            owner1,
            approveCall({ asset: currency, spender: "deposit", amount: DEPOSIT_ALLOWANCE }),
          ),
        );
      }),
    );
  }, 240_000);

  beforeEach(async () => {
    snapshot = await fork.testClient.snapshot();
  });

  afterEach(async () => {
    await fork.testClient.revert({ id: snapshot });
  });

  afterAll(() => {
    fork.stop();
  });

  test("getExchangeQuote matches moneyExchangeExactIn/Out for every pair × side × amount", async () => {
    const balances = new Map(
      await Promise.all(
        CURRENCIES.map(
          async (currency) =>
            [
              currency,
              await fork.publicClient.readContract({
                address: arbitrum.tokens[currency].proxy,
                abi: tokenAbi,
                functionName: "balanceOf",
                args: [owner1],
              }),
            ] as const,
        ),
      ),
    );
    const cases = fxDiffs((currency) => required(balances.get(currency)));
    const results = await Promise.all(
      cases.map(async (d) => fxCase(fork, owner1, d, required(balances.get(d.from)))),
    );
    expect(results.map((r) => r.sdk)).toStrictEqual(results.map((r) => r.oracle));
  });

  // SPEC §8.3 literal rows — the first 12 entries of scripts/vectors/raw/quote.json, canonicalized
  // by the same helpers as the differential test ("out:N" is output for exact-in, input for exact-out).
  const ROWS: ReadonlyArray<
    readonly ["exact-in" | "exact-out", Currency, Currency, bigint, string]
  > = [
    ["exact-in", "EUR24", "USD24", 1000n, "out:1077"],
    ["exact-in", "EUR24", "USD24", 1n, "below-minimum"],
    ["exact-in", "EUR24", "USD24", 12345n, "out:13308"],
    ["exact-in", "EUR24", "CHF24", 999n, "out:904"],
    ["exact-in", "EUR24", "CNH24", 5000n, "out:35993"],
    ["exact-in", "CNH24", "EUR24", 98692n, "out:13232"],
    ["exact-in", "CNH24", "USD24", 7n, "below-minimum"],
    ["exact-out", "EUR24", "USD24", 1000n, "out:926"],
    ["exact-out", "EUR24", "USD24", 1n, "below-minimum"],
    ["exact-out", "EUR24", "CHF24", 12345n, "out:13626"],
    ["exact-out", "CNH24", "USD24", 777n, "out:5277"],
    ["exact-out", "EUR24", "CNH24", 50000n, "out:6937"],
  ];

  test.each(ROWS)("§8.3 %s %s -> %s × %s", async (side, from, to, amount, expected) => {
    const d: Diff = { side, from, to, amount };
    const balance = await fork.publicClient.readContract({
      address: arbitrum.tokens[from].proxy,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [owner1],
    });
    expect(sdkOutcome(await quoted(fork, d), d, balance)).toBe(expected);
  });
});

const TOPUP_AMOUNTS = [5_000_000n, 100_000_000n, 123_456_789n] as const;
// record-quote.sh topUp.cases outputs — recorded eth_call results at the pin.
const TOPUP_EXPECTED: Readonly<Record<Currency, readonly [bigint, bigint, bigint]>> = {
  USD24: [495n, 9900n, 12222n],
  EUR24: [443n, 8871n, 10952n],
  CHF24: [407n, 8174n, 10091n],
  CNH24: [3248n, 64978n, 80218n],
};

/** One top-up case: SDK outputAmount vs raw eth_call of depositTokenViaUsdc. */
async function topupCase(
  fork: Fork,
  owner: Address,
  output: Currency,
  usdcAmount: bigint,
): Promise<{ sdk: bigint; oracle: bigint }> {
  const [quote, oracle] = await Promise.all([
    getTopUpQuote(fork.publicClient, { owner, output, usdcAmount }),
    oracleUint(
      fork,
      {
        from: owner,
        to: DEPOSIT,
        data: uint256Call("depositTokenViaUsdc", ["address", "address", "uint256"])(
          arbitrum.usdc,
          arbitrum.tokens[output].proxy,
          usdcAmount,
        ),
      },
      "latest",
    ),
  ]);
  return { sdk: quote.outputAmount, oracle };
}

describe.skipIf(!FORK_ENABLED)("fork: top-up differential", () => {
  let fork: Fork;
  let snapshot: Hex;
  let owner1: Address;

  beforeAll(async () => {
    fork = await startFork();
    owner1 = await ownerOf(fork, LIVE_1);
    expectSuccess(await unpause(fork, DEPOSIT));
    await mintUsdc(fork, owner1, 200_000_000n);
    expectSuccess(
      await sendOk(
        fork,
        owner1,
        approveCall({ asset: "USDC", spender: "deposit", amount: DEPOSIT_ALLOWANCE }),
      ),
    );
  }, 240_000);

  beforeEach(async () => {
    snapshot = await fork.testClient.snapshot();
  });

  afterEach(async () => {
    await fork.testClient.revert({ id: snapshot });
  });

  afterAll(() => {
    fork.stop();
  });

  test("getTopUpQuote.outputAmount equals depositTokenViaUsdc for every output × amount", async () => {
    const cases = CURRENCIES.flatMap((output) =>
      TOPUP_AMOUNTS.map((usdcAmount) => ({ output, usdcAmount })),
    );
    const results = await Promise.all(
      cases.map(async ({ output, usdcAmount }) => topupCase(fork, owner1, output, usdcAmount)),
    );
    expect(results.map((r) => r.sdk)).toStrictEqual(results.map((r) => r.oracle));
    expect(results.map((r) => r.oracle)).toStrictEqual(
      CURRENCIES.flatMap((output) => required(TOPUP_EXPECTED[output]).map((v) => v)),
    );
  });
});

describe.skipIf(!FORK_ENABLED)("fork: mint", () => {
  let fork: Fork;
  let snapshot: Hex;

  beforeAll(async () => {
    fork = await startFork();
  }, 120_000);

  beforeEach(async () => {
    snapshot = await fork.testClient.snapshot();
  });

  afterEach(async () => {
    await fork.testClient.revert({ id: snapshot });
  });

  afterAll(() => {
    fork.stop();
  });

  test("mintByClientWithETH succeeds at priceWei and rejects quote-changed at priceWei-1", async () => {
    const quote = await getMintQuote(fork.publicClient, {
      tokenId: 734_519n,
      blockNumber: FORK_BLOCK,
    });
    await fork.testClient.setBalance({ address: FRESH, value: quote.priceWei + 10n ** 18n });
    const data = encodeFunctionData({
      abi: accountAbi,
      functionName: "mintByClientWithETH",
      args: [734_519n],
    });
    const ok = await ethCallRaw(
      fork,
      { from: FRESH, to: ACCOUNT, data, value: quote.priceWei },
      "latest",
    );
    expect("result" in ok).toBe(true);

    const head = await fork.publicClient.getBlockNumber();
    const code = await errorCodeOf(
      simulateCall(fork.publicClient, {
        call: mintAccountWithEthCall({ tokenId: 734_519n, value: quote.priceWei - 1n }),
        from: FRESH,
        blockNumber: head,
      }),
    );
    // §6.3: "Not sufficient msg.value for F24 purchase" maps to quote-changed.
    expect(code).toBe("quote-changed");
  });
});
