import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
} from "viem";
import type { Abi, Address, Hex } from "viem";
import { arbitrum } from "viem/chains";
import { expect } from "vite-plus/test";

import {
  accountAbi,
  cardAbi,
  depositAbi,
  f24Abi,
  f24SalesAbi,
  priceListAbi,
  proxyAdminAbi,
  tokenAbi,
} from "../../src/abi/index.ts";
import { Fiat24Error } from "../../src/core/errors.ts";
import { arbitrum as deployment } from "../../src/deployments/index.ts";

export type RecordedRequest = { readonly method: string; readonly params: unknown };

/** One `eth_call` after ABI decoding (undefined fields when the calldata is not ours). */
export type DecodedCall = {
  readonly to: Address | undefined;
  readonly data: Hex | undefined;
  readonly from: Address | undefined;
  readonly value: bigint | undefined;
  readonly blockTag: string | undefined;
  readonly abi: Abi | undefined;
  readonly functionName: string | undefined;
  readonly args: ReadonlyArray<unknown> | undefined;
};

export type CallAnswer =
  | { readonly result: unknown } // encoded with the call's own abi+functionName
  | { readonly raw: Hex } // returned verbatim (malformed-hex tests)
  | { readonly revert: Hex } // thrown as { code: 3, data }
  | { readonly thrown: unknown }; // thrown verbatim (transport-level failures)

export type CallEntry = {
  readonly args?: ReadonlyArray<unknown>; // deep-equal match on decoded args when set
  readonly answer: CallAnswer;
};

/** Key: `${contractAddress.toLowerCase()}:${functionName}` — entries consumed in order. */
export type CallTable = ReadonlyMap<string, CallEntry | ReadonlyArray<CallEntry>>;

export type Stub = {
  readonly client: ReturnType<typeof createPublicClient>;
  readonly requests: RecordedRequest[];
  readonly calls: DecodedCall[];
};

/** Key normalization: the contract address is compared case-insensitively. */
function normKey(key: string): string {
  const i = key.indexOf(":");
  return `${key.slice(0, i).toLowerCase()}${key.slice(i)}`;
}

/** The error shape a JSON-RPC node reports (an Error keeps `code`/`data` readable). */
function rpcFailure(code: number, message: string, data?: Hex): Error {
  return data === undefined
    ? Object.assign(new Error(message), { code })
    : Object.assign(new Error(message), { code, data });
}

const ABIS_BY_ADDRESS = new Map<string, Abi>([
  [deployment.account.proxy.toLowerCase(), accountAbi],
  [deployment.tokens.USD24.proxy.toLowerCase(), tokenAbi],
  [deployment.tokens.EUR24.proxy.toLowerCase(), tokenAbi],
  [deployment.tokens.CHF24.proxy.toLowerCase(), tokenAbi],
  [deployment.tokens.CNH24.proxy.toLowerCase(), tokenAbi],
  [deployment.deposit.proxy.toLowerCase(), depositAbi],
  [deployment.card.proxy.toLowerCase(), cardAbi],
  [deployment.priceList.proxy.toLowerCase(), priceListAbi],
  [deployment.f24Sales.proxy.toLowerCase(), f24SalesAbi],
  [deployment.f24.address.toLowerCase(), f24Abi],
  [deployment.proxyAdmin.address.toLowerCase(), proxyAdminAbi],
  [deployment.usdc.toLowerCase(), erc20Abi],
]);

export const ZERO_WORD: Hex = `0x${"0".repeat(64)}`;

/** 32-byte storage word with `address` in the low 20 bytes and `head` hex above it. */
export function wordWithAddress(address: Address, head = ""): Hex {
  return `0x${head.padStart(24, "0")}${address.toLowerCase().slice(2)}` as Hex;
}

/** Minimal eth_getBlockByNumber payload; viem only needs `timestamp` for our reads. */
export function blockPayload(number: bigint, timestamp: bigint): Record<string, unknown> {
  const word = `0x${"0".repeat(64)}`;
  return {
    number: `0x${number.toString(16)}`,
    timestamp: `0x${timestamp.toString(16)}`,
    hash: word,
    parentHash: word,
    nonce: "0x0000000000000000",
    sha3Uncles: word,
    logsBloom: `0x${"0".repeat(512)}`,
    transactionsRoot: word,
    stateRoot: word,
    receiptsRoot: word,
    miner: `0x${"0".repeat(40)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x0",
    gasUsed: "0x0",
    baseFeePerGas: "0x0",
    transactions: [],
    uncles: [],
    mixHash: word,
  };
}

function sameArg(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") {
    return a === b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameArg(v, b[i]));
  }
  return a === b;
}

// The error shape a JSON-RPC node reports for a reverted call (verified against viem's
// error tree: ContractFunctionExecutionError > ContractFunctionRevertedError > …).
export function rpcRevert(data: Hex | undefined): Error {
  return rpcFailure(3, "execution reverted", data);
}

export function makeStub(options: {
  readonly blockNumber?: bigint;
  readonly timestamp?: bigint;
  readonly calls?: CallTable;
  readonly storage?: ReadonlyMap<string, Hex>;
  readonly logs?: (filter: Record<string, unknown>) => unknown;
  readonly onRequest?: (method: string, params: unknown) => unknown;
  readonly chainId?: number;
}): Stub {
  const requests: RecordedRequest[] = [];
  const calls: DecodedCall[] = [];
  const callQueues = new Map<string, CallEntry[]>();
  for (const [key, entry] of options.calls ?? new Map()) {
    callQueues.set(normKey(key), Array.isArray(entry) ? [...entry] : [entry]);
  }

  const handleRequest = ({ method, params }: { method: string; params?: unknown }): unknown => {
    requests.push({ method, params });
    if (options.onRequest !== undefined) {
      const answer = options.onRequest(method, params);
      if (answer !== undefined) {
        return answer;
      }
    }
    if (method === "eth_blockNumber") {
      return `0x${(options.blockNumber ?? 0n).toString(16)}`;
    }
    if (method === "eth_getBlockByNumber") {
      return blockPayload(BigInt((params as [string, boolean])[0]), options.timestamp ?? 0n);
    }
    if (method === "eth_getStorageAt") {
      const [address, slot] = params as [Address, Hex, string];
      const word = options.storage?.get(`${address.toLowerCase()}:${slot.toLowerCase()}`);
      if (word === undefined) {
        throw rpcFailure(-32000, `unexpected eth_getStorageAt ${address} ${slot}`);
      }
      return word;
    }
    if (method === "eth_getLogs") {
      if (options.logs === undefined) {
        throw rpcFailure(-32000, "unexpected eth_getLogs");
      }
      return options.logs((params as Array<Record<string, unknown>>)[0] ?? {});
    }
    if (method === "eth_call") {
      const [tx, blockTag] = params as [
        { to?: Address; data?: Hex; from?: Address; value?: Hex },
        string,
      ];
      const abi = tx.to === undefined ? undefined : ABIS_BY_ADDRESS.get(tx.to.toLowerCase());
      let decoded: { functionName: string; args: ReadonlyArray<unknown> | undefined } | undefined;
      if (abi !== undefined && tx.data !== undefined) {
        try {
          decoded = decodeFunctionData({ abi, data: tx.data });
        } catch {
          decoded = undefined;
        }
      }
      const call: DecodedCall = {
        to: tx.to,
        data: tx.data,
        from: tx.from,
        value: tx.value === undefined ? undefined : BigInt(tx.value),
        blockTag,
        abi,
        functionName: decoded?.functionName,
        args: decoded?.args,
      };
      calls.push(call);
      if (decoded === undefined || abi === undefined) {
        throw rpcFailure(-32000, `unexpected eth_call to ${String(tx.to)}`);
      }
      const key = normKey(`${String(tx.to)}:${decoded.functionName}`);
      const queue = callQueues.get(key);
      const entry = queue?.[0];
      if (entry === undefined) {
        throw rpcFailure(-32000, `unexpected eth_call ${String(tx.to)} ${decoded.functionName}`);
      }
      if (
        entry.args !== undefined &&
        decoded.args !== undefined &&
        !sameArg(entry.args, decoded.args)
      ) {
        throw rpcFailure(
          -32000,
          `unexpected args for ${decoded.functionName}: ${JSON.stringify(decoded.args)}`,
        );
      }
      // Keep the last entry sticky: viem's withRetry replays the request when the
      // transport error surfaces as UnknownRpcError, and a real node answers a
      // repeated identical call with the same result.
      if (queue !== undefined && queue.length > 1) {
        queue.shift();
      }
      const { answer } = entry;
      if ("result" in answer) {
        return encodeFunctionResult({
          abi,
          functionName: decoded.functionName,
          result: answer.result,
        });
      }
      if ("raw" in answer) {
        return answer.raw;
      }
      if ("revert" in answer) {
        throw rpcRevert(answer.revert);
      }
      // Hostile throws may carry JSON-RPC fields (code 3 = revert): spread them onto
      // a real Error so viem's request layer reads code/data like a live node.
      if (answer.thrown instanceof Error) {
        throw answer.thrown;
      }
      const fields =
        typeof answer.thrown === "object" && answer.thrown !== null ? answer.thrown : {};
      throw Object.assign(new Error("transport failure"), fields);
    }
    throw rpcFailure(-32601, `unhandled method ${method}`);
  };

  // The await is required by lint and harmless: handleRequest throws sync
  // transport failures that must surface as promise rejections to viem.
  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    const out = await Promise.resolve(handleRequest({ method, params }));
    return out;
  };

  const client = createPublicClient({
    chain: options.chainId === undefined ? arbitrum : { ...arbitrum, id: options.chainId },
    // retryCount lives on the transport config, not the client: without this the
    // custom transport retries UnknownRpcError (the wrapper for every thrown
    // non-RPC shape) three times.
    transport: custom({ request }, { retryCount: 0 }),
  });
  return { client, requests, calls };
}

export const B = 526365924n;
export const B_HEX: Hex = `0x${B.toString(16)}`;
export const OWNER = "0x00000000000000000000000000000000000000aa" as Address;
export const RECIPIENT = "0x00000000000000000000000000000000000000bb" as Address;
export const THIRD = "0x00000000000000000000000000000000000000cc" as Address;
export const TOKEN_ID = 350273n;

/** Like tests/helpers' expectError, but awaits the promise the action returns. */
export async function expectErrorAsync(
  run: () => Promise<unknown>,
  code: string,
): Promise<InstanceType<typeof Fiat24Error>> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Fiat24Error) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
  }
  throw new Error(`expected ${code}`);
}

/** Decoded `eth_call` entries with (to, functionName, args, blockTag), in order. */
export function callLog(calls: ReadonlyArray<DecodedCall>): ReadonlyArray<{
  to: Address | undefined;
  functionName: string | undefined;
  args: ReadonlyArray<unknown> | undefined;
  blockTag: string | undefined;
}> {
  return calls.map((c) => ({
    to: c.to,
    functionName: c.functionName,
    args: c.args,
    blockTag: c.blockTag,
  }));
}
