import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  stringToBytes,
  toEventSelector,
} from "viem";
import type { Abi, AbiEvent, Address, Hex } from "viem";

import { accountAbi, cardAbi, depositAbi, tokenAbi } from "../abi/index.ts";
import { Fiat24Error } from "../core/errors.ts";
import { CHAIN_ID, CURRENCIES } from "../core/types.ts";
import type { Currency } from "../core/types.ts";
import { arbitrum } from "../deployments/data.ts";
import { contractOf } from "../deployments/deployment.ts";
import type { Deployment } from "../deployments/deployment.ts";
import type { Fiat24Event, RawLog } from "./types.ts";

const MAX_STRING_BYTES = 1024;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const isWordTopic = (value: unknown): value is Hex =>
  typeof value === "string" && WORD_RE.test(value);

const malformedError = (): Fiat24Error => new Fiat24Error("malformed-log", "malformed log");

const malformed = (): never => {
  throw malformedError();
};

type Group = "tokens" | "deposit" | "card" | "account";

/**
 * Event names in the §7.1 table per group; an ABI event outside this list (roles, Paused,
 * CashLocked, ExchangeRatesUpdated*, Upgraded, …) decodes successfully but is not ours, and a
 * contract name outside the decoded set (f24, priceList, f24Sales) keeps every topic0 unlisted.
 */
const WANTED: Readonly<Record<Group, ReadonlySet<string>>> = {
  tokens: new Set([
    "Transfer",
    "Approval",
    "ClientPayout",
    "ClientPayoutRef",
    "CashDeposit",
    "CashDepositNOK",
    "CashPayout",
  ]),
  deposit: new Set([
    "MoneyExchangedExactIn",
    "MoneyExchangedExactOut",
    "DepositedTokenViaUsd",
    "DepositedEth",
    "DepositedTokenViaEth",
    "DepositedByWallet",
  ]),
  card: new Set(["Authorized", "Incremented", "Adviced", "Reversed"]),
  account: new Set(["Transfer"]),
};

const GROUP_ABI: Readonly<Record<Group, Abi>> = {
  tokens: tokenAbi,
  deposit: depositAbi,
  card: cardAbi,
  account: accountAbi,
};

/**
 * The §7.1 decode key `(address, topic0)` per group: only wanted events get a selector slot, so a
 * known address with any other topic0 — including ABI events like `Paused` or `CashLocked`, however
 * malformed — is "not ours" and returns `undefined` without decoding.
 */
const TOPIC_EVENTS: Readonly<Record<Group, ReadonlyMap<string, AbiEvent>>> =
  /* @__PURE__ */ (() => {
    const out: Record<Group, Map<string, AbiEvent>> = {
      tokens: new Map(),
      deposit: new Map(),
      card: new Map(),
      account: new Map(),
    };
    for (const group of ["tokens", "deposit", "card", "account"] as const) {
      for (const entry of GROUP_ABI[group]) {
        if (entry.type === "event" && WANTED[group].has(entry.name)) {
          out[group].set(toEventSelector(entry), entry);
        }
      }
    }
    return out;
  })();

function isArgs(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// `Array.isArray` narrows `readonly T[]` to `any[]`; this keeps the declared element type.
const isReadonlyArray = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value);

// Indexed types we re-encode against their topic (all the decoded set's indexed params are
// address/uint256); dynamic indexed types hash into the topic and are covered by the data check.
const STATIC_INDEXED = /^(address|bool|u?int[0-9]*|bytes[0-9]+)$/;

/**
 * Canonical-encoding proof (§3.5/§7.1): the non-indexed `data` must be exactly what viem would
 * encode for the decoded values — byte for byte — and every static indexed topic must equal the
 * encoding of the decoded value, which catches dirty high bytes in address topics. Any decoded
 * string may not exceed 1024 UTF-8 bytes.
 */
function checkCanonical(event: AbiEvent, args: Record<string, unknown>, log: RawLog): void {
  const nonIndexed = event.inputs.filter((input) => input.indexed !== true);
  const encoded = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((input) => (input.name === undefined ? malformed() : args[input.name])),
  );
  if (encoded.toLowerCase() !== log.data.toLowerCase()) {
    throw malformedError();
  }
  const indexed = event.inputs.filter((input) => input.indexed === true);
  if (log.topics.length !== 1 + indexed.length) {
    throw malformedError();
  }
  for (const [position, input] of indexed.entries()) {
    const topic = log.topics[1 + position];
    if (topic === undefined || topic.length !== 66) {
      throw malformedError();
    }
    if (
      STATIC_INDEXED.test(input.type) &&
      encodeAbiParameters(
        [input],
        [input.name === undefined ? undefined : args[input.name]],
      ).toLowerCase() !== topic.toLowerCase()
    ) {
      throw malformedError();
    }
  }
  for (const value of Object.values(args)) {
    if (typeof value === "string" && stringToBytes(value).length > MAX_STRING_BYTES) {
      throw malformedError();
    }
  }
}

function currencyOf(deployment: Deployment, address: Address): Currency | undefined {
  const needle = address.toLowerCase();
  return CURRENCIES.find((name) => deployment.tokens[name].proxy.toLowerCase() === needle);
}

type Args = Record<string, unknown>;
const bigintArg = (args: Args, name: string): bigint => {
  const value = args[name];
  return typeof value === "bigint" ? value : malformed();
};
const stringArg = (args: Args, name: string): string => {
  const value = args[name];
  return typeof value === "string" ? value : malformed();
};
const addressArg = (args: Args, name: string): Address => {
  const value = args[name];
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? getAddress(value)
    : malformed();
};

type DistOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type Fields = DistOmit<Fiat24Event, "address" | "blockNumber" | "transactionHash" | "logIndex">;

// Field mapping is written from the ABI inputs plus the emitting source lines:
// Fiat24Token.sol events :40-45, emitted :96 (CashDeposit), :106 (CashDepositNOK),
// :115 (CashPayout OK), :124 (CashPayout NOK), :137 (ClientPayout), :145 (ClientPayoutRef).
function mapToken(currency: Currency, eventName: string, args: Args): Fields | undefined {
  switch (eventName) {
    case "Transfer":
      return {
        kind: "transfer",
        currency,
        from: addressArg(args, "from"),
        to: addressArg(args, "to"),
        amount: bigintArg(args, "value"),
      };
    case "Approval":
      return {
        kind: "approval",
        currency,
        owner: addressArg(args, "owner"),
        spender: addressArg(args, "spender"),
        amount: bigintArg(args, "value"),
      };
    case "ClientPayout":
      return {
        kind: "payout",
        currency,
        tokenId: bigintArg(args, "tokenId"),
        sender: addressArg(args, "sender"),
        payoutAccount: bigintArg(args, "payoutAccount"),
        amount: bigintArg(args, "amount"),
        contactId: stringArg(args, "contactId"),
        txid: stringArg(args, "txid"),
      };
    case "ClientPayoutRef":
      return {
        kind: "payout-ref",
        currency,
        tokenId: bigintArg(args, "tokenId"),
        sender: addressArg(args, "sender"),
        payoutAccount: bigintArg(args, "payoutAccount"),
        amount: bigintArg(args, "amount"),
        contactId: stringArg(args, "contactId"),
        txid: stringArg(args, "txid"),
        purposeId: bigintArg(args, "purposeId"),
        ref: stringArg(args, "ref"),
      };
    // CashDeposit emits recipientAccountId twice (Fiat24Token.sol:96); §7.1 drops
    // exaccId/bankId/trxId. tokenId = recipientAccountId, recipient = recipientAddress.
    case "CashDeposit":
      return {
        kind: "cash-deposit",
        currency,
        tokenId: bigintArg(args, "recipientAccountId"),
        recipient: addressArg(args, "recipientAddress"),
        depositAccount: bigintArg(args, "depositAccount"),
      };
    // CashDepositNOK hard-codes depositAccount 9103 (Fiat24Token.sol:100-107); strings dropped.
    case "CashDepositNOK":
      return {
        kind: "cash-deposit-rejected",
        currency,
        tokenId: bigintArg(args, "recipientAccountId"),
        depositAccount: bigintArg(args, "depositAccount"),
      };
    // CashPayout: bankId/trxId come through (§7.1); 9104 = cashPayoutOK settled,
    // 9103 = cashPayoutNOK rejected (Fiat24Token.sol:109-125), anything else unknown.
    case "CashPayout": {
      const payoutAccount = bigintArg(args, "payoutAccount");
      return {
        kind: "cash-payout",
        currency,
        tokenId: bigintArg(args, "senderAccountId"),
        sender: addressArg(args, "senderAddress"),
        payoutAccount,
        settlement:
          payoutAccount === 9104n ? "settled" : payoutAccount === 9103n ? "rejected" : "unknown",
        bankId: stringArg(args, "bankId"),
        trxId: stringArg(args, "trxId"),
      };
    }
    default:
      return undefined;
  }
}

// Fiat24CryptoDeposit.sol events :95-100, emitted :204 (DepositedEth), :263
// (DepositedTokenViaUsd), :336 (DepositedTokenViaEth), :359 (DepositedByWallet), :379
// (MoneyExchangedExactIn), :398 (MoneyExchangedExactOut). Token addresses map to Currency only
// when they are one of the four pinned proxies (§7.1).
function mapDeposit(deployment: Deployment, eventName: string, args: Args): Fields | undefined {
  switch (eventName) {
    case "MoneyExchangedExactIn":
    case "MoneyExchangedExactOut": {
      const inputToken = addressArg(args, "inputToken");
      const outputToken = addressArg(args, "outputToken");
      const input = currencyOf(deployment, inputToken);
      const output = currencyOf(deployment, outputToken);
      return {
        kind: "exchange",
        side: eventName === "MoneyExchangedExactIn" ? "exact-in" : "exact-out",
        sender: addressArg(args, "sender"),
        inputToken,
        outputToken,
        // §7.1: the currency fields are absent (not undefined) for unpinned tokens.
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
        inputAmount: bigintArg(args, "inputAmount"),
        outputAmount: bigintArg(args, "outputAmount"),
      };
    }
    case "DepositedTokenViaUsd":
    case "DepositedEth":
    case "DepositedTokenViaEth": {
      const inputToken = addressArg(args, "inputToken");
      const outputToken = addressArg(args, "outputToken");
      const output = currencyOf(deployment, outputToken);
      return {
        kind: "top-up",
        via:
          eventName === "DepositedTokenViaUsd"
            ? "usdc"
            : eventName === "DepositedEth"
              ? "eth"
              : "token-via-eth",
        sender: addressArg(args, "sender"),
        inputToken,
        outputToken,
        ...(output === undefined ? {} : { output }),
        inputAmount: bigintArg(args, "inputAmount"),
        outputAmount: bigintArg(args, "outputAmount"),
      };
    }
    case "DepositedByWallet": {
      const outputToken = addressArg(args, "outputToken");
      const output = currencyOf(deployment, outputToken);
      return {
        kind: "top-up-by-wallet",
        tokenId: bigintArg(args, "tokenId"),
        client: addressArg(args, "clientAddress"),
        walletId: bigintArg(args, "walletId"),
        wallet: addressArg(args, "walletAddress"),
        outputToken,
        ...(output === undefined ? {} : { output }),
        usdcAmount: bigintArg(args, "usdcAmount"),
      };
    }
    default:
      return undefined;
  }
}

// Fiat24CardAuthorizationMarqeta.sol events :50-74, emitted :161,202,237,273. `cardCurrency`
// is the charged cash token's address; `paidAmount` is the amount. `currency` stays absent for
// unpinned token addresses (§7.1).
function mapCard(deployment: Deployment, eventName: string, args: Args): Fields | undefined {
  const token = addressArg(args, "cardCurrency");
  const currency = currencyOf(deployment, token);
  switch (eventName) {
    case "Authorized":
    case "Incremented":
      return {
        kind: eventName === "Authorized" ? "card-authorized" : "card-incremented",
        tokenId: bigintArg(args, "tokenId"),
        sender: addressArg(args, "sender"),
        cardId: stringArg(args, "cardId"),
        authorizationToken: stringArg(args, "authorizationToken"),
        token,
        ...(currency === undefined ? {} : { currency }),
        amount: bigintArg(args, "paidAmount"),
      };
    case "Adviced":
    case "Reversed":
      return {
        kind: eventName === "Adviced" ? "card-refund" : "card-reversal",
        tokenId: bigintArg(args, "tokenId"),
        sender: addressArg(args, "sender"),
        cardId: stringArg(args, "cardId"),
        adviceToken: stringArg(args, "adviceToken"),
        originalAuthorizationToken: stringArg(args, "originalAuthorizationToken"),
        token,
        ...(currency === undefined ? {} : { currency }),
        amount: bigintArg(args, "paidAmount"),
      };
    default:
      return undefined;
  }
}

// ERC-721 Transfer (all three params indexed) — the account NFT moving owner.
function mapAccount(eventName: string, args: Args): Fields | undefined {
  return eventName === "Transfer"
    ? {
        kind: "account-transfer",
        from: addressArg(args, "from"),
        to: addressArg(args, "to"),
        tokenId: bigintArg(args, "tokenId"),
      }
    : undefined;
}

/**
 * Decodes one raw log keyed by `(contractOf(deployment, log.address), topic0)` (§7.1): `undefined`
 * = not ours; a known pair whose topics count, ABI decoding, canonical encoding, 1024-byte string
 * cap or position fields are wrong ⇒ `malformed-log`. Viem errors never escape.
 */
export function decodeFiat24Log(
  log: RawLog,
  deployment: Deployment = arbitrum,
): Fiat24Event | undefined {
  if (deployment.chainId !== CHAIN_ID) {
    throw new Fiat24Error("unsupported-chain", "unsupported chain");
  }
  // A log is untrusted input: the fields we need just to place it must exist, else it is
  // simply not ours. Anything more specific that is malformed becomes malformed-log below.
  if (typeof log !== "object" || log === null) {
    return undefined;
  }
  const { address, topics } = log;
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    return undefined;
  }
  if (!isReadonlyArray(topics)) {
    return undefined;
  }
  const [topic0] = topics;
  if (typeof topic0 !== "string") {
    return undefined;
  }
  const contract = contractOf(deployment, address);
  if (contract === undefined) {
    return undefined;
  }
  const currency = CURRENCIES.find((name) => name === contract);
  const group: Group | undefined =
    currency === undefined
      ? contract === "deposit"
        ? "deposit"
        : contract === "card"
          ? "card"
          : contract === "account"
            ? "account"
            : undefined
      : "tokens";
  if (group === undefined) {
    return undefined;
  }
  const event = TOPIC_EVENTS[group].get(topic0.toLowerCase());
  if (event === undefined) {
    return undefined;
  }
  // A known (address, topic0) pair: every remaining field must be well formed.
  if (!topics.every(isWordTopic)) {
    throw malformedError();
  }
  const { data, blockNumber, transactionHash, logIndex } = log;
  if (typeof data !== "string" || !BYTES_RE.test(data)) {
    throw malformedError();
  }
  if (typeof blockNumber !== "bigint") {
    throw malformedError();
  }
  if (typeof transactionHash !== "string" || !WORD_RE.test(transactionHash)) {
    throw malformedError();
  }
  if (typeof logIndex !== "number" || !Number.isSafeInteger(logIndex) || logIndex < 0) {
    throw malformedError();
  }
  const decodeTopics: [Hex, ...Hex[]] = [topic0, ...topics.slice(1)];
  let decoded: { readonly args?: unknown };
  try {
    decoded = decodeEventLog({ abi: [event], topics: decodeTopics, data, strict: true });
  } catch {
    throw malformedError();
  }
  if (!isArgs(decoded.args)) {
    throw malformedError();
  }
  try {
    checkCanonical(event, decoded.args, log);
  } catch (error) {
    if (error instanceof Fiat24Error) {
      throw error;
    }
    throw malformedError();
  }
  const eventName = event.name;
  const fields =
    group === "tokens" && currency !== undefined
      ? mapToken(currency, eventName, decoded.args)
      : group === "deposit"
        ? mapDeposit(deployment, eventName, decoded.args)
        : group === "card"
          ? mapCard(deployment, eventName, decoded.args)
          : mapAccount(eventName, decoded.args);
  if (fields === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...fields,
    address: getAddress(address),
    blockNumber,
    transactionHash,
    logIndex,
  });
}

/** Map + drop `undefined`, preserving input order (§3.5). */
export function decodeFiat24Logs(
  logs: ReadonlyArray<RawLog>,
  deployment: Deployment = arbitrum,
): ReadonlyArray<Fiat24Event> {
  if (!isReadonlyArray(logs)) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const out: Fiat24Event[] = [];
  for (const log of logs) {
    const event = decodeFiat24Log(log, deployment);
    if (event !== undefined) {
      out.push(event);
    }
  }
  return out;
}
