import { zeroAddress } from "viem";
import type { Address, Hash, Hex } from "viem";

import { tokenAbi } from "../../src/abi/index.ts";
import { topic0Of } from "../../src/chain/context.ts";
import type { Fiat24Signer, Fiat24TransactionRequest } from "../../src/core/signer.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import type { FlowDeps, FlowState } from "../../src/flows/types.ts";
import { B, makeStub, OWNER, RECIPIENT, wordWithAddress } from "../chain/stub.ts";
import type { CallEntry, CallTable, RecordedRequest, Stub } from "../chain/stub.ts";

export { B, B_HEX, OWNER, RECIPIENT, wordWithAddress } from "../chain/stub.ts";

export const SENDER_ID = 350273n;
export const RECEIVER_ID = 402001n;
export const AMOUNT = 100n;
export const TXID_1: Hash = `0x${"11".repeat(32)}`;
export const TXID_2: Hash = `0x${"22".repeat(32)}`;

const ACCOUNT = C.account.proxy;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;
const PRICELIST_SLOT = "0x167" as Hex;
const F24_SLOT = "0x166" as Hex;
const F24SALES_SLOT = "0x16c" as Hex;
const USDC_SLOT = "0xd0" as Hex;
const ZERO_WORD: Hex = `0x${"0".repeat(64)}`;

export function word(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function addressTopic(address: Address): Hex {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

/** The honest deployment table (impl+admin pins plus the account/deposit wiring slots). */
export function honestStorage(): Map<string, Hex> {
  const table = new Map<string, Hex>();
  for (const pin of [
    C.account,
    C.tokens.USD24,
    C.tokens.EUR24,
    C.tokens.CHF24,
    C.tokens.CNH24,
    C.deposit,
    C.card,
    C.priceList,
    C.f24Sales,
  ]) {
    table.set(`${pin.proxy.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(pin.implementation));
    table.set(`${pin.proxy.toLowerCase()}:${ADMIN_SLOT}`, wordWithAddress(pin.admin));
  }
  const priceList = C.priceList.proxy.toLowerCase().slice(2);
  table.set(
    `${ACCOUNT.toLowerCase()}:${PRICELIST_SLOT}`,
    `0x${"0".repeat(22)}01${priceList}` as Hex,
  );
  const f24 = C.f24.address.toLowerCase().slice(2);
  table.set(`${ACCOUNT.toLowerCase()}:${F24_SLOT}`, `0x${"0".repeat(20)}${f24}0600` as Hex);
  table.set(`${ACCOUNT.toLowerCase()}:${F24SALES_SLOT}`, wordWithAddress(C.f24Sales.proxy));
  table.set(`${C.deposit.proxy.toLowerCase()}:${USDC_SLOT}`, wordWithAddress(C.usdc));
  return table;
}

function push(table: Map<string, CallEntry[]>, key: string, entry: CallEntry): void {
  const prev = table.get(key);
  if (prev === undefined) {
    table.set(key, [entry]);
  } else {
    prev.push(entry);
  }
}

export function mergeCalls(...tables: Array<Map<string, CallEntry[]>>): Map<string, CallEntry[]> {
  const out = new Map<string, CallEntry[]>();
  for (const table of tables) {
    for (const [key, entries] of table) {
      const prev = out.get(key);
      if (prev === undefined) {
        out.set(key, [...entries]);
      } else {
        prev.push(...entries);
      }
    }
  }
  return out;
}

/**
 * Merges two parties' call tables in _request_ order: resolveAccount resolves both parties
 * concurrently, so per-key calls arrive `a1, b1, a2, b2, …`. The stub's args-mismatch refusal means
 * queues must match that order exactly.
 */
export function interleaveCalls(
  a: Map<string, CallEntry[]>,
  b: Map<string, CallEntry[]>,
): Map<string, CallEntry[]> {
  const out = new Map<string, CallEntry[]>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const ae = a.get(key) ?? [];
    const be = b.get(key) ?? [];
    const merged: CallEntry[] = [];
    for (let i = 0; i < Math.max(ae.length, be.length); i++) {
      const av = ae[i];
      const bv = be[i];
      if (av !== undefined) {
        merged.push(av);
      }
      if (bv !== undefined) {
        merged.push(bv);
      }
    }
    out.set(key, merged);
  }
  return out;
}

export type PartyOpts = {
  readonly historic?: bigint;
  readonly balance?: bigint;
  readonly indexId?: bigint;
  readonly exists?: boolean;
  readonly statusIndex?: number;
  readonly owner?: Address;
};

/**
 * Entries for `resolveAccount`/`getAccount({owner})` in issue order: historicOwnership + balanceOf
 * concurrently, [tokenOfOwnerByIndex], exists, then the round
 * (status/limit/limitTourist/walletProvider + ownerOf/getApproved when the token exists). `rounds`
 * repeats every entry — a guard that re-runs at the send block resolves the same party again.
 */
const accountKey = (fn: string) => `${ACCOUNT.toLowerCase()}:${fn}`;

export function accountEntries(
  who: Address,
  opts: PartyOpts & { readonly rounds?: number } = {},
): Map<string, CallEntry[]> {
  const entries = new Map<string, CallEntry[]>();
  const key = accountKey;
  const historic = opts.historic ?? SENDER_ID;
  const balance = opts.balance ?? 1n;
  const readId = historic === 0n ? (opts.indexId ?? 0n) : historic;
  const exists = opts.exists ?? true;
  const rounds = opts.rounds ?? 1;

  push(entries, key("historicOwnership"), { args: [who], answer: { result: historic } });
  push(entries, key("balanceOf"), { args: [who], answer: { result: balance } });
  if (historic === 0n && balance === 0n) {
    return entries;
  }
  if (historic === 0n) {
    push(entries, key("tokenOfOwnerByIndex"), { args: [who, 0n], answer: { result: readId } });
  }
  push(entries, key("exists"), { args: [readId], answer: { result: exists } });
  push(entries, key("status"), { args: [readId], answer: { result: opts.statusIndex ?? 5 } });
  push(entries, key("limit"), { args: [readId], answer: { result: [0n, 10_000n, 0n] } });
  push(entries, key("limitTourist"), { answer: { result: 400n } });
  push(entries, key("walletProvider"), { args: [readId], answer: { result: 0n } });
  if (exists) {
    push(entries, key("ownerOf"), {
      args: [readId],
      answer: { result: opts.owner ?? who },
    });
    push(entries, key("getApproved"), { args: [readId], answer: { result: zeroAddress } });
  }
  // Sticky-tail queues make a single-entry answer repeat forever; for `rounds`
  // copies the last-but-one stays sticky too, so the queue serves at least
  // `rounds` calls. Extra entries are harmless — they are only consumed in order.
  for (const [key, list] of entries) {
    const repeated: CallEntry[] = [];
    for (const entry of list) {
      for (let i = 0; i < rounds; i++) {
        repeated.push(entry);
      }
    }
    entries.set(key, repeated);
  }
  return entries;
}

/** `balanceOf(owner)` on the four cash tokens (getBalances' round). */
export function balanceEntries(owner: Address, amount = 1000n): Map<string, CallEntry[]> {
  const entries = new Map<string, CallEntry[]>();
  for (const currency of ["USD24", "EUR24", "CHF24", "CNH24"] as const) {
    push(entries, `${C.tokens[currency].proxy.toLowerCase()}:balanceOf`, {
      args: [owner],
      answer: { result: amount },
    });
  }
  return entries;
}

/** GetAllowances' ten reads: per token card-then-deposit, then USDC and F24. */
export function allowanceEntries(owner: Address, amount = 0n): Map<string, CallEntry[]> {
  const entries = new Map<string, CallEntry[]>();
  for (const currency of ["USD24", "EUR24", "CHF24", "CNH24"] as const) {
    const key = `${C.tokens[currency].proxy.toLowerCase()}:allowance`;
    entries.set(key, [
      { args: [owner, C.card.proxy], answer: { result: amount } },
      { args: [owner, C.deposit.proxy], answer: { result: amount } },
    ]);
  }
  push(entries, `${C.usdc.toLowerCase()}:allowance`, {
    args: [owner, C.deposit.proxy],
    answer: { result: amount },
  });
  push(entries, `${C.f24.address.toLowerCase()}:allowance`, {
    args: [owner, C.account.proxy],
    answer: { result: amount },
  });
  return entries;
}

const PAUSED_TARGETS: ReadonlyArray<Address> = [
  C.account.proxy,
  C.tokens.USD24.proxy,
  C.tokens.EUR24.proxy,
  C.tokens.CHF24.proxy,
  C.tokens.CNH24.proxy,
  C.deposit.proxy,
  C.card.proxy,
  C.f24Sales.proxy,
];

/** The getAvailability round; `paused` is per-contract, the rest shared. */
export function availabilityEntries(
  opts: {
    readonly paused?: Readonly<Record<string, boolean>> | boolean;
    readonly maxDigitForSale?: number | undefined;
  } = {},
): Map<string, CallEntry[]> {
  const entries = new Map<string, CallEntry[]>();
  for (const target of PAUSED_TARGETS) {
    const paused =
      typeof opts.paused === "boolean"
        ? opts.paused
        : (opts.paused?.[target.toLowerCase()] ?? false);
    push(entries, `${target.toLowerCase()}:paused`, { answer: { result: paused } });
  }
  push(entries, `${C.deposit.proxy.toLowerCase()}:marketClosed`, { answer: { result: false } });
  push(entries, `${ACCOUNT.toLowerCase()}:maxDigitForSale`, {
    answer: { result: opts.maxDigitForSale ?? 6 },
  });
  return entries;
}

/** `eth_call` requests other than the ProxyAdmin.owner probe — i.e. guard/plan reads. */
export function guardCalls(stub: Stub): RecordedRequest[] {
  return stub.requests.filter(
    (r) =>
      r.method === "eth_call" &&
      (r.params as ReadonlyArray<{ to?: Address }>)[0]?.to !== C.proxyAdmin.address,
  );
}

/** The proxyAdmin.owner read every deployment check performs. */
export function proxyAdminEntry(): Map<string, CallEntry[]> {
  return new Map([
    [`${C.proxyAdmin.address.toLowerCase()}:owner`, [{ answer: { result: C.proxyAdmin.owner } }]],
  ]);
}

/** A full `eth_getTransactionByHash` payload (legacy type). */
export function txPayload(args: {
  readonly hash: Hash;
  readonly from: Address;
  readonly to: Address;
  readonly input: Hex;
  readonly value: bigint;
  readonly nonce: number;
  readonly blockNumber?: bigint;
  readonly pending?: boolean;
}): Record<string, unknown> {
  const mined = args.pending !== true;
  return {
    type: "0x0",
    hash: args.hash,
    nonce: `0x${args.nonce.toString(16)}`,
    blockHash: mined ? ZERO_WORD : ZERO_WORD,
    blockNumber: mined ? `0x${(args.blockNumber ?? B).toString(16)}` : null,
    transactionIndex: mined ? "0x0" : null,
    from: args.from,
    to: args.to,
    value: `0x${args.value.toString(16)}`,
    gas: "0x5208",
    gasPrice: "0x1",
    input: args.input,
    v: "0x1b",
    r: ZERO_WORD,
    s: ZERO_WORD,
  };
}

/** A raw eth_getLogs/receipt log entry. */
export function logPayload(args: {
  readonly address: Address;
  readonly topics: ReadonlyArray<Hex>;
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
  readonly logIndex?: number;
}): Record<string, unknown> {
  return {
    address: args.address,
    topics: [...args.topics],
    data: args.data,
    blockNumber: `0x${args.blockNumber.toString(16)}`,
    transactionHash: args.transactionHash,
    transactionIndex: "0x0",
    blockHash: ZERO_WORD,
    logIndex: `0x${(args.logIndex ?? 0).toString(16)}`,
    removed: false,
  };
}

/** `Transfer(from, to, amount)` on a cash-token proxy. */
export function transferLog(args: {
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
  readonly logIndex?: number;
}): Record<string, unknown> {
  return logPayload({
    address: args.token,
    topics: [topic0Of(tokenAbi, "Transfer"), addressTopic(args.from), addressTopic(args.to)],
    data: word(args.amount),
    blockNumber: args.blockNumber,
    transactionHash: args.transactionHash,
    logIndex: args.logIndex ?? 0,
  });
}

/** A full `eth_getTransactionReceipt` payload. */
export function receiptPayload(args: {
  readonly transactionHash: Hash;
  readonly blockNumber: bigint;
  readonly status: "success" | "reverted";
  readonly from?: Address;
  readonly to?: Address;
  readonly logs?: ReadonlyArray<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    transactionHash: args.transactionHash,
    transactionIndex: "0x0",
    blockHash: ZERO_WORD,
    blockNumber: `0x${args.blockNumber.toString(16)}`,
    from: args.from ?? OWNER,
    to: args.to ?? RECIPIENT,
    cumulativeGasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    gasUsed: "0x5208",
    contractAddress: null,
    logs: [...(args.logs ?? [])],
    logsBloom: `0x${"0".repeat(512)}`,
    status: args.status === "success" ? "0x1" : "0x0",
    type: "0x0",
  };
}

/**
 * The call table a EUR24 transfer's guard consumes per round: checkTransfer's two resolutions +
 * balance/verdict reads, the availability round, the proxyAdmin.owner read, and the simulate
 * `transfer` call.
 */
export function transferCallTable(
  opts: {
    readonly rounds?: number;
    readonly amount?: bigint;
    readonly recipient?: Address;
    readonly sender?: Address;
    readonly balance?: bigint;
    readonly transferAnswer?: CallEntry["answer"];
    readonly allowed?: boolean;
    readonly paused?: Readonly<Record<string, boolean>> | boolean;
    readonly receiver?: PartyOpts;
  } = {},
): Map<string, CallEntry[]> {
  const rounds = opts.rounds ?? 1;
  const amount = opts.amount ?? AMOUNT;
  const recipient = opts.recipient ?? RECIPIENT;
  const sender = opts.sender ?? OWNER;
  const token = C.tokens.EUR24.proxy;
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false }),
    interleaveCalls(
      accountEntries(sender, { rounds }),
      accountEntries(recipient, { historic: RECEIVER_ID, rounds, ...opts.receiver }),
    ),
    balanceEntries(sender),
    new Map<string, CallEntry[]>([
      [
        `${token.toLowerCase()}:tokenTransferAllowed`,
        [{ args: [sender, recipient, amount], answer: { result: opts.allowed ?? true } }],
      ],
      [`${token.toLowerCase()}:convertToChf`, [{ args: [amount], answer: { result: amount } }]],
      [
        `${ACCOUNT.toLowerCase()}:checkLimit`,
        [{ args: [SENDER_ID, amount], answer: { result: true } }],
      ],
      [
        `${token.toLowerCase()}:transfer`,
        [
          {
            args: [recipient, amount],
            answer: opts.transferAnswer ?? { result: true },
          },
        ],
      ],
    ]),
  );
  if (opts.balance !== undefined) {
    table.set(`${token.toLowerCase()}:balanceOf`, [
      { args: [sender], answer: { result: opts.balance } },
    ]);
  }
  return table;
}

export type FlowStub = Stub & {
  readonly persisted: FlowState[];
  readonly signerRequests: Fiat24TransactionRequest[];
  readonly deps: FlowDeps;
};

/**
 * Chain stub + the tx-pool methods flows need (`eth_getTransactionCount`,
 * `eth_getTransactionReceipt`, `eth_getTransactionByHash`); `eth_getLogs` stays on `makeStub`'s
 * `logs` option. `count.pending` answers the `"pending"` tag (the nonce the flow takes);
 * `count.latest` answers every other tag (the reconcile ledger).
 */
export function makeFlowStub(options: {
  readonly blockNumber?: bigint;
  readonly timestamp?: bigint;
  readonly calls?: CallTable;
  readonly storage?: ReadonlyMap<string, Hex>;
  readonly logs?: (filter: Record<string, unknown>) => unknown;
  readonly count?: { readonly pending?: number; readonly latest?: number };
  readonly receipts?: Readonly<Record<string, unknown>>;
  readonly transactions?: Readonly<Record<string, unknown>>;
  readonly onRequest?: (method: string, params: unknown) => unknown;
}): Stub {
  return makeStub({
    blockNumber: options.blockNumber ?? B,
    timestamp: options.timestamp ?? 1_700_000_000n,
    ...(options.calls === undefined ? {} : { calls: options.calls }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.logs === undefined ? {} : { logs: options.logs }),
    onRequest: (method, params) => {
      const custom = options.onRequest?.(method, params);
      if (custom !== undefined) {
        return custom;
      }
      if (method === "eth_getTransactionCount") {
        const [, tag] = params as [Address, string];
        const count =
          tag === "pending" ? (options.count?.pending ?? 0) : (options.count?.latest ?? 0);
        return `0x${count.toString(16)}`;
      }
      if (method === "eth_getTransactionReceipt") {
        const [hash] = params as [Hash];
        return options.receipts?.[hash.toLowerCase()] ?? null;
      }
      if (method === "eth_getTransactionByHash") {
        const [hash] = params as [Hash];
        return options.transactions?.[hash.toLowerCase()] ?? null;
      }
      return undefined;
    },
  });
}

const SESSION_SIGNATURE = Promise.resolve<Hex>(`0x${"ab".repeat(65)}`);

export function makeSigner(
  address: Address,
  send?: (request: Fiat24TransactionRequest) => Promise<Hash> | Hash,
): { signer: Fiat24Signer; requests: Fiat24TransactionRequest[] } {
  const requests: Fiat24TransactionRequest[] = [];
  return {
    requests,
    signer: {
      address,
      sendTransaction: async (request) => {
        requests.push(request);
        if (send === undefined) {
          return TXID_1;
        }
        return send(request);
      },
      signSessionGrant: async () => SESSION_SIGNATURE,
    },
  };
}

/** FlowDeps wired to the stub; persisted states are collected in order. */
export function flowDeps(
  client: Stub["client"],
  opts: {
    readonly signer?: Fiat24Signer;
    readonly persist?: (state: FlowState) => Promise<void> | void;
  } = {},
): {
  readonly deps: FlowDeps;
  readonly persisted: FlowState[];
} {
  const persisted: FlowState[] = [];
  const persist = async (state: FlowState): Promise<void> => {
    persisted.push(state);
    await opts.persist?.(state);
  };
  return {
    persisted,
    deps: {
      client,
      signer: opts.signer ?? makeSigner(OWNER).signer,
      persist,
    },
  };
}
