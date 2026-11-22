/**
 * Anvil fork harness — every file under `tests/fork/` replays the SDK against Arbitrum One at
 * pinned block 526365924 (SPEC §11.2). `FIAT24_FORK_URL` must point at an archive endpoint; without
 * it every suite is skipped (the line below is the one required explicit message). All sends go to
 * the local anvil; nothing is broadcast upstream.
 *
 * Accounts are never hard-coded: Live account owners come from `ownerOf` at the fork block and
 * every balance-holder below was found by chain reads there (comments record how).
 */
import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";

import type {
  Address,
  Hex,
  PublicClient,
  TestClient,
  TransactionReceipt,
  WalletClient,
} from "viem";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  toHex,
} from "viem";
import { arbitrum as arbitrumChain } from "viem/chains";
import { expect } from "vite-plus/test";

import { accountAbi, depositAbi, priceListAbi, tokenAbi } from "../../src/abi/index.ts";
import type { Fiat24Call } from "../../src/calls/index.ts";
import { decodeFiat24Revert, Fiat24Error, revertCode } from "../../src/core/index.ts";
import type { Fiat24ErrorCode, Fiat24TransactionRequest } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import type { Fiat24Event, RawLog } from "../../src/events/index.ts";
import { decodeFiat24Logs } from "../../src/events/index.ts";

export const FORK_URL: string | undefined = process.env["FIAT24_FORK_URL"];
export const FORK_ENABLED: boolean = typeof FORK_URL === "string" && FORK_URL !== "";
if (!FORK_ENABLED) {
  // process.stdout — vitest's console interceptor would swallow console.log in skipped files.
  process.stdout.write("fork suite skipped: FIAT24_FORK_URL is not set\n");
}
export const FORK_BLOCK = 526365924n;

/** Live account NFTs used across the suites (SPEC §11.2); owners resolved via `ownerOf`. */
export const LIVE_1 = 350273n;
export const LIVE_2 = 469709n;

// §11.2 set-up role holders, verified at the pinned block (audit roles-526365924.txt).
export const OPERATOR: Address = getAddress("0x1272c99bEFa7a70f935Edca81BF9a6E85C6D9D59");
export const ROBOT: Address = getAddress("0x0e412a4ac9535781f623daa1e6c6286755a72948");

// `deposit.usdcDepositAddress()` at the fork block: the protocol's crypto/USDC desk, Live account
// 9100. Found by `eth_call` + `balanceOf` at 526365924 — it holds ~40.5M CHF24, ~29.9M F24 and
// ~739 USDC, which makes it the funding source for CHF24/USDC/F24 transfers to test accounts.
export const DESK: Address = getAddress("0x5245d4b5b5fa5cc8e11e30eE1f05c541b965f0c9");

// `usdc.masterMinter()` at the fork block; used only to mint > maxUsdcDepositAmount USDC for the
// above-maximum case (no holder with 50,000+ USDC is needed then).
export const USDC_MASTER_MINTER: Address = getAddress("0x8aFf09e2259cacbF4Fc4e3E53F3bf799EfEEab36");

// ArbSys precompile; anvil emulates `arbBlockNumber()` tracking the local head (probed).
export const ARB_SYS: Address = getAddress("0x0000000000000000000000000000000000000064");

const PAUSE_ABI = parseAbi(["function pause()", "function unpause()"]);
const USDC_ACTIONS = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
]);
const F24_SALES_ABI = parseAbi(["function quotePerEther() view returns (uint256)"]);

const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const freePort = async (): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) {
          resolve(address.port);
        } else {
          reject(new Error("no free port"));
        }
      });
    });
  });

export type Fork = {
  readonly url: string;
  readonly publicClient: PublicClient;
  readonly testClient: TestClient;
  readonly walletClient: WalletClient;
  readonly stop: () => void;
};

/** Polls the local anvil until its JSON-RPC answers or the deadline passes. */
async function waitReady(
  url: string,
  child: ChildProcess,
  stderr: () => string,
  deadline: number,
): Promise<void> {
  if (child.exitCode !== null) {
    throw new Error(`anvil exited ${child.exitCode}: ${stderr()}`);
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    if (res.ok) {
      return;
    }
  } catch {
    // not listening yet
  }
  if (Date.now() > deadline) {
    child.kill("SIGKILL");
    throw new Error(`anvil did not start within 60s: ${stderr()}`);
  }
  await sleep(100);
  await waitReady(url, child, stderr, deadline);
}

/** Spawns `anvil --fork-url $FIAT24_FORK_URL --fork-block-number 526365924` on a free port. */
export async function startFork(): Promise<Fork> {
  const port = await freePort();
  const child = spawn(
    "anvil",
    [
      "--fork-url",
      FORK_URL ?? "",
      "--fork-block-number",
      FORK_BLOCK.toString(),
      "--port",
      String(port),
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  const stderrText = (): string => stderr;
  child.stderr.on("data", (chunk: Uint8Array) => {
    stderr += String(chunk);
  });
  const url = `http://127.0.0.1:${port}`;
  await waitReady(url, child, stderrText, Date.now() + 60_000);
  const transport = http(url);
  return {
    url,
    publicClient: createPublicClient({ chain: arbitrumChain, transport }),
    testClient: createTestClient({ mode: "anvil", chain: arbitrumChain, transport }),
    walletClient: createWalletClient({ chain: arbitrumChain, transport }),
    stop: () => {
      child.kill("SIGKILL");
    },
  };
}

/** Sends a transaction from `from` (impersonated + ETH-funded) and waits for the receipt. */
export async function sendAs(
  fork: Fork,
  from: Address,
  to: Address,
  data: Hex,
  value = 0n,
): Promise<TransactionReceipt> {
  await fork.testClient.impersonateAccount({ address: from });
  await fork.testClient.setBalance({ address: from, value: 10n ** 18n });
  const send = async (): Promise<TransactionReceipt> => {
    const hash = await fork.walletClient.sendTransaction({
      account: from,
      chain: arbitrumChain,
      to,
      data,
      value,
    });
    return fork.publicClient.waitForTransactionReceipt({ hash });
  };
  const receipt = await send();
  // The remote-backed fork occasionally mines an impersonated tx against lazily-fetched upstream
  // storage and yields a spurious `reverted` receipt while the identical `eth_call` is valid.
  // Retry only when the chain itself proves the call cannot revert; a real revert resurfaces.
  if (receipt.status === "reverted") {
    try {
      await fork.publicClient.call({ account: from, to, data, value, gasPrice: 0n });
    } catch {
      return receipt;
    }
    return send();
  }
  return receipt;
}

/** Sends a `Fiat24Call` from `from`. */
export async function sendCall(
  fork: Fork,
  from: Address,
  call: Fiat24Call,
): Promise<TransactionReceipt> {
  return sendAs(fork, from, call.to, call.data, call.value);
}

/** `sendCall` that asserts success and returns the receipt — keeps conditionals out of tests. */
export async function sendOk(
  fork: Fork,
  from: Address,
  call: Fiat24Call,
): Promise<TransactionReceipt> {
  const receipt = await sendCall(fork, from, call);
  expectSuccess(receipt);
  return receipt;
}

/** Asserts the receipt status — the success pattern every fork test repeats. */
export function expectSuccess(receipt: TransactionReceipt): void {
  expect(receipt.status).toBe("success");
}

function extractErrorData(body: unknown): Hex | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return undefined;
  }
  const { error } = body;
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return undefined;
  }
  const { data } = error;
  return typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data) ? (data as Hex) : undefined;
}

/**
 * `eth_call`s the call from `from` and maps the revert data through `decodeFiat24Revert` →
 * `revertCode` (§6.3). Throws `Error` (not a Fiat24Error) when the call does not revert.
 */
export async function revertCodeOf(
  fork: Fork,
  from: Address,
  call: Pick<Fiat24Call, "to" | "data" | "value">,
): Promise<Fiat24ErrorCode> {
  // eth_call still checks `balance >= gas*price + value`; fund the sender for payable calls.
  await fork.testClient.setBalance({ address: from, value: call.value + 10n ** 18n });
  const res = await fetch(fork.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { from, to: call.to, data: call.data, value: toHex(call.value), gasPrice: "0x0" },
        "latest",
      ],
    }),
  });
  const data = extractErrorData(await res.json());
  if (data === undefined) {
    throw new Error("expected eth_call to revert with data");
  }
  return revertCode(decodeFiat24Revert(data));
}

/** Decodes a receipt's logs through the SDK (§7.1). */
export function decoded(receipt: { logs: ReadonlyArray<RawLog> }): ReadonlyArray<Fiat24Event> {
  return decodeFiat24Logs(receipt.logs);
}

/** The decoded events of `kind` from `events`. */
export function eventsOfKind<K extends Fiat24Event["kind"]>(
  events: ReadonlyArray<Fiat24Event>,
  kind: K,
): Array<Extract<Fiat24Event, { kind: K }>> {
  return events.filter((event): event is Extract<Fiat24Event, { kind: K }> => event.kind === kind);
}

/** `ownerOf(tokenId)` on the account contract — the only source for Live owners. */
export async function ownerOf(fork: Fork, tokenId: bigint): Promise<Address> {
  return fork.publicClient.readContract({
    address: arbitrum.account.proxy,
    abi: accountAbi,
    functionName: "ownerOf",
    args: [tokenId],
  });
}

export async function paused(fork: Fork, contract: Address): Promise<boolean> {
  return fork.publicClient.readContract({
    address: contract,
    abi: tokenAbi,
    functionName: "paused",
  });
}

/** Role-holder set-up calls (SPEC §11.2 table): all impersonate OPERATOR. */
export async function pause(fork: Fork, contract: Address): Promise<TransactionReceipt> {
  return sendAs(
    fork,
    OPERATOR,
    contract,
    encodeFunctionData({ abi: PAUSE_ABI, functionName: "pause" }),
  );
}

export async function unpause(fork: Fork, contract: Address): Promise<TransactionReceipt> {
  return sendAs(
    fork,
    OPERATOR,
    contract,
    encodeFunctionData({ abi: PAUSE_ABI, functionName: "unpause" }),
  );
}

export async function setClientLimit(
  fork: Fork,
  tokenId: bigint,
  limit: bigint,
): Promise<TransactionReceipt> {
  return sendAs(
    fork,
    OPERATOR,
    arbitrum.account.proxy,
    encodeFunctionData({
      abi: accountAbi,
      functionName: "setClientLimit",
      args: [tokenId, limit],
    }),
  );
}

/**
 * OPERATOR `changeClientStatus(tokenId, status)` — Fiat24AccountStatus ordinals (1 SoftBlocked, 3
 * Blocked).
 */
export async function changeClientStatus(
  fork: Fork,
  tokenId: bigint,
  status: number,
): Promise<TransactionReceipt> {
  return sendAs(
    fork,
    OPERATOR,
    arbitrum.account.proxy,
    encodeFunctionData({
      abi: accountAbi,
      functionName: "changeClientStatus",
      args: [tokenId, status],
    }),
  );
}

/** Plain ERC-20 funding transfer impersonating `holder` (found by chain reads — see DESK). */
export async function fund(
  fork: Fork,
  token: Address,
  holder: Address,
  to: Address,
  amount: bigint,
): Promise<TransactionReceipt> {
  return sendAs(
    fork,
    holder,
    token,
    encodeFunctionData({
      abi: USDC_ACTIONS,
      functionName: "transfer",
      args: [to, amount],
    }),
  );
}

/**
 * Mints USDC to `to` via the FiatToken minter path: impersonate `masterMinter()` (read at the fork
 * block) to configure `to` as a minter, then `mint(to, amount)`.
 */
export async function mintUsdc(fork: Fork, to: Address, amount: bigint): Promise<void> {
  await sendAs(
    fork,
    USDC_MASTER_MINTER,
    arbitrum.usdc,
    encodeFunctionData({
      abi: USDC_ACTIONS,
      functionName: "configureMinter",
      args: [to, amount],
    }),
  );
  await sendAs(
    fork,
    to,
    arbitrum.usdc,
    encodeFunctionData({ abi: USDC_ACTIONS, functionName: "mint", args: [to, amount] }),
  );
}

/** The §8.3 mint price in wei: `quote < price ? (price/quote)·10^18 : 10^18/(quote/price)`. */
export async function mintPriceWei(fork: Fork, tokenId: bigint): Promise<bigint> {
  const price = await fork.publicClient.readContract({
    address: arbitrum.priceList.proxy,
    abi: priceListAbi,
    functionName: "getPrice",
    args: [tokenId],
  });
  const quote = await fork.publicClient.readContract({
    address: arbitrum.f24Sales.proxy,
    abi: F24_SALES_ABI,
    functionName: "quotePerEther",
  });
  return quote < price ? (price / quote) * 10n ** 18n : 10n ** 18n / (quote / price);
}

/** The §8.3 exact-out required input: `amount·rate/10000·spread/10000` left to right. */
export async function exactOutInput(
  fork: Fork,
  inputToken: Address,
  outputToken: Address,
  outputAmount: bigint,
): Promise<bigint> {
  const rate = await fork.publicClient.readContract({
    address: arbitrum.deposit.proxy,
    abi: depositAbi,
    functionName: "getExchangeRate",
    args: [outputToken, inputToken],
  });
  const spread = await fork.publicClient.readContract({
    address: arbitrum.deposit.proxy,
    abi: depositAbi,
    functionName: "getSpread",
    args: [outputToken, inputToken, true],
  });
  // SPEC §8.3 evaluates strictly left to right with floor division.
  return (((outputAmount * rate) / 10000n) * spread) / 10000n;
}

export async function minimalPayout(fork: Fork, token: Address): Promise<bigint> {
  return fork.publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "minimalPayoutAmount",
  });
}

/** A cast uintN reply → bigint; cast 1.10 decorates numbers as `98692 [9.869e4]`. */
export function castUint(text: string): bigint {
  return BigInt(text.replaceAll(/\[[^\]]*\]/g, "").trim());
}

/** `cast` as a promise — `util.promisify` trips `strict-void-return` on execFile's overloads. */
export async function runCast(args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("cast", args, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`cast ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
      }
    });
  });
}

/**
 * `cast call` against the fork — the independent oracle (SPEC §11.2) for every chain read: Foundry,
 * not viem and not the SDK. `block` pins the read (`FORK_BLOCK` or a decimal string / `"latest"`);
 * pass the current head once local transactions have mined.
 */
export async function castCall(
  fork: Fork,
  args: ReadonlyArray<string>,
  block = "latest",
  from?: Address,
): Promise<string> {
  const fromArgs = from === undefined ? [] : ["--from", from];
  return runCast(["call", "--rpc-url", fork.url, "--block", block, ...fromArgs, ...args]);
}

/** `cast storage` against the fork at `block` — the oracle for every storage-level check. */
export async function castStorage(
  fork: Fork,
  address: Address,
  slot: string,
  block = "latest",
): Promise<string> {
  return runCast(["storage", "--rpc-url", fork.url, "--block", block, address, slot]);
}

/** `cast block <block> --field timestamp` — the oracle for the snapshot block's timestamp. */
export async function castTimestamp(fork: Fork, block = "latest"): Promise<bigint> {
  const stdout = await runCast(["block", block, "--field", "timestamp", "--rpc-url", fork.url]);
  return BigInt(stdout.trim());
}

/**
 * A `Fiat24Signer` on the fork: impersonates `owner` and broadcasts each request through
 * `walletClient.sendTransaction` with exactly the request's `nonce` (I21 — the SDK asks, the signer
 * sends; the chain id must be 42161 and the nonce is asserted by the caller via `requests`).
 * `behaviour` models the §4 failure modes without a real wallet.
 */
export type ForkSignerBehaviour =
  | { readonly kind: "normal" }
  // Throws Fiat24Error("signer-rejected") before anything is broadcast (user declined).
  | { readonly kind: "reject" }
  // Throws a non-rejection error before broadcasting — the crash-between-persist-and-send case.
  | { readonly kind: "throw-before-send" }
  // Broadcasts (the tx will mine) and then throws — outcome genuinely unknown to the caller.
  | { readonly kind: "broadcast-then-throw" }
  // Runs `hook` (e.g. a robot rate update) immediately before broadcasting.
  | { readonly kind: "before"; readonly hook: () => Promise<void> };

const NORMAL: ForkSignerBehaviour = { kind: "normal" };
const SESSION_SIGNATURE = Promise.resolve<Hex>(`0x${"ab".repeat(65)}`);

export function forkSigner(
  fork: Fork,
  owner: Address,
  behaviour: ForkSignerBehaviour = NORMAL,
): {
  readonly signer: {
    readonly address: Address;
    readonly sendTransaction: (request: Fiat24TransactionRequest) => Promise<Hex>;
    readonly signSessionGrant: () => Promise<Hex>;
  };
  readonly requests: Fiat24TransactionRequest[];
  readonly broadcasts: Hex[];
} {
  const requests: Fiat24TransactionRequest[] = [];
  const broadcasts: Hex[] = [];
  const broadcast = async (request: Fiat24TransactionRequest): Promise<Hex> => {
    await fork.testClient.impersonateAccount({ address: owner });
    await fork.testClient.setBalance({ address: owner, value: 10n ** 18n });
    const hash = await fork.walletClient.sendTransaction({
      account: owner,
      chain: arbitrumChain,
      to: request.to,
      data: request.data,
      value: request.value,
      nonce: request.nonce,
      // Explicit gas: viem otherwise runs eth_estimateGas, which refuses to send a tx it knows
      // will revert — some tests deliberately send reverting txs to prove the receipt path.
      gas: 3_000_000n,
    });
    broadcasts.push(hash);
    return hash;
  };
  return {
    requests,
    broadcasts,
    signer: {
      address: owner,
      sendTransaction: async (request: Fiat24TransactionRequest): Promise<Hex> => {
        requests.push(request);
        if (behaviour.kind === "reject") {
          throw new Fiat24Error("signer-rejected", "signer rejected");
        }
        if (behaviour.kind === "throw-before-send") {
          throw new Error("signer crashed before broadcasting");
        }
        if (behaviour.kind === "broadcast-then-throw") {
          await broadcast(request);
          throw new Error("signer crashed after broadcasting");
        }
        if (behaviour.kind === "before") {
          await behaviour.hook();
        }
        return broadcast(request);
      },
      // Flow tests inject fake sessions; the grant hook is a Fiat24Signer member nonetheless.
      signSessionGrant: async () => SESSION_SIGNATURE,
    },
  };
}
