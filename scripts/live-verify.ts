/**
 * Owner-run, read-only live verification of a real Fiat24 account: public chain reads, then the SDK
 * session-grant message signed on a Ledger (via `cast` or pasted from a wallet UI — the script
 * never touches a key), then exactly four allow-listed GETs against api.fiat24.com. The report
 * contains shapes and counts only — never values, never PII.
 *
 * Usage: `bun scripts/live-verify.ts --help`; see docs/live-verify.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { Address, Hash, Hex } from "viem";
import { createPublicClient, http, isAddress, sha256, stringToBytes, zeroAddress } from "viem";
import { getTransactionReceipt } from "viem/actions";
import { arbitrum } from "viem/chains";

import { createFiat24Api } from "../packages/fiat24/src/api/client.ts";
import {
  cardsSchema,
  profileSchema,
  timestampSchema,
  transactionsSchema,
} from "../packages/fiat24/src/api/schemas.ts";
import { createSecured } from "../packages/fiat24/src/api/secured.ts";
import type { SessionHeaders } from "../packages/fiat24/src/api/session.ts";
import { getAccount, getBalances, verifyDeployment } from "../packages/fiat24/src/chain/index.ts";
import { isFiat24Error } from "../packages/fiat24/src/core/errors.ts";
import { formatAmount } from "../packages/fiat24/src/core/money.ts";
import { isValidPayoutRef } from "../packages/fiat24/src/core/payout-grammar.ts";
import { CHAIN_ID, CURRENCIES } from "../packages/fiat24/src/core/types.ts";
import type { AccountStatus, Currency } from "../packages/fiat24/src/core/types.ts";
import { decodeFiat24Logs } from "../packages/fiat24/src/events/index.ts";
import type { RawLog } from "../packages/fiat24/src/events/index.ts";
import { guardFetch } from "./live-verify/guard.ts";
import { renderReport } from "./live-verify/report.ts";
import type { EndpointReport, PayoutRefSummary, ReportData } from "./live-verify/report.ts";
import { buildGrant, checkSignature, readOnlySession } from "./live-verify/session.ts";
import {
  collectKeys,
  describeShape,
  diffShape,
  profileAsExpected,
  schemaShape,
} from "./live-verify/shape.ts";
import type { ShapeProfile } from "./live-verify/shape.ts";
import { castSign, ledgerDisplay, ledgerPath, pasteSign } from "./live-verify/signer.ts";

const MAX_SKEW_MS = 300_000n;
const EXPIRY_MARGIN_SECONDS = 15n;
const TX_ID = /^0x[0-9a-fA-F]{64}$/;
const MAX_PAYOUT_TX = 25;

export type LoadedAccount = {
  readonly tokenId: bigint;
  readonly owner: Address;
  readonly ownsToken: boolean;
  readonly status: AccountStatus;
  readonly limit: { readonly max: bigint; readonly used: bigint };
  readonly balances: Readonly<Record<Currency, bigint>>;
  readonly blockNumber: bigint;
  readonly deploymentOk: boolean;
};

export type RunTarget = { readonly owner: Address } | { readonly tokenId: bigint };

export type FixtureName = "timestamp" | "br" | "cards" | "transactions";

export type RunDeps = {
  readonly fetch: typeof fetch;
  readonly load: (target: RunTarget) => Promise<LoadedAccount | undefined>;
  // One entry per hash: the receipt's logs, or `undefined` when the receipt is unreadable.
  readonly logsOf: (
    txHashes: ReadonlyArray<Hash>,
  ) => Promise<ReadonlyArray<ReadonlyArray<RawLog> | undefined>>;
  readonly sign: (args: {
    readonly message: string;
    readonly deadline: bigint;
    readonly owner: Address;
    readonly nowSeconds: () => bigint;
  }) => Promise<Hex>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly writeReport: (path: string, text: string) => Promise<void> | void;
  readonly fixture: (name: FixtureName) => unknown;
};

export type RunOptions = {
  readonly target: RunTarget;
  readonly ttl: bigint;
  readonly signerMode: "cast" | "paste";
  readonly dryRun: boolean;
  readonly out: string;
};

type Captured = { readonly status: number; readonly contentType: string; readonly text: string };

const contentTypeClass = (response: Response): string => {
  const value = response.headers.get("content-type");
  if (value === null) {
    return "none";
  }
  if (value.includes("json")) {
    return "json";
  }
  if (value.includes("text")) {
    return "text";
  }
  return "other";
};

const urlText = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const capture =
  (inner: typeof fetch, into: Map<string, Captured>): typeof fetch =>
  async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const response = await inner(input, init);
    const { pathname } = new URL(urlText(input));
    const text = await response.clone().text();
    into.set(pathname, {
      status: response.status,
      contentType: contentTypeClass(response),
      text,
    });
    return response;
  };

const tryJson = (text: string | undefined): unknown => {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const idOf = (value: unknown): bigint | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
};

// Up to MAX_PAYOUT_TX distinct hash32 txIds of entries whose `from` is our tokenId (O-3/O-9).
const collectTxIds = (body: unknown, tokenId: bigint): Hash[] => {
  if (!isRecord(body) || !Array.isArray(body["transactions"])) {
    return [];
  }
  const ids = new Set<string>();
  for (const entry of body["transactions"] as ReadonlyArray<unknown>) {
    if (!isRecord(entry)) {
      continue;
    }
    const { txId } = entry;
    if (idOf(entry["from"]) === tokenId && typeof txId === "string" && TX_ID.test(txId)) {
      ids.add(txId.toLowerCase());
    }
    if (ids.size >= MAX_PAYOUT_TX) {
      break;
    }
  }
  return [...ids] as Hash[];
};

const skewBucket = (absMs: bigint): string => {
  if (absMs < 1000n) {
    return "<1s";
  }
  if (absMs < 5000n) {
    return "1-5s";
  }
  if (absMs < 30_000n) {
    return "5-30s";
  }
  return "30-300s";
};

const outcomeOf = (error: unknown): string => (isFiat24Error(error) ? error.code : "error");

export async function run(options: RunOptions, deps: RunDeps): Promise<void> {
  const { log } = deps;
  let refusals = 0;
  const onRefuse = (): void => {
    refusals += 1;
  };
  const captured = new Map<string, Captured>();
  const wire = guardFetch(capture(deps.fetch, captured), onRefuse);

  // 1. Chain facts — printed to the terminal only, never to the report (except status + digit
  // count + deployment flag).
  const account = await deps.load(options.target);
  if (account === undefined) {
    throw new Error("no account found for the given owner/token id");
  }
  if ("owner" in options.target && !account.ownsToken) {
    throw new Error("the given owner does not hold the resolved token");
  }
  const { owner } = account;
  if (owner === zeroAddress) {
    throw new Error("account owner is the zero address");
  }
  log(`account token id: ${account.tokenId}`);
  log(`owner: ${owner}`);
  log(`status: ${account.status}`);
  log(
    `30-day limit: ${formatAmount("CHF24", account.limit.max)} (used ${formatAmount("CHF24", account.limit.used)})`,
  );
  for (const currency of CURRENCIES) {
    log(`balance ${currency}: ${formatAmount(currency, account.balances[currency])}`);
  }
  log(`block: ${account.blockNumber}`);
  log(`deployment check: ${account.deploymentOk ? "ok" : "DRIFT"}`);

  // 2. Server clock. Dry-run never talks to api.fiat24.com — the local clock stands in.
  let serverMs: bigint;
  let skewMs = 0n;
  if (options.dryRun) {
    serverMs = BigInt(Math.floor(deps.now()));
    log("dry-run: using the local clock as server time; nothing reaches api.fiat24.com");
  } else {
    const api = createFiat24Api({ fetch: wire, now: deps.now });
    serverMs = await api.timestamp();
    skewMs = serverMs - BigInt(Math.floor(deps.now()));
    if (skewMs > MAX_SKEW_MS || skewMs < -MAX_SKEW_MS) {
      throw new Error("server clock skew exceeds 300 s");
    }
  }
  // Every expiry decision runs on server time (local + skew): a fast server clock would otherwise
  // let the run send an already-expired grant and read the resulting 401 as "label rejected".
  const nowSeconds = (): bigint => BigInt(Math.floor((deps.now() + Number(skewMs)) / 1000));

  // 3. The grant: exact message, digest, expected device screens, deadline, residual risk.
  const grant = buildGrant({ tokenId: account.tokenId, serverMs, ttl: options.ttl });
  log(`session message: ${grant.message}`);
  log(`message SHA-256: ${sha256(stringToBytes(grant.message)).slice(2).toUpperCase()}`);
  for (const line of ledgerDisplay(grant.message)) {
    log(line);
  }
  log(
    `grant deadline: ${new Date(Number(grant.deadline) * 1000).toISOString()} (in ${grant.deadline - nowSeconds()} s)`,
  );
  log(
    "warning: until the deadline the signature is a bearer credential for the WHOLE account " +
      "(profile, card display tokens, card changes, payees via /verify, PUT /email) even though " +
      "this script only reads",
  );

  // 4. Dry-run: exercise the same SDK calls through the guard over a recording inner that throws
  // before anything could be sent. No signing, no report.
  if (options.dryRun) {
    const recorded: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const recorder = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const flat: Record<string, string> = {};
      for (const [key, value] of new Headers(init?.headers)) {
        flat[key] = value;
      }
      recorded.push({ method: init?.method ?? "", url: urlText(input), headers: flat });
      throw new Error("dry-run: not sent");
    }) as typeof fetch;
    const headers: SessionHeaders = {
      tokenid: account.tokenId.toString(),
      hash: grant.hash,
      deadline: grant.deadline.toString(),
      sign: "<signature from your Ledger - not created in dry-run>",
    };
    const session = createSecured({
      fetch: guardFetch(recorder, onRefuse),
      tokenId: account.tokenId,
      session: readOnlySession({ headers, deadline: grant.deadline, nowSeconds }),
    });
    for (const call of [
      async () => session.profile(),
      async () => session.cards(),
      async () => session.transactions({ currency: "ALL", recordsCount: 100n }),
    ]) {
      try {
        await call();
      } catch {
        // "dry-run: not sent" wrapped as network-error — expected; the request is printed below.
      }
    }
    session.end();
    for (const request of recorded) {
      log(`request: ${request.method} ${request.url} ${JSON.stringify(request.headers)}`);
    }
    if (refusals > 0) {
      throw new Error("the transport guard refused a request");
    }
    log("dry-run complete: nothing was sent, nothing was signed, no report was written");
    return;
  }

  // 5. Sign and issue the three secured GETs.
  const signature = await deps.sign({
    message: grant.message,
    deadline: grant.deadline,
    owner,
    nowSeconds,
  });
  await checkSignature({ message: grant.message, signature, owner });
  if (nowSeconds() >= grant.deadline - EXPIRY_MARGIN_SECONDS) {
    throw new Error("the grant expires within 15 s; refusing to use it");
  }
  const liveHeaders: SessionHeaders = {
    tokenid: account.tokenId.toString(),
    hash: grant.hash,
    deadline: grant.deadline.toString(),
    sign: signature,
  };
  const session = createSecured({
    fetch: wire,
    tokenId: account.tokenId,
    session: readOnlySession({ headers: liveHeaders, deadline: grant.deadline, nowSeconds }),
  });

  const endpoints: EndpointReport[] = [];
  const securedCalls: ReadonlyArray<{
    endpoint: string;
    pathname: string;
    schema: unknown;
    fixtureName: FixtureName;
    call: () => Promise<unknown>;
  }> = [
    {
      endpoint: "GET /br",
      pathname: "/br",
      schema: profileSchema,
      fixtureName: "br",
      call: async () => session.profile(),
    },
    {
      endpoint: "GET /cards",
      pathname: "/cards",
      schema: cardsSchema,
      fixtureName: "cards",
      call: async () => session.cards(),
    },
    {
      endpoint: "GET /transactions",
      pathname: "/transactions",
      schema: transactionsSchema,
      fixtureName: "transactions",
      call: async () => session.transactions({ currency: "ALL", recordsCount: 100n }),
    },
  ];

  const reportEntry = (
    endpoint: string,
    pathname: string,
    schema: unknown,
    fixtureName: FixtureName,
    outcome: string,
  ): EndpointReport => {
    const cap = captured.get(pathname);
    const body = tryJson(cap?.text);
    const shape: ShapeProfile | undefined =
      body === undefined ? undefined : describeShape(body, knownKeys);
    const fixtureBody = deps.fixture(fixtureName);
    return {
      endpoint,
      sent: cap !== undefined,
      ...(cap === undefined ? {} : { httpStatus: cap.status, contentType: cap.contentType }),
      outcome,
      ...(shape === undefined ? {} : { shape }),
      schemaDiff: shape === undefined ? [] : diffShape(schemaShape(schema), shape),
      fixtureDiff:
        fixtureBody === undefined || shape === undefined
          ? []
          : diffShape(profileAsExpected(describeShape(fixtureBody, knownKeys)), shape),
      ...(fixtureBody === undefined ? { fixtureNote: "no fixture recorded — diff skipped" } : {}),
    };
  };

  // The public-vocabulary key set for shape redaction is built from the fixtures themselves.
  const knownKeys = new Set<string>();
  for (const name of ["br", "cards", "transactions", "timestamp"] as const) {
    collectKeys(deps.fixture(name), knownKeys);
  }

  endpoints.push(reportEntry("GET /timestamp", "/timestamp", timestampSchema, "timestamp", "ok"));
  let anySecured2xx = false;
  try {
    for (const call of securedCalls) {
      let outcome = "ok";
      try {
        await call.call();
      } catch (error) {
        outcome = outcomeOf(error);
      }
      const cap = captured.get(call.pathname);
      if (cap !== undefined && cap.status >= 200 && cap.status < 300) {
        anySecured2xx = true;
      }
      endpoints.push(
        reportEntry(call.endpoint, call.pathname, call.schema, call.fixtureName, outcome),
      );
    }
  } finally {
    session.end();
    const left = grant.deadline - nowSeconds();
    log(
      `bearer window closes at ${new Date(Number(grant.deadline) * 1000).toISOString()} (in ${left > 0n ? left : 0n} s)`,
    );
    log(
      "session ended; the grant and signature lived in memory only — nothing was written to disk",
    );
  }
  if (refusals > 0) {
    throw new Error("the transport guard refused a request — aborting");
  }

  // 6. Payout refs (O-3/O-9): candidate txIds from the captured /transactions body, receipts,
  // ClientPayoutRef decoding, ref classification — counts only.
  const candidates = collectTxIds(tryJson(captured.get("/transactions")?.text), account.tokenId);
  const logsPerTx = candidates.length > 0 ? await deps.logsOf(candidates) : [];
  const refCounts = {
    prefixedPadded45: 0,
    prefixedUnpadded: 0,
    invalid: 0,
    payoutNoRef: 0,
    unreadableReceipts: 0,
  };
  for (const logs of logsPerTx) {
    if (logs === undefined) {
      refCounts.unreadableReceipts += 1;
      continue;
    }
    let events: ReturnType<typeof decodeFiat24Logs>;
    try {
      events = decodeFiat24Logs(logs);
    } catch {
      refCounts.unreadableReceipts += 1;
      continue;
    }
    for (const event of events) {
      if (event.kind === "payout-ref" && event.tokenId === account.tokenId) {
        if (!isValidPayoutRef(event.ref, account.tokenId)) {
          refCounts.invalid += 1;
        } else if (event.ref.includes("\u0000")) {
          refCounts.prefixedPadded45 += 1;
        } else {
          refCounts.prefixedUnpadded += 1;
        }
      } else if (event.kind === "payout" && event.tokenId === account.tokenId) {
        refCounts.payoutNoRef += 1;
      }
    }
  }
  const payoutRefs: PayoutRefSummary = { candidates: candidates.length, ...refCounts };

  // 7. Report.
  const firstSecuredStatus = captured.get("/br")?.status;
  const o1 =
    firstSecuredStatus === 401
      ? { answer: "no" as const }
      : anySecured2xx
        ? { answer: "yes" as const }
        : {
            answer: "inconclusive" as const,
            why:
              firstSecuredStatus === undefined
                ? "no secured response received"
                : `first secured GET returned HTTP ${firstSecuredStatus}`,
          };
  const cardsBody = tryJson(captured.get("/cards")?.text);
  const statusCode = isRecord(cardsBody) ? cardsBody["statusCode"] : undefined;
  const cardsCapture = captured.get("/cards");
  const data: ReportData = {
    generatedAt: new Date(deps.now()).toISOString(),
    ttlSeconds: options.ttl,
    signerMode: options.signerMode,
    dryRun: false,
    account: {
      status: account.status,
      tokenIdDigits: String(account.tokenId).length,
      deploymentOk: account.deploymentOk,
    },
    skew: {
      sign: skewMs < 0n ? ("-" as const) : ("+" as const),
      bucket: skewBucket(skewMs < 0n ? -skewMs : skewMs),
    },
    o1,
    cardsBody: {
      ...(cardsCapture === undefined ? {} : { httpStatus: cardsCapture.status }),
      statusCodeClass:
        statusCode === 200
          ? "200"
          : statusCode === 404
            ? "404"
            : statusCode === undefined
              ? "none"
              : "other",
    },
    payoutRefs,
    endpoints,
  };
  await deps.writeReport(options.out, renderReport(data));
  log(`report written to ${options.out} (mode 0600) — read it in full before sharing`);
}

const USAGE = `Usage: bun scripts/live-verify.ts (--owner 0x… | --token-id N) --rpc <url> [options]

Read-only live verification of a Fiat24 account. Exactly one of --owner/--token-id.

Options:
  --owner <0x…>        resolve the account NFT by owner address
  --token-id <N>       account token id
  --rpc <url>          Arbitrum One RPC (or env FIAT24_RPC) — required
  --signer cast|paste  signature source (default: cast, needs Foundry + Ledger)
  --hd-path <m/…>      Ledger derivation path (legacy style; exclusive with --account-index)
  --account-index <N>  Ledger Live account index -> m/44'/60'/N'/0/0 (default 0)
  --ttl <60-600>       grant lifetime in seconds (default 180)
  --out <path>         report file (default live-verify-report.md)
  --dry-run            exercise everything without contacting api.fiat24.com or signing
  --help               this text
`;

export const fixtureBody = (name: FixtureName): unknown => {
  const file =
    name === "timestamp"
      ? "public/timestamp.json"
      : `secured/${name === "cards" ? "cards-ok" : name}.json`;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../packages/fiat24/tests/fixtures/api", file),
        "utf8",
      ),
    );
    return name === "timestamp" ? parsed : isRecord(parsed) ? parsed["body"] : undefined;
  } catch {
    return undefined;
  }
};

const fail = (message: string): never => {
  throw new Error(message);
};

const print = (line: string): void => {
  console.log(line);
};

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      owner: { type: "string" },
      "token-id": { type: "string" },
      rpc: { type: "string" },
      signer: { type: "string", default: "cast" },
      "hd-path": { type: "string" },
      "account-index": { type: "string" },
      ttl: { type: "string", default: "180" },
      out: { type: "string", default: "live-verify-report.md" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const main = async (): Promise<void> => {
    if (values.help) {
      console.log(USAGE);
      return;
    }
    const hasOwner = values.owner !== undefined;
    const hasTokenId = values["token-id"] !== undefined;
    if (hasOwner === hasTokenId) {
      console.log(USAGE);
      fail("exactly one of --owner and --token-id is required");
    }
    const rpc = values.rpc ?? process.env["FIAT24_RPC"];
    if (rpc === undefined || rpc === "") {
      fail("--rpc <url> or FIAT24_RPC is required");
    }
    if (values.signer !== "cast" && values.signer !== "paste") {
      fail("--signer must be cast or paste");
    }
    const signerMode = values.signer === "paste" ? ("paste" as const) : ("cast" as const);
    const tokenIdText = values["token-id"];
    if (tokenIdText !== undefined && !/^[1-9][0-9]{0,77}$/.test(tokenIdText)) {
      fail("--token-id must be a positive decimal");
    }
    if (!/^[0-9]{2,3}$/.test(values.ttl)) {
      fail("--ttl must be 60..600");
    }
    const ttl = Number(values.ttl);
    if (ttl < 60 || ttl > 600) {
      fail("--ttl must be 60..600");
    }
    const indexText = values["account-index"];
    if (indexText !== undefined && !/^[0-9]{1,10}$/.test(indexText)) {
      fail("invalid --account-index");
    }
    const accountIndex = indexText === undefined ? undefined : Number(indexText);
    const path = ledgerPath({ hdPath: values["hd-path"], accountIndex });
    const client = createPublicClient({ chain: arbitrum, transport: http(rpc) });
    if ((await client.getChainId()) !== CHAIN_ID) {
      fail("the RPC is not Arbitrum One (chain id 42161)");
    }
    const target: RunTarget = hasOwner
      ? { owner: values.owner as Address }
      : { tokenId: BigInt(tokenIdText as string) };
    if ("owner" in target && !isAddress(target.owner)) {
      fail("--owner must be a 0x address");
    }
    await run(
      {
        target,
        ttl: BigInt(ttl),
        signerMode,
        dryRun: values["dry-run"],
        out: values.out,
      },
      {
        fetch: globalThis.fetch.bind(globalThis),
        load: async (t) => {
          const account = await getAccount(client, t);
          if (account === undefined) {
            return undefined;
          }
          const [balances, check] = await Promise.all([
            getBalances(client, { owner: account.owner }),
            verifyDeployment(client, {}),
          ]);
          return {
            tokenId: account.tokenId,
            owner: account.owner,
            ownsToken: account.ownsToken,
            status: account.status,
            limit: account.limit,
            balances: balances.balances,
            blockNumber: account.blockNumber,
            deploymentOk: check.ok,
          };
        },
        logsOf: async (hashes) =>
          Promise.all(
            hashes.map(async (hash) => {
              try {
                const receipt = await getTransactionReceipt(client, { hash });
                return receipt.logs;
              } catch {
                return undefined;
              }
            }),
          ),
        sign: async ({ message, deadline, owner, nowSeconds }) =>
          signerMode === "cast"
            ? castSign({ path, message, deadline, nowSeconds, owner, log: print })
            : pasteSign({ message, deadline, nowSeconds, log: print }),
        now: () => Date.now(),
        log: print,
        writeReport: (out, text) => {
          writeFileSync(out, text, { mode: 0o600 });
        },
        fixture: fixtureBody,
      },
    );
  };

  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "live-verify failed");
    process.exitCode = 1;
  }
}
