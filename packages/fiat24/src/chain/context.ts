import type { Abi, AbiEvent, Address, Client, Hex } from "viem";
import { getAddress, isAddress, numberToHex, toEventSelector } from "viem";
import { getBlockNumber, getStorageAt, readContract } from "viem/actions";

import {
  accountAbi,
  cardAbi,
  depositAbi,
  f24Abi,
  f24SalesAbi,
  priceListAbi,
  tokenAbi,
} from "../abi/index.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { UnavailableReason } from "../core/errors.ts";
import { decodeFiat24Revert, revertCode } from "../core/revert.ts";
import type { RevertReason } from "../core/revert.ts";
import { CHAIN_ID } from "../core/types.ts";
import type { ContractName, PayoutCurrency } from "../core/types.ts";
import { contractAddress, getDeployment } from "../deployments/deployment.ts";
import type { Deployment } from "../deployments/deployment.ts";
import type { RawLog } from "../events/types.ts";

/** Shared args for every chain read action (SPEC §3.6). */
export type ChainArgs = {
  readonly deployment?: Deployment | undefined;
  readonly blockNumber?: bigint | undefined;
};

export type Snapshot = {
  readonly deployment: Deployment;
  readonly blockNumber: bigint;
};

// EIP-1967 slots: implementation and admin (SPEC §8.1).
export const IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
export const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;

// Fiat24Account packed slots (verified storageLayout, evidence/sources/account.json):
// slot 359 (0x167) bytes 0-19 = fiat24PriceList, byte 20 = f24IsActive;
// slot 358 (0x166) byte 0 = minDigitForSale, byte 1 = maxDigitForSale, bytes 2-21 = f24.
export const PRICELIST_SLOT = "0x167" as Hex;
export const F24_SLOT = "0x166" as Hex;
// slot 364 (0x16c) = F24SalesAddress (verified storageLayout).
export const F24SALES_SLOT = "0x16c" as Hex;
// Fiat24CryptoDeposit slot 208 (0xd0) = usdc (verified storageLayout).
export const USDC_SLOT = "0xd0" as Hex;

const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;

/** Malformed/out-of-domain RPC data — the node lied (SPEC §8.1). */
export const invalidResponse = (message = "invalid rpc response"): never => {
  throw new Fiat24Error("invalid-rpc-response", message);
};

const rpcError = (message = "rpc request failed"): never => {
  throw new Fiat24Error("rpc-error", message);
};

// Result guards: viem's decoder yields correctly-typed values for well-formed
// bytes; these catch the malformed cases (SPEC §8.1 ⇒ invalid-rpc-response).
export function asBigint(value: unknown): bigint {
  return typeof value === "bigint" ? value : invalidResponse();
}

export function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalidResponse();
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : invalidResponse();
}

export function asUint8(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 255
    ? value
    : invalidResponse();
}

export function asAddress(value: unknown): Address {
  return typeof value === "string" && isAddress(value, { strict: false })
    ? getAddress(value)
    : invalidResponse();
}

/** Caller-side address check: `invalid-address`, before any I/O (SPEC §8.1). */
export function checkedAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Fiat24Error("invalid-address", "invalid address");
  }
  return getAddress(value);
}

/** Caller-side payout currency check (SPEC §8.2: CashPayout exists on EUR24/CHF24 only). */
export function checkedPayoutCurrency(currency: unknown): PayoutCurrency {
  if (currency !== "EUR24" && currency !== "CHF24") {
    throw new Fiat24Error("unsupported-currency", "unsupported currency");
  }
  return currency;
}

const MAX_CHUNK = 10_000_000n;

/** `chunkSize` must be a bigint in [1, 10_000_000] (SPEC §7.2). */
export function checkedChunkSize(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > MAX_CHUNK) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  return value;
}

/**
 * §8.1: the only deployment resolution. `client.chain?.id !== 42161` ⇒ `unsupported-chain` (also
 * when `client.chain` is undefined — I21, even if a deployment was passed). The decorator's option
 * already arrived via `args.deployment`, so nothing else is consulted.
 */
export function resolveDeployment(client: Client, deployment?: Deployment): Deployment {
  if (client.chain?.id !== CHAIN_ID) {
    throw new Fiat24Error("unsupported-chain", "unsupported chain");
  }
  const resolved = deployment ?? getDeployment(CHAIN_ID);
  if (resolved === undefined || resolved.chainId !== CHAIN_ID) {
    throw new Fiat24Error("unsupported-chain", "unsupported chain");
  }
  return resolved;
}

/**
 * §8.1: one block per action. `args.blockNumber` wins and must be a bigint >= 0; otherwise a fresh
 * `eth_blockNumber` (cacheTime 0 — never viem's cached value). Every read of the action is issued
 * at this B (C2 asserts the block tag of every request).
 */
export async function snapshot(client: Client, args: ChainArgs): Promise<Snapshot> {
  const deployment = resolveDeployment(client, args.deployment);
  const { blockNumber: provided } = args;
  let blockNumber: bigint;
  if (provided === undefined) {
    try {
      blockNumber = await getBlockNumber(client, { cacheTime: 0 });
    } catch (error) {
      return mapViemError(error);
    }
  } else {
    if (typeof provided !== "bigint" || provided < 0n) {
      throw new Fiat24Error("invalid-argument", "invalid argument");
    }
    blockNumber = provided;
  }
  return { deployment, blockNumber };
}

export function isHexData(value: unknown): value is Hex {
  return typeof value === "string" && HEX_RE.test(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Walks the error's `cause` chain, collecting every object for inspection.
export function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current["cause"];
  }
  return chain;
}

/**
 * Finds revert payload bytes in a viem error tree. Sources, in order:
 * `ContractFunctionRevertedError.raw`, then any error carrying a hex `data` (RawContractError or an
 * RPC error object), then `{data: {data}}` shapes. Returns undefined when no payload.
 */
export function findRevertData(error: unknown): Hex | undefined {
  for (const node of errorChain(error)) {
    if (isHexData(node["raw"]) && node["raw"] !== "0x") {
      return node["raw"];
    }
  }
  for (const node of errorChain(error)) {
    const { data } = node;
    if (isHexData(data) && data !== "0x") {
      return data;
    }
    if (isObject(data) && isHexData(data["data"]) && data["data"] !== "0x") {
      return data["data"];
    }
  }
  return undefined;
}

// Marks a revert with no recoverable payload (ExecutionRevertedError, code-3 RPC error,
// or a revert message in details/shortMessage) so it still maps to a revert code.
function looksLikeRevert(error: unknown): boolean {
  for (const node of errorChain(error)) {
    const name = typeof node["name"] === "string" ? node["name"] : "";
    if (name === "ContractFunctionRevertedError" || name === "ExecutionRevertedError") {
      return true;
    }
    if (node["code"] === 3) {
      return true;
    }
    const text =
      `${typeof node["details"] === "string" ? node["details"] : ""} ${typeof node["shortMessage"] === "string" ? node["shortMessage"] : ""}`.toLowerCase();
    if (text.includes("execution reverted")) {
      return true;
    }
  }
  return false;
}

// Result-decoding failures mean the RPC returned bytes the ABI can't read (SPEC §8.1:
// out-of-domain values ⇒ invalid-rpc-response).
const DECODING_ERRORS =
  /^Abi(Decoding|Encoding)|Decoding|Decode|PositionOutOfBounds|SliceOffsetOutOfBounds|BytesSizeMismatch|ContractFunctionZeroData|InvalidAbi|InvalidAddress/;

function looksLikeDecodingFailure(error: unknown): boolean {
  for (const node of errorChain(error)) {
    const name = typeof node["name"] === "string" ? node["name"] : "";
    if (DECODING_ERRORS.test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * One mapping for every viem failure (SPEC §8.1, never attach `cause`, fixed messages): a revert
 * during a read ⇒ `contract-revert` with `detail.revert` decoded; result decoding failures ⇒
 * `invalid-rpc-response`; everything else ⇒ `rpc-error`. Callers that want the §6.3 table instead
 * use `throwMapped` (below).
 */
export function mapViemError(error: unknown): never {
  if (error instanceof Fiat24Error) {
    throw error;
  }
  // Decoding failures come first: AbiDecoding*Error.data holds the bad return
  // bytes, which findRevertData would otherwise mislabel as a revert payload.
  if (looksLikeDecodingFailure(error)) {
    return invalidResponse();
  }
  const data = findRevertData(error);
  if (data !== undefined) {
    throw new Fiat24Error("contract-revert", "contract call reverted", {
      revert: decodeFiat24Revert(data),
    });
  }
  if (looksLikeRevert(error)) {
    throw new Fiat24Error("contract-revert", "contract call reverted", {
      revert: { kind: "unknown" },
    });
  }
  return rpcError();
}

/**
 * Like mapViemError, but reverts go through the §6.3 table (`revertCode`) with `detail.reason` for
 * `unavailable` — used by `checkTransfer` step 5 and `simulateCall`.
 */
export function throwMapped(error: unknown): never {
  if (error instanceof Fiat24Error) {
    throw error;
  }
  if (looksLikeDecodingFailure(error)) {
    return invalidResponse();
  }
  const data = findRevertData(error);
  if (data !== undefined || looksLikeRevert(error)) {
    throw revertError(data === undefined ? { kind: "unknown" } : decodeFiat24Revert(data));
  }
  return rpcError();
}

/**
 * `Fiat24Error(revertCode(revert), …, { revert, reason? })`. `detail.reason` refines `unavailable`
 * per §6.3: the pause/emptiness texts and custom errors map to the on-chain fact behind them
 * (account-paused, token-paused, deposit-paused, f24-sales-*, f24-inactive).
 */
export function revertError(revert: RevertReason): Fiat24Error {
  const code = revertCode(revert);
  const reason = unavailableReason(revert);
  return new Fiat24Error(code, "contract call reverted", {
    revert,
    ...(reason === undefined ? {} : { reason }),
  });
}

// A Map (not an object literal): `Error(string)` reason text is untrusted input — plain
// object indexing would read prototype properties.
const UNAVAILABLE_REASONS: ReadonlyMap<string, UnavailableReason> = new Map<
  string,
  UnavailableReason
>([
  // Fiat24Token.sol:157-158 (view, capital A) and :420-421 (lowercase a).
  ["Fiat24Token: All account transfers are paused", "account-paused"],
  ["Fiat24Token: all account transfers are paused", "account-paused"],
  // Fiat24Account.sol:412 (mint while the account contract is paused).
  ["Account transfers suspended", "account-paused"],
  ["Fiat24Token: All account transfers of this currency are paused", "token-paused"],
  ["Fiat24Token: all account transfers of this currency are paused", "token-paused"],
  // Fiat24Account.sol:118.
  ["F24 is inactive", "f24-inactive"],
]);

const UNAVAILABLE_CUSTOMS: ReadonlyMap<string, UnavailableReason> = new Map<
  string,
  UnavailableReason
>([
  ["Fiat24CryptoDeposit__Paused", "deposit-paused"],
  ["F24Sales__Paused", "f24-sales-paused"],
  ["F24Sales__NotEnoughF24", "f24-sales-empty"],
]);

function unavailableReason(revert: RevertReason): UnavailableReason | undefined {
  if (revertCode(revert) !== "unavailable") {
    return undefined;
  }
  if (revert.kind === "error") {
    return UNAVAILABLE_REASONS.get(revert.reason);
  }
  if (revert.kind === "custom") {
    return UNAVAILABLE_CUSTOMS.get(revert.name);
  }
  return undefined;
}

const CONTRACT_ABI: Readonly<Record<ContractName, Abi>> = {
  account: accountAbi,
  USD24: tokenAbi,
  EUR24: tokenAbi,
  CHF24: tokenAbi,
  CNH24: tokenAbi,
  deposit: depositAbi,
  card: cardAbi,
  priceList: priceListAbi,
  f24Sales: f24SalesAbi,
  f24: f24Abi,
};

/**
 * `{address, abi}` of a named deployment contract — lets layers above `chain` (which may not import
 * `abi/` directly) build `readAt` parameters and event topics (USDC is plain ERC-20: callers pair
 * `deployment.usdc` with viem's `erc20Abi`).
 */
export function contractTarget(
  deployment: Deployment,
  name: ContractName,
): { readonly address: Address; readonly abi: Abi } {
  return { address: contractAddress(deployment, name), abi: CONTRACT_ABI[name] };
}

/**
 * Viem `readContract` pinned at `blockNumber`; errors mapped by {@link mapViemError} (revert ⇒
 * contract-revert, decode failure ⇒ invalid-rpc-response, else rpc-error).
 */
export async function readAt(
  client: Client,
  blockNumber: bigint,
  parameters: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: ReadonlyArray<unknown>;
  },
): Promise<unknown> {
  try {
    return await readContract(client, {
      address: parameters.address,
      abi: parameters.abi,
      functionName: parameters.functionName,
      args: parameters.args,
      blockNumber,
    });
  } catch (error) {
    return mapViemError(error);
  }
}

/** Viem `eth_getStorageAt` at `blockNumber`; result must be a 32-byte word (SPEC §8.1). */
export async function storageAt(
  client: Client,
  blockNumber: bigint,
  address: Address,
  slot: Hex,
): Promise<Hex> {
  let word: Hex | undefined;
  try {
    word = await getStorageAt(client, { address, slot, blockNumber });
  } catch (error) {
    return mapViemError(error);
  }
  if (typeof word !== "string" || !WORD_RE.test(word)) {
    return invalidResponse();
  }
  return word;
}

/**
 * An address packed into a storage word's low 20 bytes (EIP-1967 impl/admin, wiring pointers). High
 * 12 bytes must be zero, else the RPC is lying (§8.1).
 */
export function addressSlot(word: Hex): Address {
  if (!WORD_RE.test(word)) {
    invalidResponse();
  }
  const high = word.slice(2, 26);
  if (!/^0*$/.test(high)) {
    invalidResponse();
  }
  return getAddress(`0x${word.slice(26)}`);
}

/**
 * Byte `offset` of a storage word, counted little-endian (byte 0 = rightmost), matching Solidity's
 * packed-slot layout.
 */
export function slotByte(word: Hex, offset: number): number {
  const hex = word.slice(2);
  const index = hex.length - 2 * (offset + 1);
  return Number.parseInt(hex.slice(index, index + 2), 16);
}

/**
 * Bytes `lo..hi` (little-endian, byte 0 = rightmost) of a packed storage slot decoded as an
 * address. No dirty-byte rule: the rest of the word legitimately holds other variables (§8.1), so
 * {@link addressSlot} must not be reused for packed slots.
 */
export function packedAddress(word: Hex, lo: number, hi: number): Address {
  const hex = word.slice(2);
  const slice = hex.slice(62 - 2 * hi, 64 - 2 * lo);
  if (slice.length !== 40) {
    return invalidResponse();
  }
  return getAddress(`0x${slice}`);
}

// Topic0 selectors are derived from the ABIs at call time (§4.4, never hand-typed).
export function topic0Of(abi: Abi, name: string): Hex {
  const event = abi.find(
    (entry): entry is AbiEvent => entry.type === "event" && entry.name === name,
  );
  if (event === undefined) {
    throw new Fiat24Error("invalid-rpc-response", "invalid rpc response");
  }
  return toEventSelector(event);
}

const LOG_INDEX_RE = /^0x[0-9a-fA-F]+$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// oxlint-disable-next-line typescript/no-restricted-types -- topic positions may be null
type TopicFilter = Hex | Hex[] | null;

export type LogFilter = {
  readonly address: Address | Address[];
  readonly topics: ReadonlyArray<TopicFilter>;
};

const isWordTopic = (v: unknown): v is Hex => typeof v === "string" && WORD_RE.test(v);
const isHexValue = (v: unknown): v is Hex => typeof v === "string" && HEX_RE.test(v);

function toRawLog(value: unknown): RawLog {
  if (!isObject(value)) {
    return invalidResponse();
  }
  const { address, topics, data, blockNumber, transactionHash, logIndex } = value;
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    return invalidResponse();
  }
  if (!Array.isArray(topics) || !topics.every(isWordTopic)) {
    return invalidResponse();
  }
  if (!isHexValue(data)) {
    return invalidResponse();
  }
  // Pending logs carry null position fields; keep them null so decodeFiat24Log refuses
  // them with malformed-log (SPEC §3.5) instead of us hiding the fact silently.
  // oxlint-disable-next-line typescript/no-restricted-types -- receipt JSON carries null on pending logs
  const toBig = (v: unknown): bigint | null => {
    if (v === null) {
      return null;
    }
    if (typeof v === "string" && LOG_INDEX_RE.test(v)) {
      return BigInt(v);
    }
    return invalidResponse();
  };
  // oxlint-disable-next-line typescript/no-restricted-types -- receipt JSON carries null on pending logs
  const toIndex = (v: unknown): number | null => {
    if (v === null) {
      return null;
    }
    if (typeof v === "string" && LOG_INDEX_RE.test(v)) {
      const n = Number(v);
      if (Number.isSafeInteger(n)) {
        return n;
      }
    }
    return invalidResponse();
  };
  return {
    address: getAddress(address),
    topics,
    data,
    blockNumber: toBig(blockNumber),
    transactionHash:
      transactionHash === null
        ? null
        : isWordTopic(transactionHash)
          ? transactionHash
          : invalidResponse(),
    logIndex: toIndex(logIndex),
  };
}

/**
 * `eth_getLogs` over `[fromBlock, toBlock]` in sequential windows of `chunkSize`; each window's
 * filters run concurrently (SPEC §7.2). viem's getLogs can't express a topic0 array plus indexed
 * filters, so this goes through `client.request` directly. Any shape failure ⇒
 * `invalid-rpc-response`; any request failure ⇒ `rpc-error` naming the window's decimal bounds.
 */
export async function getLogsChunked(
  client: Client,
  args: {
    filters: ReadonlyArray<LogFilter>;
    fromBlock: bigint;
    toBlock: bigint;
    chunkSize: bigint;
  },
): Promise<RawLog[]> {
  const { filters, fromBlock, toBlock } = args;
  const chunkSize = checkedChunkSize(args.chunkSize);
  const out: RawLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
    const windows = filters.map(async (filter): Promise<RawLog[]> => {
      let response: unknown;
      try {
        response = await client.request({
          method: "eth_getLogs",
          params: [
            {
              address: filter.address,
              topics: [...filter.topics],
              fromBlock: numberToHex(start),
              toBlock: numberToHex(end),
            },
          ],
        });
      } catch {
        throw new Fiat24Error(
          "rpc-error",
          `rpc request failed for blocks ${start.toString()}-${end.toString()}`,
        );
      }
      if (!Array.isArray(response)) {
        return invalidResponse();
      }
      return response.map(toRawLog);
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- windows run sequentially (SPEC §7.2)
    const batches = await Promise.all(windows);
    // No `out.push(...batch)`: a huge RPC array would overflow the call stack
    // when spread — a RangeError, not a Fiat24Error.
    for (const batch of batches) {
      for (const log of batch) {
        out.push(log);
      }
    }
  }
  return out;
}
